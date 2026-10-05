#!/usr/bin/env python3
"""Download one complete public ECMWF run covering the next 24 hours."""
import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path

from ecmwf.opendata import Client


def parse_date(value: str) -> str:
    try:
        return dt.date.fromisoformat(value).isoformat()
    except ValueError as error:
        raise argparse.ArgumentTypeError("date must use YYYY-MM-DD") from error


def retrieve(client: Client, target: Path, **request: object) -> None:
    target.unlink(missing_ok=True)
    client.retrieve(target=str(target), **request)
    if not target.is_file() or target.stat().st_size <= 0:
        raise RuntimeError(f"ECMWF retrieval produced an empty file: {target}")


def candidate_runs(client: Client, requested_date: str | None, requested_time: int | None) -> list[dt.datetime]:
    if (requested_date is None) != (requested_time is None):
        raise ValueError("--date and --time must be supplied together")
    if requested_date is not None and requested_time is not None:
        return [dt.datetime.combine(dt.date.fromisoformat(requested_date), dt.time(requested_time), tzinfo=dt.UTC)]
    latest = client.latest().replace(tzinfo=dt.UTC)
    return [latest - dt.timedelta(hours=6 * offset) for offset in range(8)]


def hourly_window(reference: dt.datetime) -> tuple[dt.datetime, dt.datetime]:
    """Return the first 24 complete UTC forecast hours at or after reference."""
    if reference.tzinfo is None:
        raise ValueError("reference time must include a UTC offset")
    reference = reference.astimezone(dt.UTC)
    start = reference.replace(minute=0, second=0, microsecond=0) + dt.timedelta(hours=1)
    return start, start + dt.timedelta(hours=23)


def covering_steps(run: dt.datetime, window_start: dt.datetime, window_end: dt.datetime) -> list[int]:
    """Return three-hourly source steps bracketing an inclusive hourly window."""
    start_hours = max(0.0, (window_start - run).total_seconds() / 3600)
    end_hours = max(0.0, (window_end - run).total_seconds() / 3600)
    start = max(0, math.floor(start_hours / 3) * 3)
    end = math.ceil(end_hours / 3) * 3
    if end > 240:
        raise ValueError("ECMWF run is too old to cover the next 24 hours within the supported forecast range")
    return list(range(start, end + 1, 3))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", type=parse_date)
    parser.add_argument("--time", type=int, choices=(0, 6, 12, 18))
    parser.add_argument("--forecast-output", required=True, type=Path)
    parser.add_argument("--land-mask-output", required=True, type=Path)
    parser.add_argument("--metadata-output", type=Path)
    parser.add_argument("--reference-time", help="UTC ISO timestamp used to choose covering steps; defaults to now")
    parser.add_argument("--source", default="ecmwf", choices=("ecmwf", "aws", "azure"))
    args = parser.parse_args()

    reference_override: dt.datetime | None = None
    if args.reference_time:
        reference_override = dt.datetime.fromisoformat(args.reference_time.replace("Z", "+00:00"))
        if reference_override.tzinfo is None:
            raise ValueError("--reference-time must include a UTC offset")
        reference_override = reference_override.astimezone(dt.UTC)

    client = Client(source=args.source, model="ifs", resol="0p25", infer_stream_keyword=False)
    args.forecast_output.parent.mkdir(parents=True, exist_ok=True)
    args.land_mask_output.parent.mkdir(parents=True, exist_ok=True)
    forecast_temporary = args.forecast_output.with_name(f".{args.forecast_output.name}.tmp-{os.getpid()}")
    mask_temporary = args.land_mask_output.with_name(f".{args.land_mask_output.name}.tmp-{os.getpid()}")
    failures: list[str] = []
    selected: dt.datetime | None = None
    selected_steps: list[int] = []
    selected_window: tuple[dt.datetime, dt.datetime] | None = None
    selected_reference: dt.datetime | None = None
    retrieved_at: dt.datetime | None = None

    try:
        for run in candidate_runs(client, args.date, args.time):
            common = {"date": run.date().isoformat(), "time": run.hour, "stream": "oper", "type": "fc"}
            try:
                window_reference = reference_override or dt.datetime.now(dt.UTC)
                for coverage_attempt in range(2):
                    window_start, window_end = hourly_window(window_reference)
                    steps = covering_steps(run, window_start, window_end)
                    retrieve(client, forecast_temporary, **common, step=steps, param=["2t", "2d", "sp"])
                    retrieve(client, mask_temporary, **common, step=0, param=["lsm"])
                    completed = dt.datetime.now(dt.UTC)
                    actual_reference = reference_override or completed
                    actual_start, actual_end = hourly_window(actual_reference)
                    first_valid = run + dt.timedelta(hours=steps[0])
                    last_valid = run + dt.timedelta(hours=steps[-1])
                    if first_valid <= actual_start and last_valid >= actual_end:
                        forecast_temporary.replace(args.forecast_output)
                        mask_temporary.replace(args.land_mask_output)
                        selected = run
                        selected_steps = steps
                        selected_window = (actual_start, actual_end)
                        selected_reference = actual_reference
                        retrieved_at = completed
                        break
                    if coverage_attempt == 1:
                        raise RuntimeError("ECMWF retrieval crossed the selected forecast window twice")
                    window_reference = completed
                if selected is not None:
                    break
            except Exception as error:  # client raises multiple transport/index exception types
                forecast_temporary.unlink(missing_ok=True)
                mask_temporary.unlink(missing_ok=True)
                failures.append(f"{run.isoformat()}: {type(error).__name__}: {error}")
                if args.date is not None:
                    raise
        if selected is None:
            raise RuntimeError("No complete ECMWF run was retrievable: " + " | ".join(failures))
    finally:
        forecast_temporary.unlink(missing_ok=True)
        mask_temporary.unlink(missing_ok=True)

    if selected_window is None or selected_reference is None or retrieved_at is None:
        raise RuntimeError("ECMWF retrieval did not produce complete window metadata")
    window_start, window_end = selected_window
    metadata = {
        "initialization": selected.isoformat().replace("+00:00", "Z"),
        "referenceTime": selected_reference.isoformat().replace("+00:00", "Z"),
        "retrievedAt": retrieved_at.isoformat().replace("+00:00", "Z"),
        "windowStart": window_start.isoformat().replace("+00:00", "Z"),
        "windowEnd": window_end.isoformat().replace("+00:00", "Z"),
        "validTo": (window_end + dt.timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        "steps": selected_steps,
        "hourlySteps": [int((window_start - selected).total_seconds() // 3600) + offset for offset in range(24)],
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
