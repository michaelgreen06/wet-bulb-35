#!/usr/bin/env python3
"""Write a deterministic top-50 ECMWF global-grid wet-bulb snapshot.

This offline product evaluates every finite warm native-grid cell, including
land, ocean, and uninhabited cells, at the supplied three-hourly forecast steps.
"""

import argparse
import datetime as dt
import importlib.util
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

import numpy as np

_SHARED_PATH = Path(__file__).with_name("generate-ecmwf-hotspot-candidates.py")
_SHARED_SPEC = importlib.util.spec_from_file_location("ecmwf_hotspot_candidates_shared", _SHARED_PATH)
if _SHARED_SPEC is None or _SHARED_SPEC.loader is None:
    raise RuntimeError(f"cannot load shared ECMWF helpers from {_SHARED_PATH}")
SHARED = importlib.util.module_from_spec(_SHARED_SPEC)
sys.modules[_SHARED_SPEC.name] = SHARED
_SHARED_SPEC.loader.exec_module(SHARED)

SCHEMA_VERSION = 1
METHOD = SHARED.METHOD
METHOD_VERSION = SHARED.METHOD_VERSION
DEFAULT_STEPS = tuple(range(0, 25, 3))
TOP_CELL_COUNT = 50
_CELL_FIELDS = {"latitude", "longitude", "wetBulbC", "temperatureC", "dewPointC", "pressurePa", "peakStep", "peakTime"}


def _parse_utc_timestamp(value: Any, label: str) -> dt.datetime:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a nonempty UTC ISO-8601 timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{label} must be a UTC ISO-8601 timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() != dt.timedelta(0):
        raise ValueError(f"{label} must be a UTC ISO-8601 timestamp")
    return parsed


