#!/usr/bin/env python3
"""Discover inhabited ECMWF native-grid wet-bulb candidates.

This is an offline discovery layer: it reads one frozen IFS GRIB run and a city
manifest, identifies three-hourly native-grid candidates, and writes JSON for
later hourly, city-specific refinement. It does not claim a final hourly rank.
"""

import argparse
import datetime as dt
import json
import math
import re
from pathlib import Path
from typing import Any

import numpy as np

SCHEMA_VERSION = 1
METHOD = "romps-thermodynamic-liquid"
METHOD_VERSION = "2026-heatindex-0.0.2"
DISCOVERY_BOUNDARY = "three-hourly-native-grid-candidate-discovery-not-final-hourly-ranking"
TRIPLE_POINT_K = 273.16
DEFAULT_STEPS = tuple(range(0, 25, 3))
CITY_FIELDS = ("path", "name", "state", "country", "latitude", "longitude")


def liquid_saturation_vapor_pressure_pa(temperature_k: np.ndarray | float) -> np.ndarray | float:
    """Romps liquid-water saturation vapor pressure in Pa."""
    temperature = np.asarray(temperature_k, dtype=float)
    if np.any(~np.isfinite(temperature)) or np.any(temperature <= 0):
        raise ValueError("saturation temperature must be positive and finite")
    value = 611.65 * np.power(temperature / TRIPLE_POINT_K, (1418 + 461 - 4119) / 461) * np.exp(
        ((2.374e6 - (1418 - 4119) * TRIPLE_POINT_K) / 461) * (1 / TRIPLE_POINT_K - 1 / temperature)
    )
    return float(value) if temperature.ndim == 0 else value


def wet_bulb_celsius(pressure_pa: float, temperature_k: float, dew_point_k: float) -> float:
    """Calculate a warm-cell liquid Romps wet bulb using official heatindex."""
    import heatindex

    if not all(math.isfinite(value) for value in (pressure_pa, temperature_k, dew_point_k)):
        raise ValueError("wet-bulb inputs must be finite")
    if pressure_pa <= 0 or temperature_k <= 0 or dew_point_k <= 0:
        raise ValueError("wet-bulb pressure and temperatures must be positive")
    dew_point_k = min(dew_point_k, temperature_k)
    relative_humidity = float(
        liquid_saturation_vapor_pressure_pa(dew_point_k) / liquid_saturation_vapor_pressure_pa(temperature_k)
    )
    relative_humidity = min(1.0, max(0.0, relative_humidity))
    return float(heatindex.wetbulb(pressure_pa, temperature_k, relative_humidity) - 273.15)


def calculate_warm_liquid_wet_bulb_celsius(
    pressure_pa: np.ndarray, temperature_k: np.ndarray, dew_point_k: np.ndarray
) -> np.ndarray:
    """Return liquid wet bulb for warm cells; cold cells remain NaN by design.

    Candidate discovery only needs globally high wet-bulb cells. The deliberate
    warm-cell boundary avoids assigning an ice-phase RH to irrelevant cold cells.
    """
    pressure = np.asarray(pressure_pa, dtype=float)
    temperature = np.asarray(temperature_k, dtype=float)
    dew_point = np.asarray(dew_point_k, dtype=float)
    if pressure.shape != temperature.shape or pressure.shape != dew_point.shape:
        raise ValueError("pressure, temperature, and dew point grids must share a shape")
    if np.any(~np.isfinite(pressure)) or np.any(~np.isfinite(temperature)) or np.any(~np.isfinite(dew_point)):
        raise ValueError("grid values must be finite")
    if np.any(pressure <= 0) or np.any(temperature <= 0) or np.any(dew_point <= 0):
        raise ValueError("grid pressure and temperatures must be positive")

    import heatindex

    result = np.full(temperature.shape, np.nan, dtype=float)
    warm = temperature > TRIPLE_POINT_K
    clamped_dew_point = np.minimum(dew_point[warm], temperature[warm])
    relative_humidity = np.clip(
        liquid_saturation_vapor_pressure_pa(clamped_dew_point)
        / liquid_saturation_vapor_pressure_pa(temperature[warm]),
        0.0,
        1.0,
    )
    result[warm] = np.asarray(
        heatindex.wetbulb(
            pressure[warm],
            temperature[warm],
            relative_humidity,
            verbose=False,
            icebulb=False,
        ),
        dtype=float,
    ) - 273.15
    return result


