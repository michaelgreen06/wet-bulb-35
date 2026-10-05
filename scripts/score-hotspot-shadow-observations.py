#!/usr/bin/env python3
"""Fetch NOAA GHCNh observations and score station forecast captures."""

import argparse
import csv
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import time
from typing import Any
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SHARED_PATH = ROOT / "scripts" / "generate-ecmwf-hotspot-candidates.py"
SHARED_SPEC = importlib.util.spec_from_file_location("hotspot_grid_shared_for_scoring", SHARED_PATH)
assert SHARED_SPEC and SHARED_SPEC.loader
SHARED = importlib.util.module_from_spec(SHARED_SPEC)
SHARED_SPEC.loader.exec_module(SHARED)

SCHEMA_VERSION = 1
KIND = "direct-model-station-observation-score"
DEFAULT_BASE_URL = "https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/access/by-year"
STATION_ID_PATTERN = re.compile(r"^[A-Z0-9-]{6,20}$")
VARIABLE_FIELDS = {
    "temperatureC": "temperature",
    "dewPointC": "dew_point_temperature",
    "pressurePa": "station_level_pressure",
}


def parse_utc(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    if parsed.utcoffset() != dt.timedelta(0):
        raise ValueError("timestamps must be UTC")
    return parsed.astimezone(dt.timezone.utc)


def iso_utc(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def ensure_score_eligible(*, window_end: str, now: str, minimum_delay_hours: float) -> None:
    if minimum_delay_hours < 0 or not math.isfinite(minimum_delay_hours):
        raise ValueError("minimum observation delay must be nonnegative and finite")
    eligible_at = parse_utc(window_end) + dt.timedelta(hours=minimum_delay_hours)
    if parse_utc(now) < eligible_at:
        raise ValueError(f"observation availability delay has not elapsed; eligible at {iso_utc(eligible_at)}")


def score_status(*, window_end: str, now: str, finalize_after_hours: float) -> str:
    if finalize_after_hours < 0 or not math.isfinite(finalize_after_hours):
        raise ValueError("finalization delay must be nonnegative and finite")
    return "final" if parse_utc(now) >= parse_utc(window_end) + dt.timedelta(hours=finalize_after_hours) else "provisional"


def quality_code_accepted(value: str | None) -> bool:
    return (value or "").strip() in {"", "1", "5"}


def parse_number(value: str | None) -> float | None:
    if value is None or not value.strip():
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def ghcnh_required_columns() -> set[str]:
    required = {"STATION", "DATE"}
    for source in VARIABLE_FIELDS.values():
        required.update({source, f"{source}_Quality_Code", f"{source}_Source_Code", f"{source}_Measurement_Code"})
    required.update({"wet_bulb_temperature", "wet_bulb_temperature_Quality_Code", "wet_bulb_temperature_Measurement_Code"})
    return required


def validate_ghcnh_psv_file(path: Path, station_id: str) -> None:
    if not path.is_file() or path.stat().st_size < 100:
        raise ValueError("GHCNh file is missing or implausibly small")
    with path.open(newline="", encoding="utf-8-sig") as stream:
        reader = csv.DictReader(stream, delimiter="|")
        if reader.fieldnames is None or not ghcnh_required_columns().issubset(reader.fieldnames):
            raise ValueError("GHCNh file is missing required columns")
        first = next(reader, None)
        if first is None or first.get("STATION", "").strip() != station_id:
            raise ValueError("GHCNh file does not contain the requested station")
        parse_utc(first["DATE"].strip())


def parse_ghcnh_psv(path: Path, station_id: str, window_start: str, window_end: str) -> list[dict[str, Any]]:
    start = parse_utc(window_start) - dt.timedelta(minutes=30)
    end = parse_utc(window_end) + dt.timedelta(minutes=30)
    records: list[dict[str, Any]] = []
    with path.open(newline="", encoding="utf-8-sig") as stream:
        reader = csv.DictReader(stream, delimiter="|")
        if reader.fieldnames is None or not ghcnh_required_columns().issubset(reader.fieldnames):
            raise ValueError(f"GHCNh file is missing required columns: {path}")
        for row in reader:
            if row["STATION"].strip() != station_id:
                continue
            try:
                timestamp = parse_utc(row["DATE"].strip())
            except ValueError:
                continue
            if timestamp < start or timestamp > end:
                continue
            temperature = parse_number(row["temperature"])
            dew_point = parse_number(row["dew_point_temperature"])
            pressure_hpa = parse_number(row["station_level_pressure"])
            pressure_pa = pressure_hpa * 100.0 if pressure_hpa is not None else None
            values = {
                "temperatureC": temperature,
                "dewPointC": dew_point,
                "pressurePa": pressure_pa,
            }
            accepted = {
                target: quality_code_accepted(row[f"{source}_Quality_Code"])
                for target, source in VARIABLE_FIELDS.items()
            }
            if temperature is not None and not -100 <= temperature <= 70:
                values["temperatureC"], accepted["temperatureC"] = None, False
            if dew_point is not None and not -110 <= dew_point <= 70:
                values["dewPointC"], accepted["dewPointC"] = None, False
            if pressure_pa is not None and not 45000 <= pressure_pa <= 110000:
                values["pressurePa"], accepted["pressurePa"] = None, False
            records.append({
                "date": iso_utc(timestamp),
                **values,
                "qualityAccepted": all(accepted.values()),
                "qualityAcceptedByField": accepted,
                "quality": {
                    target: {
                        "code": row[f"{source}_Quality_Code"].strip(),
                        "sourceCode": row[f"{source}_Source_Code"].strip(),
                        "measurementCode": row[f"{source}_Measurement_Code"].strip(),
                    }
                    for target, source in VARIABLE_FIELDS.items()
                },
                "reportedWetBulbC": parse_number(row["wet_bulb_temperature"]),
                "reportedWetBulbQualityCode": row["wet_bulb_temperature_Quality_Code"].strip(),
                "reportedWetBulbMeasurementCode": row["wet_bulb_temperature_Measurement_Code"].strip(),
            })
    return sorted(records, key=lambda item: item["date"])


def match_observation(records: list[dict[str, Any]], valid_time: str, tolerance_minutes: int = 30) -> dict[str, Any] | None:
    target = parse_utc(valid_time)
    candidates = []
    for record in records:
        difference = abs((parse_utc(record["date"]) - target).total_seconds())
        if difference <= tolerance_minutes * 60:
            candidates.append((difference, record["date"], record))
    return min(candidates, key=lambda item: (item[0], item[1]))[2] if candidates else None


def match_observations_to_hours(
    records: list[dict[str, Any]], valid_times: list[str], tolerance_minutes: int = 30
) -> dict[str, dict[str, Any] | None]:
    """Match reports one-to-one so one observation cannot score adjacent hours."""
    consumed: set[int] = set()
    matches: dict[str, dict[str, Any] | None] = {}
    for valid_time in sorted(valid_times):
        target = parse_utc(valid_time)
        candidates = []
        for index, record in enumerate(records):
            if index in consumed:
                continue
            difference = abs((parse_utc(record["date"]) - target).total_seconds())
            if difference <= tolerance_minutes * 60:
                candidates.append((difference, record["date"], index, record))
        if not candidates:
            matches[valid_time] = None
            continue
        _, _, index, record = min(candidates, key=lambda item: (item[0], item[1], item[2]))
        consumed.add(index)
        matches[valid_time] = record
    return matches


def metric_summary(errors: list[float]) -> dict[str, Any]:
    if not errors:
        return {"count": 0, "meanError": None, "meanAbsoluteError": None, "rootMeanSquareError": None}
    return {
        "count": len(errors),
        "meanError": sum(errors) / len(errors),
        "meanAbsoluteError": sum(abs(value) for value in errors) / len(errors),
        "rootMeanSquareError": math.sqrt(sum(value * value for value in errors) / len(errors)),
    }


def _field_accepted(observation: dict[str, Any], field: str) -> bool:
    if "qualityAcceptedByField" in observation:
        return bool(observation["qualityAcceptedByField"].get(field))
    return bool(observation.get("qualityAccepted", True))


def _observed_wet_bulb(observation: dict[str, Any]) -> float | None:
    if not all(observation.get(field) is not None and _field_accepted(observation, field) for field in VARIABLE_FIELDS):
        return None
    return SHARED.wet_bulb_celsius(
        float(observation["pressurePa"]),
        float(observation["temperatureC"]) + 273.15,
        float(observation["dewPointC"]) + 273.15,
    )


def _lead_bin(initialization: str, valid_time: str) -> str:
    lead = int((parse_utc(valid_time) - parse_utc(initialization)).total_seconds() // 3600)
    if lead <= 6:
        return "0-6"
    if lead <= 12:
        return "7-12"
    if lead <= 18:
        return "13-18"
    return "19+"


def score_capture(capture: dict[str, Any], observations: dict[str, list[dict[str, Any]]], *, retrieved_at: str) -> dict[str, Any]:
    errors = {model: {field: [] for field in (*VARIABLE_FIELDS, "wetBulbC")} for model in ("ifs", "gfs")}
    partition_errors = {
        group: {model: [] for model in ("ifs", "gfs")}
        for group in ("fixed", "dynamic")
    }
    lead_errors = {model: {label: [] for label in ("0-6", "7-12", "13-18", "19+")} for model in ("ifs", "gfs")}
    threshold_stats = {
        model: {str(value): {"observedEvents": 0, "misses": 0, "falseAlarms": 0} for value in (27, 30, 35)}
        for model in ("ifs", "gfs")
    }
    paired_wet_bulb: list[tuple[float, float]] = []
    station_scores = []
    matched = 0
    wet_bulb_scored = 0
    stations_with_observations = 0
    observed_peak: dict[str, Any] | None = None

    for station in capture["stations"]:
        station_records = observations.get(station["stationId"], [])
        if station_records:
            stations_with_observations += 1
        station_errors = {model: {field: [] for field in (*VARIABLE_FIELDS, "wetBulbC")} for model in ("ifs", "gfs")}
        by_model_time = {
            model: {hour["validTime"]: hour for hour in station["forecasts"][model]["hours"]}
            for model in ("ifs", "gfs")
        }
        observation_matches = match_observations_to_hours(station_records, sorted(by_model_time["ifs"]))
        for valid_time in sorted(by_model_time["ifs"]):
            observation = observation_matches[valid_time]
            if observation is None:
                continue
            matched += 1
            observed_wet_bulb = _observed_wet_bulb(observation)
            if observed_wet_bulb is not None:
                wet_bulb_scored += 1
                if observed_peak is None or observed_wet_bulb > observed_peak["wetBulbC"]:
                    observed_peak = {"stationId": station["stationId"], "validTime": valid_time, "wetBulbC": observed_wet_bulb}
            pair_errors = {}
            for model in ("ifs", "gfs"):
                forecast = by_model_time[model].get(valid_time)
                if forecast is None:
                    raise ValueError("capture models must use identical valid times")
                for field in VARIABLE_FIELDS:
                    observed = observation.get(field)
                    if observed is None or not _field_accepted(observation, field):
                        continue
                    error = float(forecast[field]) - float(observed)
                    errors[model][field].append(error)
                    station_errors[model][field].append(error)
                if observed_wet_bulb is not None:
                    error = float(forecast["wetBulbC"]) - observed_wet_bulb
                    errors[model]["wetBulbC"].append(error)
                    station_errors[model]["wetBulbC"].append(error)
                    pair_errors[model] = error
                    for group in station["selection"]["groups"]:
                        if group in partition_errors:
                            partition_errors[group][model].append(error)
                    lead_errors[model][_lead_bin(capture["models"][model]["initialization"], valid_time)].append(error)
                    for threshold in (27, 30, 35):
                        stats = threshold_stats[model][str(threshold)]
                        observed_event = observed_wet_bulb >= threshold
                        forecast_event = float(forecast["wetBulbC"]) >= threshold
                        stats["observedEvents"] += int(observed_event)
                        stats["misses"] += int(observed_event and not forecast_event)
                        stats["falseAlarms"] += int(forecast_event and not observed_event)
            if set(pair_errors) == {"ifs", "gfs"}:
                paired_wet_bulb.append((abs(pair_errors["ifs"]), abs(pair_errors["gfs"])))
        station_scores.append({
            "stationId": station["stationId"],
            "groups": station["selection"]["groups"],
            "models": {
                model: {field: metric_summary(values) for field, values in station_errors[model].items()}
                for model in ("ifs", "gfs")
            },
        })

    model_summaries = {
        model: {field: metric_summary(values) for field, values in errors[model].items()}
        for model in ("ifs", "gfs")
    }
    ifs_mae = model_summaries["ifs"]["wetBulbC"]["meanAbsoluteError"]
    gfs_mae = model_summaries["gfs"]["wetBulbC"]["meanAbsoluteError"]
    pairwise = {
        "pairedCount": len(paired_wet_bulb),
        "ifsMinusGfsWetBulbMaeC": None if ifs_mae is None or gfs_mae is None else ifs_mae - gfs_mae,
        "ifsBetterCount": sum(left < right for left, right in paired_wet_bulb),
        "gfsBetterCount": sum(right < left for left, right in paired_wet_bulb),
        "ties": sum(left == right for left, right in paired_wet_bulb),
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "kind": KIND,
        "retrievedAt": retrieved_at,
        "window": capture["window"],
        "observationSource": {
            "name": "NOAA GHCNh",
            "matchingToleranceMinutes": 30,
            "stationPressureRequiredForWetBulb": True,
            "qualityPolicy": "accept-blank-or-codes-1-and-5-per-field",
        },
        "availability": {
            "stationsRequested": len(capture["stations"]),
            "stationsWithObservations": stations_with_observations,
            "hourlyPairsPossible": len(capture["stations"]) * int(capture["window"]["hourCount"]),
            "hourlyPairsMatched": matched,
            "hourlyPairsScoredWetBulb": wet_bulb_scored,
        },
        "stationScores": station_scores,
        "summaries": {
            **model_summaries,
            "ifsVsGfs": pairwise,
            "fixed": {model: metric_summary(partition_errors["fixed"][model]) for model in ("ifs", "gfs")},
            "dynamic": {model: metric_summary(partition_errors["dynamic"][model]) for model in ("ifs", "gfs")},
            "byLeadHourBin": {
                model: {label: metric_summary(values) for label, values in lead_errors[model].items()}
                for model in ("ifs", "gfs")
            },
            "thresholds": threshold_stats,
            "observedPeak": observed_peak,
        },
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def fetch_station_year(*, station_id: str, year: int, cache_dir: Path, base_url: str) -> tuple[Path, dict[str, Any]]:
    if not STATION_ID_PATTERN.fullmatch(station_id):
        raise ValueError("invalid GHCNh station identifier")
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"GHCNh_{station_id}_{year}.psv"
    metadata_path = path.with_suffix(".http.json")
    try:
        metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
    except (OSError, ValueError):
        metadata = {}
        metadata_path.unlink(missing_ok=True)
    if path.exists():
        try:
            validate_ghcnh_psv_file(path, station_id)
        except (OSError, ValueError):
            path.unlink(missing_ok=True)
            metadata_path.unlink(missing_ok=True)
            metadata = {}
    url = f"{base_url.rstrip('/')}/{year}/psv/GHCNh_{station_id}_{year}.psv"
    headers = {"User-Agent": "WetBulb35-model-verification/1.0"}
    if path.exists() and metadata.get("etag"):
        headers["If-None-Match"] = metadata["etag"]
    if path.exists() and metadata.get("lastModified"):
        headers["If-Modified-Since"] = metadata["lastModified"]
    request = urllib.request.Request(url, headers=headers)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
                with temporary.open("wb") as stream:
                    while chunk := response.read(1024 * 1024):
                        stream.write(chunk)
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    validate_ghcnh_psv_file(temporary, station_id)
                    os.replace(temporary, path)
                finally:
                    temporary.unlink(missing_ok=True)
                metadata = {
                    "url": url,
                    "retrievedAt": iso_utc(dt.datetime.now(dt.timezone.utc)),
                    "etag": response.headers.get("ETag"),
                    "lastModified": response.headers.get("Last-Modified"),
                    "sha256": sha256_file(path),
                }
                atomic_write_json(metadata_path, metadata)
                break
        except urllib.error.HTTPError as error:
            if error.code == 304 and path.exists():
                validate_ghcnh_psv_file(path, station_id)
                break
            if error.code < 500 or attempt == 2:
                raise
            time.sleep(2 ** attempt)
        except (TimeoutError, urllib.error.URLError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)
    return path, metadata


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", required=True, type=Path)
    parser.add_argument("--observations-output", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--minimum-delay-hours", type=float, default=36.0)
    parser.add_argument("--finalize-after-hours", type=float, default=120.0)
    parser.add_argument("--now")
    args = parser.parse_args()

    capture = json.loads(args.capture.read_text(encoding="utf-8"))
    now = args.now or iso_utc(dt.datetime.now(dt.timezone.utc))
    ensure_score_eligible(window_end=capture["window"]["end"], now=now, minimum_delay_hours=args.minimum_delay_hours)
    years = range(parse_utc(capture["window"]["start"]).year, parse_utc(capture["window"]["end"]).year + 1)
    observations: dict[str, list[dict[str, Any]]] = {}
    source_files = []
    source_errors = []
    for station in capture["stations"]:
        station_id = station["stationId"]
        records = []
        for year in years:
            try:
                path, metadata = fetch_station_year(
                    station_id=station_id,
                    year=year,
                    cache_dir=args.cache_dir / str(year),
                    base_url=args.base_url,
                )
            except urllib.error.HTTPError as error:
                source_errors.append({
                    "stationId": station_id,
                    "year": year,
                    "error": f"HTTP{error.code}",
                    "retryable": error.code != 404,
                })
                continue
            except (OSError, ValueError, urllib.error.URLError) as error:
                source_errors.append({"stationId": station_id, "year": year, "error": type(error).__name__, "retryable": True})
                continue
            records.extend(parse_ghcnh_psv(path, station_id, capture["window"]["start"], capture["window"]["end"]))
            source_files.append({"stationId": station_id, "year": year, **metadata})
        observations[station_id] = sorted(records, key=lambda item: item["date"])
    observation_document = {
        "schemaVersion": 1,
        "kind": "noaa-ghcnh-selected-observations",
        "retrievedAt": now,
        "window": capture["window"],
        "sourceFiles": source_files,
        "sourceErrors": source_errors,
        "stations": observations,
    }
    atomic_write_json(args.observations_output, observation_document)
    score = score_capture(capture, observations, retrieved_at=now)
    retryable_source_errors = sum(bool(error["retryable"]) for error in source_errors)
    intended_status = score_status(
        window_end=capture["window"]["end"],
        now=now,
        finalize_after_hours=args.finalize_after_hours,
    )
    score["status"] = (
        "final"
        if intended_status == "final" and retryable_source_errors == 0 and score["availability"]["hourlyPairsScoredWetBulb"] > 0
        else "provisional"
    )
    score["finalizeAfterHours"] = args.finalize_after_hours
    score["sourceErrorCount"] = len(source_errors)
    score["retryableSourceErrorCount"] = retryable_source_errors
    score["capture"] = {"path": str(args.capture), "sha256": sha256_file(args.capture)}
    score["observations"] = {"path": str(args.observations_output), "sha256": sha256_file(args.observations_output)}
    atomic_write_json(args.output, score)
    print(json.dumps({
        "status": score["status"],
        "stationsRequested": score["availability"]["stationsRequested"],
        "stationsWithObservations": score["availability"]["stationsWithObservations"],
        "hourlyPairsScoredWetBulb": score["availability"]["hourlyPairsScoredWetBulb"],
        "sourceErrorCount": len(source_errors),
        "retryableSourceErrorCount": retryable_source_errors,
        "ifsWetBulbMaeC": score["summaries"]["ifs"]["wetBulbC"]["meanAbsoluteError"],
        "gfsWetBulbMaeC": score["summaries"]["gfs"]["wetBulbC"]["meanAbsoluteError"],
        "output": str(args.output),
    }))


if __name__ == "__main__":
    main()