def _iso_utc(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_axes(latitudes: np.ndarray, longitudes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    latitudes = np.asarray(latitudes, dtype=float)
    longitudes = np.asarray(longitudes, dtype=float)
    if latitudes.ndim != 1 or longitudes.ndim != 1 or not len(latitudes) or not len(longitudes):
        raise ValueError("grid axes must be nonempty one-dimensional arrays")
    if np.any(~np.isfinite(latitudes)) or np.any(~np.isfinite(longitudes)):
        raise ValueError("grid axes must be finite")
    if np.any((latitudes < -90.0) | (latitudes > 90.0)):
        raise ValueError("grid latitudes must be within [-90, 90]")
    if np.any((longitudes < -360.0) | (longitudes > 360.0)):
        raise ValueError("grid longitudes must be within [-360, 360]")
    if len(np.unique(latitudes)) != len(latitudes) or len(np.unique(longitudes)) != len(longitudes):
        raise ValueError("grid axes must not contain duplicate coordinates")
    return latitudes, longitudes


def _validate_steps(steps: dict[int, dict[str, Any]], model: dict[str, Any]) -> tuple[list[int], dt.datetime]:
    if not isinstance(steps, dict) or not steps:
        raise ValueError("at least one three-hourly forecast step is required")
    ordered_steps = sorted(steps)
    if ordered_steps != list(steps) or any(isinstance(step, bool) or not isinstance(step, int) or step < 0 or step % 3 for step in ordered_steps):
        raise ValueError("steps must be sorted, nonnegative, unique three-hourly integers")
    if not isinstance(model, dict) or set(model) != {"source", "initialization", "steps"}:
        raise ValueError("model must contain exactly source, initialization, and steps")
    if not isinstance(model["source"], str) or not model["source"]:
        raise ValueError("model source must be a nonempty string")
    initialization = _parse_utc_timestamp(model["initialization"], "model initialization")
    if model["steps"] != ordered_steps:
        raise ValueError("model steps must exactly equal the supplied sorted steps")
    return ordered_steps, initialization


def _validate_step_fields(step: int, fields: Any, shape: tuple[int, int], initialization: dt.datetime) -> tuple[np.ndarray, np.ndarray, np.ndarray, str]:
    if not isinstance(fields, dict) or set(fields) != {"temperature_k", "dew_point_k", "pressure_pa", "valid_time"}:
        raise ValueError(f"step {step} must contain simultaneous temperature, dew point, pressure, and valid time")
    valid_time = _parse_utc_timestamp(fields["valid_time"], f"step {step} valid time")
    expected_time = initialization + dt.timedelta(hours=step)
    if valid_time != expected_time:
        raise ValueError(f"step {step} valid time must equal initialization plus its forecast step")
    temperature = np.asarray(fields["temperature_k"], dtype=float)
    dew_point = np.asarray(fields["dew_point_k"], dtype=float)
    pressure = np.asarray(fields["pressure_pa"], dtype=float)
    if temperature.shape != shape or dew_point.shape != shape or pressure.shape != shape:
        raise ValueError(f"step {step} grid fields must match the latitude/longitude axes")
    if np.any(np.isinf(temperature)) or np.any(np.isinf(dew_point)) or np.any(np.isinf(pressure)):
        raise ValueError(f"step {step} grid fields must not contain infinite values")
    for label, values in (("temperature", temperature), ("dew point", dew_point), ("pressure", pressure)):
        finite = np.isfinite(values)
        if np.any(values[finite] <= 0):
            raise ValueError(f"step {step} finite {label} values must be positive")
    return temperature, dew_point, pressure, _iso_utc(valid_time)


def _cell_record(
    row: int,
    column: int,
    latitudes: np.ndarray,
    longitudes: np.ndarray,
    maxima: np.ndarray,
    peak_steps: np.ndarray,
    peak_times: np.ndarray,
    peak_temperature: np.ndarray,
    peak_dew_point: np.ndarray,
    peak_pressure: np.ndarray,
) -> dict[str, Any]:
    return {
        "latitude": float(latitudes[row]),
        "longitude": float(longitudes[column]),
        "wetBulbC": float(maxima[row, column]),
        "temperatureC": float(peak_temperature[row, column] - 273.15),
        "dewPointC": float(peak_dew_point[row, column] - 273.15),
        "pressurePa": float(peak_pressure[row, column]),
        "peakStep": int(peak_steps[row, column]),
        "peakTime": str(peak_times[row, column]),
    }


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_snapshot_document(document: dict[str, Any]) -> None:
    required = {"schemaVersion", "method", "methodVersion", "model", "cells"}
    if not isinstance(document, dict) or set(document) != required or document["schemaVersion"] != SCHEMA_VERSION:
        raise ValueError("snapshot document has an invalid schema")
    if document["method"] != METHOD or document["methodVersion"] != METHOD_VERSION:
        raise ValueError("snapshot document has an invalid wet-bulb method")
    model = document["model"]
    model_fields = {"source", "initialization", "validTimeBounds", "steps", "grid", "evaluatedCellCount"}
    if not isinstance(model, dict) or set(model) != model_fields or not isinstance(model["source"], str) or not model["source"]:
        raise ValueError("snapshot document has invalid model metadata")
    initialization = _parse_utc_timestamp(model["initialization"], "snapshot initialization")
    bounds = model["validTimeBounds"]
    if not isinstance(bounds, dict) or set(bounds) != {"start", "end"}:
        raise ValueError("snapshot document has invalid valid-time bounds")
    start, end = _parse_utc_timestamp(bounds["start"], "snapshot valid-time start"), _parse_utc_timestamp(bounds["end"], "snapshot valid-time end")
    if start > end:
        raise ValueError("snapshot valid-time bounds are reversed")
    steps = model["steps"]
    if not isinstance(steps, list) or not steps or any(isinstance(step, bool) or not isinstance(step, int) or step < 0 or step % 3 for step in steps) or steps != sorted(set(steps)):
        raise ValueError("snapshot steps must be sorted unique nonnegative three-hourly integers")
    if start != initialization + dt.timedelta(hours=steps[0]) or end != initialization + dt.timedelta(hours=steps[-1]):
        raise ValueError("snapshot valid-time bounds must match initialization and steps")
    grid = model["grid"]
    if not isinstance(grid, dict) or set(grid) != {"latitudeCount", "longitudeCount"} or any(not isinstance(grid[key], int) or isinstance(grid[key], bool) or grid[key] <= 0 for key in grid):
        raise ValueError("snapshot document has invalid grid size")
    possible_cells = grid["latitudeCount"] * grid["longitudeCount"]
    if not isinstance(model["evaluatedCellCount"], int) or isinstance(model["evaluatedCellCount"], bool) or not 0 <= model["evaluatedCellCount"] <= possible_cells:
        raise ValueError("snapshot document has invalid evaluated cell count")
    cells = document["cells"]
    if not isinstance(cells, list) or len(cells) > TOP_CELL_COUNT or len(cells) > model["evaluatedCellCount"]:
        raise ValueError("snapshot document has an invalid cell list")
    ranking: list[tuple[float, float, float]] = []
    seen_coordinates: set[tuple[float, float]] = set()
    for cell in cells:
        if not isinstance(cell, dict) or set(cell) != _CELL_FIELDS:
            raise ValueError("snapshot document has an invalid cell")
        if not all(_is_finite_number(cell[key]) for key in ("latitude", "longitude", "wetBulbC", "temperatureC", "dewPointC", "pressurePa")):
            raise ValueError("snapshot cell numeric values must be finite")
        if not -90 <= cell["latitude"] <= 90 or not -360 <= cell["longitude"] <= 360 or cell["pressurePa"] <= 0:
            raise ValueError("snapshot cell coordinates or pressure are invalid")
        if not isinstance(cell["peakStep"], int) or isinstance(cell["peakStep"], bool) or cell["peakStep"] not in steps:
            raise ValueError("snapshot cell peak step is invalid")
        peak_time = _parse_utc_timestamp(cell["peakTime"], "snapshot cell peak time")
        if peak_time != initialization + dt.timedelta(hours=cell["peakStep"]):
            raise ValueError("snapshot cell peak time must match its peak step")
        coordinate = (float(cell["latitude"]), float(cell["longitude"]))
        if coordinate in seen_coordinates:
            raise ValueError("snapshot cells must have unique coordinates")
        seen_coordinates.add(coordinate)
        ranking.append((-float(cell["wetBulbC"]), float(cell["latitude"]), float(cell["longitude"])))
    if ranking != sorted(ranking):
        raise ValueError("snapshot cells must be deterministically ranked")


def generate_snapshot_from_arrays(*, latitudes: np.ndarray, longitudes: np.ndarray, steps: dict[int, dict[str, Any]], model: dict[str, Any]) -> dict[str, Any]:
    """Rank up to 50 simultaneous, finite warm global-grid cell maxima."""
    latitudes, longitudes = _validate_axes(latitudes, longitudes)
    shape = (len(latitudes), len(longitudes))
    ordered_steps, initialization = _validate_steps(steps, model)
    maxima = np.full(shape, np.nan, dtype=float)
    peak_steps = np.full(shape, -1, dtype=int)
    peak_times = np.full(shape, "", dtype=object)
    peak_temperature = np.full(shape, np.nan, dtype=float)
    peak_dew_point = np.full(shape, np.nan, dtype=float)
    peak_pressure = np.full(shape, np.nan, dtype=float)

    for step in ordered_steps:
        temperature, dew_point, pressure, valid_time = _validate_step_fields(step, steps[step], shape, initialization)
        warm_finite = (
            np.isfinite(temperature)
            & np.isfinite(dew_point)
            & np.isfinite(pressure)
            & (temperature > SHARED.TRIPLE_POINT_K)
        )
        if not np.any(warm_finite):
            continue
        # The shared routine intentionally rejects nonfinite grid values. Feed it
        # only finite warm cells, then restore their positions in the full grid.
        wet_bulb = np.full(shape, np.nan, dtype=float)
        wet_bulb[warm_finite] = SHARED.calculate_warm_liquid_wet_bulb_celsius(
            pressure[warm_finite], temperature[warm_finite], dew_point[warm_finite]
        )
        replace = np.isfinite(wet_bulb) & (~np.isfinite(maxima) | (wet_bulb > maxima))
        maxima[replace] = wet_bulb[replace]
        peak_steps[replace] = step
        peak_times[replace] = valid_time
        peak_temperature[replace] = temperature[replace]
        peak_dew_point[replace] = dew_point[replace]
        peak_pressure[replace] = pressure[replace]

    evaluated_cell_count = int(np.count_nonzero(np.isfinite(maxima)))
    candidate_indices = np.argwhere(np.isfinite(maxima))
    ranked_indices = sorted(
        candidate_indices.tolist(),
        key=lambda index: (-float(maxima[index[0], index[1]]), float(latitudes[index[0]]), float(longitudes[index[1]])),
    )[:TOP_CELL_COUNT]
    cells = [_cell_record(row, column, latitudes, longitudes, maxima, peak_steps, peak_times, peak_temperature, peak_dew_point, peak_pressure) for row, column in ranked_indices]
    document = {
        "schemaVersion": SCHEMA_VERSION,
        "method": METHOD,
        "methodVersion": METHOD_VERSION,
        "model": {
            "source": model["source"],
            "initialization": _iso_utc(initialization),
            "validTimeBounds": {
                "start": _iso_utc(initialization + dt.timedelta(hours=ordered_steps[0])),
                "end": _iso_utc(initialization + dt.timedelta(hours=ordered_steps[-1])),
            },
            "steps": ordered_steps,
            "grid": {"latitudeCount": len(latitudes), "longitudeCount": len(longitudes)},
            "evaluatedCellCount": evaluated_cell_count,
        },
        "cells": cells,
    }
    validate_snapshot_document(document)
    return document


def load_grib_inputs(forecast_path: Path, expected_steps: tuple[int, ...]) -> tuple[np.ndarray, np.ndarray, dict[int, dict[str, Any]], str]:
    """Decode one regular-grid ECMWF forecast using the shared ecCodes decoder."""
    messages = SHARED._decode_grib_messages(forecast_path)
    axes: tuple[np.ndarray, np.ndarray] | None = None
    initializations: set[str] = set()
    fields_by_step: dict[int, dict[str, Any]] = {}
    expected_units = {"2t": "K", "2d": "K", "sp": "Pa"}
    name_map = {"2t": "temperature_k", "2d": "dew_point_k", "sp": "pressure_pa"}
    for message in messages:
        short_name = message["short_name"]
        if short_name not in name_map or message["units"] != expected_units[short_name] or message["step"] not in expected_steps:
            raise ValueError(f"unexpected ECMWF GRIB field, unit, or step: {short_name}")
        current_axes = (message["latitudes"], message["longitudes"])
        if axes is None:
            axes = current_axes
        elif not (np.array_equal(axes[0], current_axes[0]) and np.array_equal(axes[1], current_axes[1])):
            raise ValueError("forecast GRIB messages have mismatched grid coordinates")
        initializations.add(message["initialization"])
        fields = fields_by_step.setdefault(message["step"], {"valid_time": message["valid_time"]})
        field_name = name_map[short_name]
        if field_name in fields or fields["valid_time"] != message["valid_time"]:
            raise ValueError(f"duplicate or non-simultaneous GRIB field at step {message['step']}")
        fields[field_name] = message["values"]
    if axes is None or len(initializations) != 1 or set(fields_by_step) != set(expected_steps):
        raise ValueError("forecast GRIB must contain one initialization and all requested steps")
    if any(set(fields) != {"temperature_k", "dew_point_k", "pressure_pa", "valid_time"} for fields in fields_by_step.values()):
        raise ValueError("forecast GRIB must include 2t, 2d, and sp for every requested step")
    return axes[0], axes[1], fields_by_step, initializations.pop()


def load_npz_inputs(path: Path) -> tuple[np.ndarray, np.ndarray, dict[int, dict[str, np.ndarray]]]:
    """Load a synthetic NPZ fixture without land-mask or population inputs."""
    with np.load(path) as data:
        required = {"latitudes", "longitudes"}
        if not required.issubset(data.files):
            raise ValueError("NPZ fixture must contain latitudes and longitudes")
        fields_by_step: dict[int, dict[str, np.ndarray]] = {}
        for name in data.files:
            matched = re.fullmatch(r"step_(\d+)_(temperature_k|dew_point_k|pressure_pa)", name)
            if matched:
                fields_by_step.setdefault(int(matched.group(1)), {})[matched.group(2)] = data[name]
        if not fields_by_step or any(set(fields) != {"temperature_k", "dew_point_k", "pressure_pa"} for fields in fields_by_step.values()):
            raise ValueError("NPZ fixture must contain temperature, dew point, and pressure for every step")
        return data["latitudes"], data["longitudes"], fields_by_step


def _parse_steps(value: str) -> tuple[int, ...]:
    parts = value.split(",")
    try:
        steps = tuple(int(part) for part in parts)
    except ValueError as error:
        raise ValueError("--steps must be a comma-separated integer list") from error
    if not steps or tuple(sorted(set(steps))) != steps or any(step < 0 or step % 3 for step in steps):
        raise ValueError("--steps must be sorted, unique, nonnegative three-hourly integers")
    return steps


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--forecast-grib", type=Path, help="production ECMWF GRIB containing 2t, 2d, and sp")
    input_group.add_argument("--arrays-npz", type=Path, help="synthetic test fixture only; never a production source")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run", help="required with --arrays-npz; UTC ISO-8601 model initialization")
    parser.add_argument("--steps", default=",".join(map(str, DEFAULT_STEPS)))
    args = parser.parse_args(argv)
    try:
        expected_steps = _parse_steps(args.steps)
        if args.arrays_npz:
            if not args.run:
                parser.error("--run is required with --arrays-npz")
            initialization = _iso_utc(_parse_utc_timestamp(args.run, "--run"))
            latitudes, longitudes, raw_steps = load_npz_inputs(args.arrays_npz)
            if tuple(sorted(raw_steps)) != expected_steps:
                parser.error("--steps must exactly match NPZ fixture steps")
            steps = {
                step: {**fields, "valid_time": _iso_utc(_parse_utc_timestamp(initialization, "--run") + dt.timedelta(hours=step))}
                for step, fields in raw_steps.items()
            }
        else:
            latitudes, longitudes, steps, initialization = load_grib_inputs(args.forecast_grib, expected_steps)
            if args.run and _iso_utc(_parse_utc_timestamp(args.run, "--run")) != initialization:
                parser.error("--run does not match GRIB model initialization")
        document = generate_snapshot_from_arrays(
            latitudes=latitudes,
            longitudes=longitudes,
            steps=steps,
            model={"source": "ecmwf-ifs-0.25", "initialization": initialization, "steps": list(expected_steps)},
        )
    except ValueError as error:
        parser.error(str(error))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