def nearest_grid_cell(latitudes: np.ndarray, longitudes: np.ndarray, latitude: float, longitude: float) -> tuple[int, int]:
    """Map a coordinate to the nearest regular-grid cell, including the dateline."""
    latitudes = np.asarray(latitudes, dtype=float)
    longitudes = np.asarray(longitudes, dtype=float)
    if latitudes.ndim != 1 or longitudes.ndim != 1 or not len(latitudes) or not len(longitudes):
        raise ValueError("grid latitude and longitude axes must be nonempty one-dimensional arrays")
    if not all(math.isfinite(value) for value in (latitude, longitude)):
        raise ValueError("city coordinate must be finite")
    row = int(np.argmin(np.abs(latitudes - latitude)))
    longitude_distance = np.abs(((longitudes - longitude + 180.0) % 360.0) - 180.0)
    column = int(np.argmin(longitude_distance))
    return row, column


def dilate_selected_cells(selected: np.ndarray, rings: int) -> np.ndarray:
    """Dilate cells by Chebyshev rings; longitude wraps and latitude does not."""
    if not isinstance(rings, int) or rings < 0:
        raise ValueError("dilation rings must be a nonnegative integer")
    selected = np.asarray(selected, dtype=bool)
    if selected.ndim != 2:
        raise ValueError("selected cells must be a two-dimensional grid")
    result = selected.copy()
    for _ in range(rings):
        expanded = result.copy()
        for row_offset in (-1, 0, 1):
            source_rows = np.arange(result.shape[0]) + row_offset
            valid_rows = (source_rows >= 0) & (source_rows < result.shape[0])
            for column_offset in (-1, 0, 1):
                shifted = np.roll(result, column_offset, axis=1)
                expanded[valid_rows] |= shifted[source_rows[valid_rows]]
        result = expanded
    return result


