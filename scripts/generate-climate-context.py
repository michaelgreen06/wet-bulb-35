#!/usr/bin/env python3
"""Deterministically derive all-location climate context from pinned private sources.

Köppen-Geiger comes from the pinned Beck et al. v3 1991-2020 raster. NASA POWER
monthly mean T2MWET comes from one locked point-API response per native MERRA-2
cell (see fetch-nasa-power-cells.py). Raw inputs stay outside this repository.
Without --nasa-dir the artifact carries Köppen only and marks NASA as pending.
"""
import argparse
import hashlib
import json
import math
from collections import Counter
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BECK_ZIP_SHA256 = "bb84453d4541f1a0bc5a804ead83f483c19ce70f16a5197f6d3a7b6a63e65562"
BECK_RASTER_SHA256 = "2130f0071dfb2904947d8ec3a0d807fac71004df76e769262004f1602e4d6a13"
BECK_LEGEND_SHA256 = "2ede2ad270a036cc11c31705a2c1dbf0314a8cf011fc972cd4a9665e3339e5e5"
KOPPEN_CODES = (None, "Af", "Am", "Aw", "BWh", "BWk", "BSh", "BSk", "Csa", "Csb", "Csc", "Cwa", "Cwb", "Cwc",
                "Cfa", "Cfb", "Cfc", "Dsa", "Dsb", "Dsc", "Dsd", "Dwa", "Dwb", "Dwc", "Dwd", "Dfa", "Dfb", "Dfc",
                "Dfd", "ET", "EF")
MIN_MODAL_SHARE = 0.67
MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
POWER_RANGE = "30-year Meteorological and Solar Monthly & Annual Climatologies (January 1991 - December 2020)"
POWER_POINT_URL = "https://power.larc.nasa.gov/api/temporal/climatology/point"
# MERRA-2 native grid used by POWER for T2MWET; point requests return the nearest cell.
LAT_STEP, LON_STEP, LON_CELLS = Decimal("0.5"), Decimal("0.625"), 576
MIN_VALIDATION_SAMPLES = 200
TENTH = Decimal("0.1")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def route_path(row):
    return f"/wetbulb-temperature/{row['countrySlug']}/{row['stateSlug']}/{row['outputCitySlug']}/"


def coordinate(value):
    """Inventory coordinates have at most five decimals; reject anything that would round ambiguously."""
    number = float(value)
    if not math.isfinite(number) or float(f"{number:.5f}") != number:
        raise ValueError("Inventory coordinate is not a finite five-decimal value")
    return Decimal(f"{number:.5f}")


def load_routes(route_file, expected_count):
    routes = json.loads(Path(route_file).read_text())
    if routes.get("v") != 1 or not isinstance(routes.get("rows"), list):
        raise ValueError("Invalid route index")
    rows = {}
    for row in routes["rows"]:
        path = route_path(row)
        if path in rows:
            raise ValueError("Duplicate canonical route")
        rows[path] = (coordinate(row["latitude"]), coordinate(row["longitude"]))
    if len(rows) != expected_count:
        raise ValueError("The canonical route inventory changed")
    return dict(sorted(rows.items()))


def inventory_sha256(routes):
    """Fingerprint of path plus mapped coordinates, recomputed by the JS validator."""
    lines = "".join(f"{path}\t{lat:.5f}\t{lon:.5f}\n" for path, (lat, lon) in sorted(routes.items()))
    return hashlib.sha256(lines.encode()).hexdigest()


def merra2_cell(lat, lon):
    """Return (row, column) of the nearest MERRA-2 cell centre, or None on an exact cell-edge tie."""
    row_position, column_position = (lat + 90) / LAT_STEP, (lon + 180) / LON_STEP
    if row_position % 1 == Decimal("0.5") or column_position % 1 == Decimal("0.5"):
        return None
    row = int(row_position.to_integral_value(rounding=ROUND_HALF_UP))
    column = int(column_position.to_integral_value(rounding=ROUND_HALF_UP)) % LON_CELLS
    return row, column


def cell_center(cell):
    row, column = cell
    return Decimal(row) * LAT_STEP - 90, Decimal(column) * LON_STEP - 180


def power_url(lat, lon):
    return (f"{POWER_POINT_URL}?parameters=T2MWET&community=RE&longitude={lon:.5f}&latitude={lat:.5f}"
            "&format=JSON&start=1991&end=2020")


def cell_key(cell):
    return f"{cell[0]}_{cell[1]}"


def classify_koppen(window, center):
    """Pilot rule: centre class must equal the 3x3 modal class with share >= 0.67; NoData neighbours ignored."""
    if center not in range(1, 31):
        return None, "centerNoData"
    values = [int(value) for value in window if 1 <= int(value) <= 30]
    counts = Counter(values)
    modal, count = min(counts.items(), key=lambda item: (-item[1], item[0]))
    if modal != center:
        return None, "centerNotModal"
    if count / len(values) < MIN_MODAL_SHARE:
        return None, "lowModalShare"
    return center, None


