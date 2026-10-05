#!/usr/bin/env python3
"""Capture matched IFS/GFS forecasts at NOAA observation stations."""

import argparse
import csv
import datetime as dt
import importlib.util
import json
import math
import os
from pathlib import Path
import re
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SHARED_PATH = ROOT / "scripts" / "generate-ecmwf-hotspot-candidates.py"
SHARED_SPEC = importlib.util.spec_from_file_location("hotspot_grid_shared", SHARED_PATH)
assert SHARED_SPEC and SHARED_SPEC.loader
SHARED = importlib.util.module_from_spec(SHARED_SPEC)
SHARED_SPEC.loader.exec_module(SHARED)

SCHEMA_VERSION = 1
KIND = "direct-model-station-forecast-capture"
METHOD = "romps-thermodynamic-liquid"
METHOD_VERSION = "2026-heatindex-0.0.2"
STATION_ID_PATTERN = re.compile(r"^[A-Z0-9-]{6,20}$")


def parse_utc(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() != dt.timedelta(0):
        raise ValueError("timestamps must be UTC ISO-8601 values")
    return parsed.astimezone(dt.timezone.utc)


def iso_utc(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def normalized_longitude(value: float) -> float:
    return ((float(value) + 180.0) % 360.0) - 180.0


def haversine_km(latitude_a: float, longitude_a: float, latitude_b: float, longitude_b: float) -> float:
    radius_km = 6371.0088
    lat_a, lat_b = math.radians(latitude_a), math.radians(latitude_b)
    delta_lat = lat_b - lat_a
    delta_lon = math.radians(normalized_longitude(longitude_b - longitude_a))
    haversine = math.sin(delta_lat / 2) ** 2 + math.cos(lat_a) * math.cos(lat_b) * math.sin(delta_lon / 2) ** 2
    return 2 * radius_km * math.asin(min(1.0, math.sqrt(haversine)))


def load_station_catalog(path: Path) -> list[dict[str, Any]]:
    stations: list[dict[str, Any]] = []
    with path.open(newline="", encoding="utf-8-sig") as stream:
        reader = csv.DictReader(stream)
        required = {"GHCN_ID", "LATITUDE", "LONGITUDE", "ELEVATION", "NAME", "WMO_ID", "ICAO"}
        if reader.fieldnames is None or not required.issubset(reader.fieldnames):
            raise ValueError("GHCNh station catalog is missing required columns")
        for row in reader:
            try:
                latitude = float(row["LATITUDE"])
                longitude = float(row["LONGITUDE"])
                elevation = float(row["ELEVATION"])
            except (TypeError, ValueError):
                continue
            station_id = row["GHCN_ID"].strip()
            if not STATION_ID_PATTERN.fullmatch(station_id) or not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
                continue
            stations.append({
                "stationId": station_id,
                "name": row["NAME"].strip(),
                "latitude": latitude,
                "longitude": longitude,
                "elevationM": elevation,
                "wmoId": row["WMO_ID"].strip(),
                "icao": row["ICAO"].strip(),
            })
    if not stations:
        raise ValueError("GHCNh station catalog contains no usable stations")
    return stations


def select_station_panel(
    *,
    station_catalog: list[dict[str, Any]],
    fixed_station_ids: list[str],
    ifs_cells: list[dict[str, Any]],
    gfs_cells: list[dict[str, Any]],
    max_dynamic_stations: int,
    max_station_distance_km: float,
) -> list[dict[str, Any]]:
    if max_dynamic_stations < 0 or not math.isfinite(max_station_distance_km) or max_station_distance_km <= 0:
        raise ValueError("dynamic station limits must be valid")
    by_id = {str(station["stationId"]): station for station in station_catalog}
    if len(by_id) != len(station_catalog):
        raise ValueError("station catalog IDs must be unique")

    selected: dict[str, dict[str, Any]] = {}
    fixed_order: list[str] = []
    for station_id in fixed_station_ids:
        if station_id not in by_id:
            raise ValueError(f"fixed station is missing from catalog: {station_id}")
        if station_id in selected:
            raise ValueError(f"fixed station is duplicated: {station_id}")
        station = by_id[station_id]
        selected[station_id] = {
            **{key: station[key] for key in ("stationId", "name", "latitude", "longitude", "elevationM")},
            "selection": {"groups": ["fixed"], "hotspotSources": []},
        }
        fixed_order.append(station_id)

    eligible_dynamic = [
        station for station in station_catalog
        if station.get("icao") or station.get("wmoId") or set(station) == {"stationId", "name", "latitude", "longitude", "elevationM"}
    ]
    targets: list[tuple[int, str, dict[str, Any]]] = []
    for model, cells in (("ifs", ifs_cells), ("gfs", gfs_cells)):
        for rank, cell in enumerate(cells, start=1):
            targets.append((rank, model, cell))
    targets.sort(key=lambda item: (item[0], item[1]))

    dynamic_ids: list[str] = []
    for rank, model, cell in targets:
        if len(dynamic_ids) >= max_dynamic_stations:
            break
        latitude = float(cell["latitude"])
        longitude = normalized_longitude(float(cell["longitude"]))
        candidates = []
        for station in eligible_dynamic:
            distance = haversine_km(latitude, longitude, float(station["latitude"]), float(station["longitude"]))
            if distance <= max_station_distance_km:
                candidates.append((distance, str(station["stationId"]), station))
        if not candidates:
            continue
        distance, station_id, station = min(candidates, key=lambda item: (item[0], item[1]))
        source = {
            "model": model,
            "rank": rank,
            "targetLatitude": latitude,
            "targetLongitude": longitude,
            "targetWetBulbC": float(cell["wetBulbC"]),
            "stationDistanceKm": round(distance, 3),
        }
        if station_id not in selected:
            selected[station_id] = {
                **{key: station[key] for key in ("stationId", "name", "latitude", "longitude", "elevationM")},
                "selection": {"groups": ["dynamic"], "hotspotSources": [source]},
            }
            dynamic_ids.append(station_id)
        else:
            groups = selected[station_id]["selection"]["groups"]
            if "dynamic" not in groups:
                groups.append("dynamic")
            selected[station_id]["selection"]["hotspotSources"].append(source)
            if station_id not in fixed_order and station_id not in dynamic_ids:
                dynamic_ids.append(station_id)

    return [selected[station_id] for station_id in fixed_order + sorted(dynamic_ids)]


def _ordered_hours(steps: dict[int, dict[str, Any]], window_start: str, window_end: str) -> list[dict[str, Any]]:
    start, end = parse_utc(window_start), parse_utc(window_end)
    expected_times = [iso_utc(start + dt.timedelta(hours=offset)) for offset in range(24)]
    if expected_times[-1] != iso_utc(end):
        raise ValueError("capture window must contain exactly 24 inclusive hourly timestamps")
    by_time = {fields["valid_time"]: fields for fields in steps.values()}
    if sorted(by_time) != sorted(expected_times):
        raise ValueError("models must contain exactly 24 shared hourly valid times")
    return [by_time[value] for value in expected_times]


def _sample_model(
    station: dict[str, Any],
    axes: tuple[np.ndarray, np.ndarray],
    ordered_fields: list[dict[str, Any]],
) -> dict[str, Any]:
    latitudes, longitudes = axes
    row, column = SHARED.nearest_grid_cell(latitudes, longitudes, station["latitude"], station["longitude"])
    hours = []
    for fields in ordered_fields:
        temperature_k = float(np.asarray(fields["temperature_k"])[row, column])
        dew_point_k = float(np.asarray(fields["dew_point_k"])[row, column])
        pressure_pa = float(np.asarray(fields["pressure_pa"])[row, column])
        wet_bulb_c = SHARED.wet_bulb_celsius(pressure_pa, temperature_k, dew_point_k)
        values = (temperature_k, dew_point_k, pressure_pa, wet_bulb_c)
        if not all(math.isfinite(value) for value in values):
            raise ValueError("sampled station forecast values must be finite")
        hours.append({
            "validTime": fields["valid_time"],
            "temperatureC": temperature_k - 273.15,
            "dewPointC": dew_point_k - 273.15,
            "pressurePa": pressure_pa,
            "wetBulbC": wet_bulb_c,
        })
    return {
        "gridCell": {
            "latitude": float(latitudes[row]),
            "longitude": normalized_longitude(float(longitudes[column])),
        },
        "hours": hours,
    }


def build_capture_document(
    *,
    stations: list[dict[str, Any]],
    ifs_axes: tuple[np.ndarray, np.ndarray],
    gfs_axes: tuple[np.ndarray, np.ndarray],
    ifs_steps: dict[int, dict[str, Any]],
    gfs_steps: dict[int, dict[str, Any]],
    ifs_initialization: str,
    gfs_initialization: str,
    window_start: str,
    window_end: str,
    created_at: str,
    selection_metadata: dict[str, Any],
) -> dict[str, Any]:
    ifs_hours = _ordered_hours(ifs_steps, window_start, window_end)
    gfs_hours = _ordered_hours(gfs_steps, window_start, window_end)
    if [item["valid_time"] for item in ifs_hours] != [item["valid_time"] for item in gfs_hours]:
        raise ValueError("models must contain exactly 24 shared hourly valid times")
    captured = []
    for station in stations:
        captured.append({
            **station,
            "forecasts": {
                "ifs": _sample_model(station, ifs_axes, ifs_hours),
                "gfs": _sample_model(station, gfs_axes, gfs_hours),
            },
        })
    document = {
        "schemaVersion": SCHEMA_VERSION,
        "kind": KIND,
        "createdAt": created_at,
        "window": {"start": window_start, "end": window_end, "hourCount": 24},
        "method": {"name": METHOD, "version": METHOD_VERSION, "sampling": "nearest-native-grid-cell"},
        "models": {
            "ifs": {"source": "ecmwf-ifs-0.25", "initialization": ifs_initialization},
            "gfs": {"source": "noaa-gfs-0.25", "initialization": gfs_initialization},
        },
        "selection": {
            **selection_metadata,
            "fixedStationCount": sum("fixed" in station["selection"]["groups"] for station in captured),
            "dynamicStationCount": sum("dynamic" in station["selection"]["groups"] for station in captured),
        },
        "stations": captured,
    }
    validate_capture_document(document)
    return document


def validate_capture_document(document: dict[str, Any]) -> None:
    required = {"schemaVersion", "kind", "createdAt", "window", "method", "models", "selection", "stations"}
    if set(document) != required or document["schemaVersion"] != SCHEMA_VERSION or document["kind"] != KIND:
        raise ValueError("station capture has an invalid schema")
    window = document["window"]
    if set(window) != {"start", "end", "hourCount"} or window["hourCount"] != 24:
        raise ValueError("station capture must contain a 24-hour window")
    expected = [iso_utc(parse_utc(window["start"]) + dt.timedelta(hours=offset)) for offset in range(24)]
    if expected[-1] != window["end"]:
        raise ValueError("station capture window end is invalid")
    ids: set[str] = set()
    for station in document["stations"]:
        station_id = station.get("stationId")
        if not isinstance(station_id, str) or not station_id or station_id in ids:
            raise ValueError("station capture IDs must be unique and nonempty")
        ids.add(station_id)
        if set(station["forecasts"]) != {"ifs", "gfs"}:
            raise ValueError("station capture must contain both models")
        for model in ("ifs", "gfs"):
            forecast = station["forecasts"][model]
            if [hour.get("validTime") for hour in forecast.get("hours", [])] != expected:
                raise ValueError("station capture model hours must match the exact window")
            for hour in forecast["hours"]:
                if not all(isinstance(hour[key], (int, float)) and math.isfinite(hour[key]) for key in ("temperatureC", "dewPointC", "pressurePa", "wetBulbC")):
                    raise ValueError("station capture forecast values must be finite")


def load_forecast_grib(path: Path, expected_steps: tuple[int, ...]) -> tuple[tuple[np.ndarray, np.ndarray], dict[int, dict[str, Any]], str]:
    messages = SHARED._decode_grib_messages(path)
    fields_by_step: dict[int, dict[str, Any]] = {}
    axes: tuple[np.ndarray, np.ndarray] | None = None
    initializations: set[str] = set()
    expected_units = {"2t": "K", "2d": "K", "sp": "Pa"}
    name_map = {"2t": "temperature_k", "2d": "dew_point_k", "sp": "pressure_pa"}
    for message in messages:
        if message["short_name"] not in name_map:
            raise ValueError(f"unexpected forecast shortName {message['short_name']}")
        if message["step"] not in expected_steps or message["units"] != expected_units[message["short_name"]]:
            raise ValueError("forecast GRIB contains an unexpected step or unit")
        current_axes = (message["latitudes"], message["longitudes"])
        if axes is None:
            axes = current_axes
        elif not (np.array_equal(axes[0], current_axes[0]) and np.array_equal(axes[1], current_axes[1])):
            raise ValueError("forecast GRIB messages have mismatched grid coordinates")
        initializations.add(message["initialization"])
        fields = fields_by_step.setdefault(message["step"], {"valid_time": message["valid_time"]})
        key = name_map[message["short_name"]]
        if key in fields or fields["valid_time"] != message["valid_time"]:
            raise ValueError("forecast GRIB fields must be unique and simultaneous")
        fields[key] = message["values"]
    if axes is None or len(initializations) != 1 or set(fields_by_step) != set(expected_steps):
        raise ValueError("forecast GRIB does not match the requested steps")
    if any(set(fields) != {"temperature_k", "dew_point_k", "pressure_pa", "valid_time"} for fields in fields_by_step.values()):
        raise ValueError("forecast GRIB must include temperature, dew point, and pressure for each step")
    return axes, fields_by_step, initializations.pop()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ifs-forecast-grib", required=True, type=Path)
    parser.add_argument("--gfs-forecast-grib", required=True, type=Path)
    parser.add_argument("--ifs-grid", required=True, type=Path)
    parser.add_argument("--gfs-grid", required=True, type=Path)
    parser.add_argument("--station-catalog", required=True, type=Path)
    parser.add_argument("--fixed-panel", required=True, type=Path)
    parser.add_argument("--ifs-steps", required=True)
    parser.add_argument("--gfs-steps", required=True)
    parser.add_argument("--window-start", required=True)
    parser.add_argument("--window-end", required=True)
    parser.add_argument("--max-dynamic-stations", type=int, default=20)
    parser.add_argument("--max-station-distance-km", type=float, default=100.0)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    ifs_grid, gfs_grid = read_json(args.ifs_grid), read_json(args.gfs_grid)
    bounds = {"start": args.window_start, "end": args.window_end}
    if ifs_grid["model"]["validTimeBounds"] != bounds or gfs_grid["model"]["validTimeBounds"] != bounds:
        raise ValueError("IFS and GFS grid snapshots must match the station capture window")
    station_catalog = load_station_catalog(args.station_catalog)
    fixed_panel = read_json(args.fixed_panel)
    if set(fixed_panel) != {"version", "stationIds"} or not isinstance(fixed_panel["stationIds"], list):
        raise ValueError("fixed station panel has an invalid schema")
    stations = select_station_panel(
        station_catalog=station_catalog,
        fixed_station_ids=fixed_panel["stationIds"],
        ifs_cells=ifs_grid["cells"],
        gfs_cells=gfs_grid["cells"],
        max_dynamic_stations=args.max_dynamic_stations,
        max_station_distance_km=args.max_station_distance_km,
    )
    ifs_steps = tuple(int(part) for part in args.ifs_steps.split(",") if part)
    gfs_steps = tuple(int(part) for part in args.gfs_steps.split(",") if part)
    ifs_axes, ifs_fields, ifs_initialization = load_forecast_grib(args.ifs_forecast_grib, ifs_steps)
    gfs_axes, gfs_fields, gfs_initialization = load_forecast_grib(args.gfs_forecast_grib, gfs_steps)
    if ifs_grid["model"]["initialization"] != ifs_initialization:
        raise ValueError("IFS grid snapshot and forecast GRIB use different initializations")
    if gfs_grid["model"]["initialization"] != gfs_initialization:
        raise ValueError("GFS grid snapshot and forecast GRIB use different initializations")
    ifs_hourly = SHARED.interpolate_hourly_steps(ifs_fields, ifs_initialization, args.window_start, args.window_end)
    gfs_hourly = {step: fields for step, fields in gfs_fields.items() if args.window_start <= fields["valid_time"] <= args.window_end}
    document = build_capture_document(
        stations=stations,
        ifs_axes=ifs_axes,
        gfs_axes=gfs_axes,
        ifs_steps=ifs_hourly,
        gfs_steps=gfs_hourly,
        ifs_initialization=ifs_initialization,
        gfs_initialization=gfs_initialization,
        window_start=args.window_start,
        window_end=args.window_end,
        created_at=iso_utc(dt.datetime.now(dt.timezone.utc)),
        selection_metadata={
            "fixedPanelVersion": fixed_panel["version"],
            "maxDynamicStations": args.max_dynamic_stations,
            "maxStationDistanceKm": args.max_station_distance_km,
        },
    )
    atomic_write_json(args.output, document)
    print(json.dumps({
        "status": "ok",
        "stationCount": len(document["stations"]),
        "fixedStationCount": document["selection"]["fixedStationCount"],
        "dynamicStationCount": document["selection"]["dynamicStationCount"],
        "output": str(args.output),
    }))


if __name__ == "__main__":
    main()
