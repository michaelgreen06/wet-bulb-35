#!/usr/bin/env python3
"""Download one official NOAA GFS 0.25-degree hourly shadow forecast window."""

import argparse
import concurrent.futures
import datetime as dt
import json
import os
import time
from pathlib import Path
from typing import Iterable

import requests

GFS_ROOT = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
FORECAST_FIELDS = (("PRES", "surface"), ("TMP", "2 m above ground"), ("DPT", "2 m above ground"))
LAND_FIELD = ("LAND", "surface")


def parse_date(value: str) -> str:
    try:
        return dt.date.fromisoformat(value).isoformat()
    except ValueError as error:
        raise argparse.ArgumentTypeError("date must use YYYY-MM-DD") from error


def parse_utc(value: str, label: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{label} must be a UTC ISO-8601 timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() != dt.timedelta(0):
        raise ValueError(f"{label} must be a UTC ISO-8601 timestamp")
    return parsed.astimezone(dt.UTC)


def hourly_steps(run: dt.datetime, window_start: dt.datetime, window_end: dt.datetime) -> list[int]:
    if window_start.tzinfo is None or window_end.tzinfo is None:
        raise ValueError("window timestamps must include UTC offsets")
    window_start = window_start.astimezone(dt.UTC)
    window_end = window_end.astimezone(dt.UTC)
    if any((value.minute, value.second, value.microsecond) != (0, 0, 0) for value in (window_start, window_end)):
        raise ValueError("window timestamps must use whole UTC hours")
    if window_end - window_start != dt.timedelta(hours=23):
        raise ValueError("GFS shadow window must contain exactly 24 hourly valid times")
    start = (window_start - run).total_seconds() / 3600
    end = (window_end - run).total_seconds() / 3600
    if not start.is_integer() or not end.is_integer() or start < 0 or end > 120:
        raise ValueError("GFS run does not provide the requested window at hourly cadence")
    return list(range(int(start), int(end) + 1))


def candidate_runs(requested_date: str | None, requested_time: int | None, now: dt.datetime | None = None) -> list[dt.datetime]:
    if (requested_date is None) != (requested_time is None):
        raise ValueError("--date and --time must be supplied together")
    if requested_date is not None and requested_time is not None:
        return [dt.datetime.combine(dt.date.fromisoformat(requested_date), dt.time(requested_time), tzinfo=dt.UTC)]
    current = (now or dt.datetime.now(dt.UTC)).astimezone(dt.UTC)
    latest_hour = (current.hour // 6) * 6
    latest = current.replace(hour=latest_hour, minute=0, second=0, microsecond=0)
    return [latest - dt.timedelta(hours=6 * offset) for offset in range(8)]


def _index_records(index_text: str) -> list[tuple[int, int, str, str]]:
    parsed: list[tuple[int, str, str]] = []
    for line in index_text.splitlines():
        parts = line.split(":")
        if len(parts) < 6:
            continue
        try:
            offset = int(parts[1])
        except ValueError:
            continue
        parsed.append((offset, parts[3], parts[4]))
    records = []
    for index, (start, field, level) in enumerate(parsed[:-1]):
        records.append((start, parsed[index + 1][0] - 1, field, level))
    return records


def _select_ranges(index_text: str, requested: Iterable[tuple[str, str]]) -> list[tuple[int, int, str]]:
    records = _index_records(index_text)
    selected = []
    for field, level in requested:
        matches = [(start, end, name) for start, end, name, record_level in records if name == field and record_level == level]
        if len(matches) != 1:
            raise ValueError(f"GFS index must contain exactly one {field}:{level} message")
        selected.append(matches[0])
    return selected


def forecast_ranges(index_text: str) -> list[tuple[int, int, str]]:
    return _select_ranges(index_text, FORECAST_FIELDS)


def land_mask_range(index_text: str) -> tuple[int, int, str]:
    return _select_ranges(index_text, (LAND_FIELD,))[0]


def object_url(run: dt.datetime, step: int) -> str:
    return f"{GFS_ROOT}/gfs.{run:%Y%m%d}/{run:%H}/atmos/gfs.t{run:%H}z.pgrb2.0p25.f{step:03d}"


def get_text(url: str) -> str:
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    return response.text


def get_range(url: str, start: int, end: int) -> bytes:
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = requests.get(url, headers={"Range": f"bytes={start}-{end}"}, timeout=60)
            expected_length = end - start + 1
            content_range = response.headers.get("content-range", "")
            if response.status_code != 206 or len(response.content) != expected_length \
                    or not content_range.startswith(f"bytes {start}-{end}/"):
                raise RuntimeError(f"unexpected GFS byte-range response {response.status_code} for {url}")
            if not response.content.startswith(b"GRIB") or not response.content.endswith(b"7777"):
                raise RuntimeError(f"invalid GFS GRIB framing for {url}")
            return response.content
        except Exception as error:
            last_error = error
            if attempt < 2:
                time.sleep(2 ** attempt)
    assert last_error is not None
    raise last_error


def write_atomic(path: Path, payloads: Iterable[bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        with temporary.open("wb") as stream:
            for payload in payloads:
                stream.write(payload)
        if temporary.stat().st_size <= 0:
            raise RuntimeError(f"GFS retrieval produced an empty file: {path}")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def download_run(run: dt.datetime, steps: list[int], forecast_output: Path, land_mask_output: Path) -> None:
    jobs: list[tuple[int, int, str, int, int]] = []
    for step in steps:
        url = object_url(run, step)
        index_text = get_text(f"{url}.idx")
        for order, (start, end, _field) in enumerate(forecast_ranges(index_text)):
            jobs.append((step, order, url, start, end))
    land_url = object_url(run, 0)
    land_start, land_end, _ = land_mask_range(get_text(f"{land_url}.idx"))

    results: dict[tuple[int, int], bytes] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(get_range, url, start, end): (step, order)
            for step, order, url, start, end in jobs
        }
        for future in concurrent.futures.as_completed(futures):
            results[futures[future]] = future.result()
    write_atomic(forecast_output, (results[(step, order)] for step in steps for order in range(3)))
    write_atomic(land_mask_output, (get_range(land_url, land_start, land_end),))


def iso_utc(value: dt.datetime) -> str:
    return value.astimezone(dt.UTC).isoformat().replace("+00:00", "Z")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", type=parse_date)
    parser.add_argument("--time", type=int, choices=(0, 6, 12, 18))
    parser.add_argument("--window-start", required=True)
    parser.add_argument("--window-end", required=True)
    parser.add_argument("--forecast-output", required=True, type=Path)
    parser.add_argument("--land-mask-output", required=True, type=Path)
    parser.add_argument("--metadata-output", type=Path)
    args = parser.parse_args()

    window_start = parse_utc(args.window_start, "window start")
    window_end = parse_utc(args.window_end, "window end")
    failures: list[str] = []
    selected: dt.datetime | None = None
    selected_steps: list[int] = []
    for run in candidate_runs(args.date, args.time):
        try:
            steps = hourly_steps(run, window_start, window_end)
            download_run(run, steps, args.forecast_output, args.land_mask_output)
            selected = run
            selected_steps = steps
            break
        except Exception as error:
            args.forecast_output.unlink(missing_ok=True)
            args.land_mask_output.unlink(missing_ok=True)
            failures.append(f"{iso_utc(run)}: {type(error).__name__}: {error}")
            if args.date is not None:
                raise
    if selected is None:
        raise RuntimeError("No complete GFS run was retrievable: " + " | ".join(failures))

    retrieved_at = dt.datetime.now(dt.UTC)
    metadata = {
        "source": "noaa-gfs-0.25",
        "initialization": iso_utc(selected),
        "retrievedAt": iso_utc(retrieved_at),
        "windowStart": iso_utc(window_start),
        "windowEnd": iso_utc(window_end),
        "validTo": iso_utc(window_end + dt.timedelta(hours=1)),
        "steps": selected_steps,
        "forecastBytes": args.forecast_output.stat().st_size,
        "landMaskBytes": args.land_mask_output.stat().st_size,
    }
    if args.metadata_output:
        args.metadata_output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.metadata_output.with_name(f".{args.metadata_output.name}.tmp-{os.getpid()}")
        temporary.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        temporary.replace(args.metadata_output)
    print(json.dumps(metadata))


if __name__ == "__main__":
    main()