def sample_koppen(band, transform_index, height, width, lat, lon):
    row, col = transform_index(float(lon), float(lat))
    if not (0 <= row < height and 0 <= col < width):
        return None, "outsideRaster"
    window = band[max(row - 1, 0):row + 2, max(col - 1, 0):col + 2].ravel()
    return classify_koppen(window, int(band[row, col]))


def validated_monthly(raw, api_version):
    header = raw.get("header", {})
    values = raw.get("properties", {}).get("parameter", {}).get("T2MWET", {})
    monthly = [values.get(month) for month in MONTHS]
    if (header.get("time_standard") != "LST" or header.get("range") != POWER_RANGE
            or header.get("api", {}).get("version") != api_version
            or set(header.get("sources", [])) != {"MERRA2", "POWER"}
            or header.get("fill_value") != -999.0
            or raw.get("parameters", {}).get("T2MWET", {}).get("units") != "C"):
        raise ValueError("NASA POWER response contract changed")
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
           or value == -999 or value < -100 or value > 60 for value in monthly):
        return None
    return monthly


def expected_query(lat, lon):
    return {"parameters": ["T2MWET"], "community": ["RE"], "longitude": [f"{lon:.5f}"], "latitude": [f"{lat:.5f}"],
            "format": ["JSON"], "start": ["1991"], "end": ["2020"]}


def check_locked_url(url, lat, lon):
    parsed = urlparse(url)
    if f"{parsed.scheme}://{parsed.netloc}{parsed.path}" != POWER_POINT_URL or parse_qs(parsed.query, keep_blank_values=True) != expected_query(lat, lon):
        raise ValueError("NASA request contract mismatch")


def compact_cell(monthly):
    """Twelve tenths-of-a-degree integers (half-up) plus a peak-month bitmask from unrounded values."""
    tenths = [int((Decimal(str(value)) / TENTH).quantize(Decimal(1), rounding=ROUND_HALF_UP)) for value in monthly]
    peak = max(monthly)
    return tenths + [sum(1 << index for index, value in enumerate(monthly) if value == peak)]


def load_nasa(nasa_dir, routes):
    """Load locked per-cell responses and route-coordinate validation samples."""
    nasa_dir = Path(nasa_dir)
    lock_path = nasa_dir / "source-lock.json"
    lock = json.loads(lock_path.read_text())
    if lock.get("schemaVersion") != 1 or not isinstance(lock.get("cells"), list) or not isinstance(lock.get("validation"), list):
        raise ValueError("Invalid NASA POWER source lock")
    versions = {entry["apiVersion"] for entry in lock["cells"] + lock["validation"]}
    if len(versions) != 1:
        raise ValueError("NASA POWER responses span multiple API versions; refetch required")
    api_version = versions.pop()
    cells = {}
    for entry in lock["cells"]:
        cell = tuple(int(part) for part in entry["cell"].split("_"))
        lat, lon = cell_center(cell)
        check_locked_url(entry["url"], lat, lon)
        response = nasa_dir / "cells" / f"{entry['cell']}.json"
        if sha256(response) != entry["sha256"]:
            raise ValueError(f"NASA checksum mismatch for cell {entry['cell']}")
        if cell in cells:
            raise ValueError("Duplicate NASA cell")
        cells[cell] = validated_monthly(json.loads(response.read_text()), api_version)
    validated = 0
    for entry in lock["validation"]:
        lat, lon = routes[entry["path"]]
        check_locked_url(entry["url"], lat, lon)
        response = nasa_dir / "validation" / f"{entry['sha256']}.json"
        if sha256(response) != entry["sha256"]:
            raise ValueError("NASA validation checksum mismatch")
        cell = merra2_cell(lat, lon)
        if cell is None or cell not in cells:
            raise ValueError("Validation sample does not map to a fetched cell")
        if validated_monthly(json.loads(response.read_text()), api_version) != cells[cell]:
            raise ValueError(f"Route-coordinate response differs from its MERRA-2 cell for {entry['path']}")
        validated += 1
    if validated < MIN_VALIDATION_SAMPLES:
        raise ValueError("Too few route-coordinate validation samples")
    provenance = {"accessedDate": lock["accessedDate"], "apiVersion": api_version, "parameter": "T2MWET",
                  "period": "1991-2020", "timeStandard": "LST", "grid": "MERRA-2 0.5x0.625 nearest cell",
                  "cells": len(cells), "validationSamples": validated, "sourceLockSha256": sha256(lock_path)}
    return cells, provenance