def validate_city_manifest(cities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(cities, list):
        raise ValueError("city manifest must be a JSON array")
    normalized: list[dict[str, Any]] = []
    paths: set[str] = set()
    for position, city in enumerate(cities):
        if not isinstance(city, dict) or set(city) != set(CITY_FIELDS):
            raise ValueError(f"city {position} must contain exactly {CITY_FIELDS}")
        if not all(isinstance(city[field], str) for field in ("path", "name", "state", "country")):
            raise ValueError(f"city {position} text fields must be strings")
        if not city["path"] or city["path"] in paths:
            raise ValueError(f"city {position} path must be unique and nonempty")
        latitude, longitude = city["latitude"], city["longitude"]
        if isinstance(latitude, bool) or isinstance(longitude, bool) or not all(
            isinstance(value, (int, float)) and math.isfinite(value) for value in (latitude, longitude)
        ):
            raise ValueError(f"city {position} coordinates must be finite numbers")
        if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
            raise ValueError(f"city {position} coordinates are out of range")
        paths.add(city["path"])
        normalized.append({**city, "latitude": float(latitude), "longitude": float(longitude)})
    return normalized


def _validate_axes(latitudes: np.ndarray, longitudes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    latitudes = np.asarray(latitudes, dtype=float)
    longitudes = np.asarray(longitudes, dtype=float)
    if latitudes.ndim != 1 or longitudes.ndim != 1 or not len(latitudes) or not len(longitudes):
        raise ValueError("grid axes must be nonempty one-dimensional arrays")
    if np.any(~np.isfinite(latitudes)) or np.any(~np.isfinite(longitudes)):
        raise ValueError("grid axes must be finite")
    return latitudes, longitudes


def _grid_cell_record(
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


def validate_candidate_document(document: dict[str, Any]) -> None:
    required = {"schemaVersion", "method", "methodVersion", "discoveryBoundary", "model", "selection", "globalLandMaximum", "cities"}
    if set(document) != required or document["schemaVersion"] != SCHEMA_VERSION:
        raise ValueError("candidate document has an invalid schema")
    if document["method"] != METHOD or document["methodVersion"] != METHOD_VERSION:
        raise ValueError("candidate document has an invalid wet-bulb method")
    if document["discoveryBoundary"] != DISCOVERY_BOUNDARY:
        raise ValueError("candidate document has an invalid discovery boundary")
    model = document["model"]
    if set(model) != {"source", "initialization", "steps", "grid"} or not isinstance(model["source"], str) or not isinstance(model["initialization"], str):
        raise ValueError("candidate document has invalid model metadata")
    if not isinstance(model["steps"], list) or not model["steps"] or model["steps"] != sorted(set(model["steps"])) or not all(isinstance(step, int) for step in model["steps"]):
        raise ValueError("candidate document model steps must be sorted unique integers")
    if set(model["grid"]) != {"latitudeCount", "longitudeCount"} or not all(isinstance(model["grid"][key], int) and model["grid"][key] > 0 for key in model["grid"]):
        raise ValueError("candidate document has invalid grid metadata")
    selection = document["selection"]
    if set(selection) != {"marginC", "thresholdC", "dilationRings"} or not all(math.isfinite(selection[key]) for key in ("marginC", "thresholdC")) or selection["marginC"] < 0 or not isinstance(selection["dilationRings"], int) or selection["dilationRings"] < 0:
        raise ValueError("candidate document has invalid selection metadata")
    cell_fields = {"latitude", "longitude", "wetBulbC", "temperatureC", "dewPointC", "pressurePa", "peakStep", "peakTime"}
    def validate_cell(cell: Any) -> None:
        if not isinstance(cell, dict) or set(cell) != cell_fields:
            raise ValueError("candidate document has an invalid grid cell")
        if not all(isinstance(cell[key], (int, float)) and math.isfinite(cell[key]) for key in ("latitude", "longitude", "wetBulbC", "temperatureC", "dewPointC", "pressurePa")):
            raise ValueError("candidate document grid values must be finite")
        if not isinstance(cell["peakStep"], int) or not isinstance(cell["peakTime"], str) or not cell["peakTime"]:
            raise ValueError("candidate document grid peak metadata is invalid")
    validate_cell(document["globalLandMaximum"])
    if not isinstance(document["cities"], list):
        raise ValueError("candidate document cities must be an array")
    paths = [city.get("path") for city in document["cities"]]
    if paths != sorted(paths) or len(paths) != len(set(paths)):
        raise ValueError("candidate document cities must be uniquely sorted by path")
    for city in document["cities"]:
        if set(city) != set(CITY_FIELDS) | {"gridCell"}:
            raise ValueError("candidate document city has an invalid schema")
        validate_city_manifest([{key: city[key] for key in CITY_FIELDS}])
        validate_cell(city["gridCell"])


def discover_candidates_from_arrays(
    *,
    latitudes: np.ndarray,
    longitudes: np.ndarray,
    land_mask: np.ndarray,
    steps: dict[int, dict[str, Any]],
    cities: list[dict[str, Any]],
    model: dict[str, Any],
    margin_c: float = 2.0,
    threshold_c: float = 26.0,
    dilation_rings: int = 1,
) -> dict[str, Any]:
    """Select city candidates from validated, simultaneous native-grid fields."""
    latitudes, longitudes = _validate_axes(latitudes, longitudes)
    shape = (len(latitudes), len(longitudes))
    land = np.asarray(land_mask, dtype=float)
    if land.shape != shape or np.any(~np.isfinite(land)):
        raise ValueError("land mask must be finite and match the grid")
    if not steps:
        raise ValueError("at least one forecast step is required")
    if not all(math.isfinite(value) for value in (margin_c, threshold_c)) or margin_c < 0:
        raise ValueError("selection margin and threshold must be finite; margin must be nonnegative")
    cities = validate_city_manifest(cities)
    ordered_steps = sorted(steps)
    if model.get("steps") != ordered_steps or not isinstance(model.get("run"), str) or not model["run"]:
        raise ValueError("model must preserve a nonempty run and exactly the supplied sorted steps")

    maxima = np.full(shape, np.nan, dtype=float)
    peak_steps = np.full(shape, -1, dtype=int)
    peak_times = np.full(shape, "", dtype=object)
    peak_temperature = np.full(shape, np.nan, dtype=float)
    peak_dew_point = np.full(shape, np.nan, dtype=float)
    peak_pressure = np.full(shape, np.nan, dtype=float)

    for step in ordered_steps:
        fields = steps[step]
        if set(fields) != {"temperature_k", "dew_point_k", "pressure_pa", "valid_time"} or not isinstance(fields["valid_time"], str):
            raise ValueError(f"step {step} fields must contain simultaneous temperature, dew point, pressure, and valid time")
        temperature = np.asarray(fields["temperature_k"], dtype=float)
        dew_point = np.asarray(fields["dew_point_k"], dtype=float)
        pressure = np.asarray(fields["pressure_pa"], dtype=float)
        if temperature.shape != shape or dew_point.shape != shape or pressure.shape != shape:
            raise ValueError(f"step {step} grid fields must match the latitude/longitude axes")
        wet_bulb = calculate_warm_liquid_wet_bulb_celsius(pressure, temperature, dew_point)
        replace = np.isfinite(wet_bulb) & (~np.isfinite(maxima) | (wet_bulb > maxima))
        maxima[replace] = wet_bulb[replace]
        peak_steps[replace] = step
        peak_times[replace] = fields["valid_time"]
        peak_temperature[replace] = temperature[replace]
        peak_dew_point[replace] = dew_point[replace]
        peak_pressure[replace] = pressure[replace]

    land_candidates = (land >= 0.5) & np.isfinite(maxima)
    if not np.any(land_candidates):
        raise ValueError("no warm finite land grid cells are available for discovery")
    global_index = np.unravel_index(np.nanargmax(np.where(land_candidates, maxima, np.nan)), shape)
    global_maximum = float(maxima[global_index])
    initial_selection = land_candidates & ((maxima >= global_maximum - margin_c) | (maxima >= threshold_c))
    selected = dilate_selected_cells(initial_selection, dilation_rings)

    cell_cache: dict[tuple[int, int], dict[str, Any]] = {}
    candidate_cities = []
    for city in cities:
        row, column = nearest_grid_cell(latitudes, longitudes, city["latitude"], city["longitude"])
        if not selected[row, column]:
            continue
        key = (row, column)
        cell_cache.setdefault(
            key,
            _grid_cell_record(
                row, column, latitudes, longitudes, maxima, peak_steps, peak_times, peak_temperature, peak_dew_point, peak_pressure
            ),
        )
        candidate_cities.append({**city, "gridCell": cell_cache[key]})

    candidate_cities.sort(key=lambda city: city["path"])
    global_cell = _grid_cell_record(
        global_index[0], global_index[1], latitudes, longitudes, maxima, peak_steps, peak_times, peak_temperature, peak_dew_point, peak_pressure
    )
    document = {
        "schemaVersion": SCHEMA_VERSION,
        "method": METHOD,
        "methodVersion": METHOD_VERSION,
        "discoveryBoundary": DISCOVERY_BOUNDARY,
        "model": {
            "source": str(model.get("source", "ecmwf")),
            "initialization": model["run"],
            "steps": ordered_steps,
            "grid": {"latitudeCount": len(latitudes), "longitudeCount": len(longitudes)},
        },
        "selection": {"marginC": float(margin_c), "thresholdC": float(threshold_c), "dilationRings": dilation_rings},
        "globalLandMaximum": global_cell,
        "cities": candidate_cities,
    }
    validate_candidate_document(document)
    return document


def _eccodes_value(eccodes: Any, handle: Any, key: str) -> Any:
    try:
        return eccodes.codes_get(handle, key)
    except Exception as error:
        raise ValueError(f"GRIB message is missing required key {key}") from error


def _iso_time(date_value: int, time_value: int) -> str:
    date_text, time_text = str(date_value), f"{int(time_value):04d}"
    return dt.datetime.strptime(date_text + time_text, "%Y%m%d%H%M").replace(tzinfo=dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _decode_grib_messages(path: Path) -> list[dict[str, Any]]:
    try:
        import eccodes
    except ImportError as error:
        raise SystemExit("ecCodes Python bindings are required; install requirements/global-hotspots.txt") from error
    messages = []
    with path.open("rb") as stream:
        while handle := eccodes.codes_grib_new_from_file(stream):
            try:
                short_name = str(_eccodes_value(eccodes, handle, "shortName"))
                ni, nj = int(_eccodes_value(eccodes, handle, "Ni")), int(_eccodes_value(eccodes, handle, "Nj"))
                if _eccodes_value(eccodes, handle, "gridType") != "regular_ll":
                    raise ValueError("only regular_ll ECMWF grids are supported")
                values = np.asarray(eccodes.codes_get_array(handle, "values"), dtype=float)
                latitudes = np.asarray(eccodes.codes_get_array(handle, "latitudes"), dtype=float).reshape(nj, ni)
                longitudes = np.asarray(eccodes.codes_get_array(handle, "longitudes"), dtype=float).reshape(nj, ni)
                if values.size != ni * nj or not np.allclose(latitudes, latitudes[:, :1]) or not np.allclose(longitudes, longitudes[:1, :]):
                    raise ValueError("GRIB message is not a rectilinear regular grid")
                messages.append({
                    "short_name": short_name,
                    "step": int(_eccodes_value(eccodes, handle, "step")),
                    "units": str(_eccodes_value(eccodes, handle, "units")),
                    "values": values.reshape(nj, ni),
                    "latitudes": latitudes[:, 0],
                    "longitudes": longitudes[0, :],
                    "initialization": _iso_time(_eccodes_value(eccodes, handle, "dataDate"), _eccodes_value(eccodes, handle, "dataTime")),
                    "valid_time": _iso_time(_eccodes_value(eccodes, handle, "validityDate"), _eccodes_value(eccodes, handle, "validityTime")),
                })
            finally:
                eccodes.codes_release(handle)
    if not messages:
        raise ValueError(f"GRIB file has no messages: {path}")
    return messages


def load_grib_inputs(forecast_path: Path, land_mask_path: Path, expected_steps: tuple[int, ...]) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[int, dict[str, Any]], str]:
    forecast = _decode_grib_messages(forecast_path)
    fields_by_step: dict[int, dict[str, Any]] = {}
    axes: tuple[np.ndarray, np.ndarray] | None = None
    initializations: set[str] = set()
    expected_units = {"2t": "K", "2d": "K", "sp": "Pa"}
    name_map = {"2t": "temperature_k", "2d": "dew_point_k", "sp": "pressure_pa"}
    for message in forecast:
        short_name = message["short_name"]
        if short_name not in name_map:
            raise ValueError(f"unexpected forecast shortName {short_name}")
        if message["units"] != expected_units[short_name] or message["step"] not in expected_steps:
            raise ValueError(f"unexpected units or step for {short_name}")
        current_axes = (message["latitudes"], message["longitudes"])
        if axes is None:
            axes = current_axes
        elif not (np.array_equal(axes[0], current_axes[0]) and np.array_equal(axes[1], current_axes[1])):
            raise ValueError("forecast GRIB messages have mismatched grid coordinates")
        initializations.add(message["initialization"])
        fields = fields_by_step.setdefault(message["step"], {"valid_time": message["valid_time"]})
        key = name_map[short_name]
        if key in fields or fields["valid_time"] != message["valid_time"]:
            raise ValueError(f"duplicate or non-simultaneous GRIB field at step {message['step']}")
        fields[key] = message["values"]
    if set(fields_by_step) != set(expected_steps) or any(set(fields) != {"temperature_k", "dew_point_k", "pressure_pa", "valid_time"} for fields in fields_by_step.values()):
        raise ValueError("forecast GRIB must include 2t, 2d, and sp for every requested step")
    if len(initializations) != 1 or axes is None:
        raise ValueError("forecast GRIB messages must share one model initialization")

    masks = _decode_grib_messages(land_mask_path)
    if len(masks) != 1 or masks[0]["short_name"] != "lsm" or masks[0]["units"] not in {"(0 - 1)", "0 - 1"}:
        raise ValueError("land-mask GRIB must contain exactly one lsm message in (0 - 1) units")
    if not (np.array_equal(axes[0], masks[0]["latitudes"]) and np.array_equal(axes[1], masks[0]["longitudes"])):
        raise ValueError("land-mask GRIB grid does not match forecast grid")
    return axes[0], axes[1], masks[0]["values"], fields_by_step, initializations.pop()


def load_npz_inputs(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[int, dict[str, Any]]]:
    with np.load(path) as data:
        required = {"latitudes", "longitudes", "land_mask"}
        if not required.issubset(data.files):
            raise ValueError("NPZ fixture must contain latitudes, longitudes, and land_mask")
        patterns = {}
        for name in data.files:
            matched = re.fullmatch(r"step_(\d+)_(temperature_k|dew_point_k|pressure_pa)", name)
            if matched:
                patterns.setdefault(int(matched.group(1)), {})[matched.group(2)] = data[name]
        if not patterns or any(set(fields) != {"temperature_k", "dew_point_k", "pressure_pa"} for fields in patterns.values()):
            raise ValueError("NPZ fixture must contain all three fields for every step")
        steps = {
            step: {**fields, "valid_time": f"step-{step}"}
            for step, fields in patterns.items()
        }
        return data["latitudes"], data["longitudes"], data["land_mask"], steps


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--forecast-grib", type=Path)
    input_group.add_argument("--arrays-npz", type=Path, help="synthetic test fixture only; never a production source")
    parser.add_argument("--land-mask-grib", type=Path)
    parser.add_argument("--cities", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run", help="required with --arrays-npz; ISO-like model initialization identifier")
    parser.add_argument("--steps", default=",".join(map(str, DEFAULT_STEPS)))
    parser.add_argument("--margin-c", type=float, default=2.0)
    parser.add_argument("--threshold-c", type=float, default=26.0)
    parser.add_argument("--dilation-rings", type=int, default=1)
    args = parser.parse_args(argv)
    expected_steps = tuple(int(part) for part in args.steps.split(",") if part)
    if not expected_steps or tuple(sorted(set(expected_steps))) != expected_steps:
        parser.error("--steps must be a sorted, unique comma-separated list")
    cities = json.loads(args.cities.read_text(encoding="utf-8"))
    if args.arrays_npz:
        if not args.run:
            parser.error("--run is required with --arrays-npz")
        latitudes, longitudes, land_mask, steps = load_npz_inputs(args.arrays_npz)
        if tuple(sorted(steps)) != expected_steps:
            parser.error("--steps must exactly match NPZ fixture steps")
        model_run = args.run
    else:
        if not args.land_mask_grib:
            parser.error("--land-mask-grib is required with --forecast-grib")
        latitudes, longitudes, land_mask, steps, model_run = load_grib_inputs(args.forecast_grib, args.land_mask_grib, expected_steps)
        if args.run and args.run != model_run:
            parser.error("--run does not match GRIB model initialization")
    document = discover_candidates_from_arrays(
        latitudes=latitudes,
        longitudes=longitudes,
        land_mask=land_mask,
        steps=steps,
        cities=cities,
        model={"source": "ecmwf-ifs-0.25", "run": model_run, "steps": sorted(steps)},
        margin_c=args.margin_c,
        threshold_c=args.threshold_c,
        dilation_rings=args.dilation_rings,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