def check_popular_parity(by_path, cell_table, popular_file):
    """The committed, separately reviewed Popular-40 records must be reproduced exactly."""
    popular = json.loads(Path(popular_file).read_text())["cities"]
    if len(popular) != 40:
        raise ValueError("Popular-40 artifact changed")
    for city in popular:
        koppen, cell = by_path[city["path"]]
        if KOPPEN_CODES[koppen or 0] != city["koppenGeiger"]["code"]:
            raise ValueError(f"Köppen parity failure for {city['path']}")
        if cell is not None:
            values = cell_table[cell]
            peaks = [month for month in range(1, 13) if values[12] & (1 << (month - 1))]
            if [value / 10 for value in values[:12]] != city["nasaPower"]["monthlyC"] or peaks != city["nasaPower"]["peakMonths"]:
                raise ValueError(f"NASA POWER parity failure for {city['path']}")


def generate(routes, band, transform_index, height, width, beck_provenance, nasa=None, popular_file=None):
    nasa_cells, nasa_provenance = nasa if nasa else ({}, None)
    counts = Counter()
    exclusions = {"koppen": {}, "nasaPower": {}}
    cell_ids, cell_table, by_path = {}, [], {}
    for path, (lat, lon) in routes.items():
        koppen, reason = sample_koppen(band, transform_index, height, width, lat, lon)
        if reason:
            exclusions["koppen"].setdefault(reason, []).append(path)
        cell, cell_index = merra2_cell(lat, lon), None
        if cell is None:
            exclusions["nasaPower"].setdefault("cellEdgeTie", []).append(path)
        elif nasa_provenance is None:
            counts["nasaPowerPending"] += 1
        elif cell not in nasa_cells:
            raise ValueError("NASA source lock is missing a required MERRA-2 cell")
        elif nasa_cells[cell] is None:
            exclusions["nasaPower"].setdefault("fillOrInvalidValue", []).append(path)
        else:
            if cell not in cell_ids:
                cell_ids[cell] = len(cell_table)
                cell_table.append(compact_cell(nasa_cells[cell]))
            cell_index = cell_ids[cell]
        by_path[path] = [koppen, cell_index]
        counts["koppen"] += koppen is not None
        counts["nasaPower"] += cell_index is not None
        counts["both"] += koppen is not None and cell_index is not None
        counts["either"] += koppen is not None or cell_index is not None
    if popular_file:
        check_popular_parity(by_path, cell_table, popular_file)
    for group in exclusions.values():
        for reason, paths in group.items():
            counts[f"{reason}"] += len(paths)
    counts["routes"] = len(routes)
    counts["nasaPowerCells"] = len(cell_table)
    return {
        "v": 1,
        "inventory": {"routes": len(routes), "sha256": inventory_sha256(routes)},
        "sources": {"beck": beck_provenance, "nasaPower": nasa_provenance},
        "counts": dict(sorted(counts.items())),
        "exclusions": {name: dict(sorted(group.items())) for name, group in exclusions.items()},
        "cells": cell_table,
        "byPath": by_path,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--route-index", required=True, help="output of scripts/probe-location-route-identity.mjs")
    parser.add_argument("--beck-zip", required=True)
    parser.add_argument("--raster", required=True)
    parser.add_argument("--legend", required=True)
    parser.add_argument("--nasa-dir", help="locked per-cell NASA POWER snapshot; omit to mark NASA as pending")
    parser.add_argument("--popular", default="data/popular-40-enrichment.v1.json")
    parser.add_argument("--expected-count", type=int, default=130686)
    parser.add_argument("--output", default="data/climate-context.v1.json")
    args = parser.parse_args()
    if (sha256(args.beck_zip), sha256(args.raster), sha256(args.legend)) != (BECK_ZIP_SHA256, BECK_RASTER_SHA256, BECK_LEGEND_SHA256):
        raise ValueError("Beck source checksum mismatch")
    routes = load_routes(args.route_index, args.expected_count)
    nasa = load_nasa(args.nasa_dir, routes) if args.nasa_dir else None
    import rasterio
    with rasterio.open(args.raster) as dataset:
        if str(dataset.crs) != "EPSG:4326" or (dataset.width, dataset.height) != (43200, 21600):
            raise ValueError("Unexpected Beck raster grid")
        band = dataset.read(1)
        beck = {"version": "v3", "period": "1991-2020", "file": "koppen_geiger_tif.zip", "sha256": BECK_ZIP_SHA256,
                "rasterSha256": BECK_RASTER_SHA256, "legendSha256": BECK_LEGEND_SHA256,
                "method": "center plus 3x3 modal share", "minModalShare": MIN_MODAL_SHARE, "license": "CC BY 4.0",
                "url": "https://doi.org/10.6084/m9.figshare.21789074.v3"}
        artifact = generate(routes, band, dataset.index, dataset.height, dataset.width, beck, nasa, args.popular)
    serialized = json.dumps(artifact, separators=(",", ":"), ensure_ascii=False) + "\n"
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(serialized)
    print(json.dumps({"counts": artifact["counts"], "bytes": len(serialized.encode()),
                      "sha256": hashlib.sha256(serialized.encode()).hexdigest()}))


if __name__ == "__main__":
    main()
