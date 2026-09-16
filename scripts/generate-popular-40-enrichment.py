#!/usr/bin/env python3
"""Deterministically derive the sanitized Popular-40 climate context artifact.

Private GeoNames, Beck and NASA POWER inputs are required only to regenerate the
committed derived JSON. They must stay outside this repository.
"""
import argparse
import hashlib
import json
import math
import zipfile
from collections import Counter
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from urllib.parse import parse_qs, urlparse

LABELS = {
    1: ("Af", "Tropical rainforest"), 2: ("Am", "Tropical monsoon"), 3: ("Aw", "Tropical savanna"),
    4: ("BWh", "Hot desert"), 5: ("BWk", "Cold desert"), 6: ("BSh", "Hot steppe"), 7: ("BSk", "Cold steppe"),
    8: ("Csa", "Temperate, dry summer, hot summer"), 9: ("Csb", "Temperate, dry summer, warm summer"),
    10: ("Csc", "Temperate, dry summer, cold summer"), 11: ("Cwa", "Temperate, dry winter, hot summer"),
    12: ("Cwb", "Temperate, dry winter, warm summer"), 13: ("Cwc", "Temperate, dry winter, cold summer"),
    14: ("Cfa", "Temperate, no dry season, hot summer"), 15: ("Cfb", "Temperate, no dry season, warm summer"),
    16: ("Cfc", "Temperate, no dry season, cold summer"), 17: ("Dsa", "Cold, dry summer, hot summer"),
    18: ("Dsb", "Cold, dry summer, warm summer"), 19: ("Dsc", "Cold, dry summer, cold summer"),
    20: ("Dsd", "Cold, dry summer, very cold winter"), 21: ("Dwa", "Cold, dry winter, hot summer"),
    22: ("Dwb", "Cold, dry winter, warm summer"), 23: ("Dwc", "Cold, dry winter, cold summer"),
    24: ("Dwd", "Cold, dry winter, very cold winter"), 25: ("Dfa", "Cold, no dry season, hot summer"),
    26: ("Dfb", "Cold, no dry season, warm summer"), 27: ("Dfc", "Cold, no dry season, cold summer"),
    28: ("Dfd", "Cold, no dry season, very cold winter"), 29: ("ET", "Polar tundra"), 30: ("EF", "Polar frost"),
}
MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
GEONAMES_SHA256 = "b0d39ebf8d1935d425f3efc1d90c881bdc83d7567ca6db1232973eaebc51e2e2"
BECK_ZIP_SHA256 = "bb84453d4541f1a0bc5a804ead83f483c19ce70f16a5197f6d3a7b6a63e65562"
BECK_RASTER_SHA256 = "2130f0071dfb2904947d8ec3a0d807fac71004df76e769262004f1602e4d6a13"
BECK_LEGEND_SHA256 = "2ede2ad270a036cc11c31705a2c1dbf0314a8cf011fc972cd4a9665e3339e5e5"

def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

def geonames_by_id(source):
    result = {}
    with zipfile.ZipFile(source) as archive:
        name = next(item for item in archive.namelist() if item.endswith("cities1000.txt"))
        with archive.open(name) as handle:
            for line in handle:
                fields = line.decode("utf-8").rstrip("\n").split("\t")
                result[int(fields[0])] = {
                    "latitude": float(fields[4]), "longitude": float(fields[5]),
                    "elevationM": int(fields[15]) if fields[15] else None,
                    "demM": int(fields[16]) if fields[16] else None,
                    "timezone": fields[17],
                }
    return result

def raster_sample(dataset, longitude, latitude):
    row, col = dataset.index(longitude, latitude)
    window = dataset.read(1, window=((max(row - 1, 0), min(row + 2, dataset.height)), (max(col - 1, 0), min(col + 2, dataset.width))))
    values = [int(value) for value in window.flatten() if int(value) in LABELS]
    if not values:
        raise ValueError("No valid Köppen-Geiger values in 3x3 sample")
    center = int(dataset.read(1, window=((row, row + 1), (col, col + 1)))[0, 0])
    if center not in LABELS:
        raise ValueError("No valid Köppen-Geiger center value")
    counts = Counter(values)
    modal, count = min(counts.items(), key=lambda item: (-item[1], item[0]))
    return {"code": LABELS[center][0], "label": LABELS[center][1], "modalCode": LABELS[modal][0], "modalShare": round(count / len(values), 4)}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--map", default="scripts/popular-40-geonames-map.json")
    parser.add_argument("--geonames", required=True)
    parser.add_argument("--beck-zip", required=True)
    parser.add_argument("--raster", required=True)
    parser.add_argument("--legend", required=True)
    parser.add_argument("--nasa-dir", required=True)
    parser.add_argument("--tier1", default="scripts/tier1-city-manifest.json")
    parser.add_argument("--out", default="data/popular-40-enrichment.v1.json")
    args = parser.parse_args()
    reviewed = json.loads(Path(args.map).read_text())
    if reviewed.get("schemaVersion") != 1 or len(reviewed.get("cities", [])) != 40 or len(reviewed.get("reviewCohort", [])) != 10:
        raise ValueError("Reviewed map must contain exactly 40 cities")
    if len({item["path"] for item in reviewed["cities"]}) != 40:
        raise ValueError("Reviewed map paths must be unique")
    if len(set(reviewed["reviewCohort"])) != 10 or not set(reviewed["reviewCohort"]) <= {item["path"] for item in reviewed["cities"]}:
        raise ValueError("Invalid ten-city review cohort")
    tier1 = json.loads(Path(args.tier1).read_text())
    popular_paths = {item["path"] for item in tier1.get("cities", []) if item.get("popular") is True}
    if popular_paths != {item["path"] for item in reviewed["cities"]}:
        raise ValueError("Reviewed map must exactly equal the Popular-40 path set")
    if sha256(args.geonames) != GEONAMES_SHA256 or sha256(args.beck_zip) != BECK_ZIP_SHA256:
        raise ValueError("Source archive checksum mismatch")
    if sha256(args.raster) != BECK_RASTER_SHA256 or sha256(args.legend) != BECK_LEGEND_SHA256:
        raise ValueError("Extracted Beck source checksum mismatch")
    records = geonames_by_id(args.geonames)
    nasa_dir = Path(args.nasa_dir)
    lock_path = nasa_dir / "source-lock.json"
    lock = json.loads(lock_path.read_text())
    locked = {item["path"]: item for item in lock["entries"]}
    import rasterio
    cities = []
    with rasterio.open(args.raster) as dataset:
        for reviewed_city in sorted(reviewed["cities"], key=lambda item: item["path"]):
            path_name, geoname_id = reviewed_city["path"], reviewed_city["geonameId"]
            record = records.get(geoname_id)
            entry = locked.get(path_name)
            if not record or not entry or entry["geonameId"] != geoname_id:
                raise ValueError(f"Missing reviewed source for {path_name}")
            if round(record["latitude"], 5) != reviewed_city["latitude"] or round(record["longitude"], 5) != reviewed_city["longitude"]:
                raise ValueError(f"GeoNames identity coordinate mismatch for {path_name}")
            if sha256(nasa_dir / f"{geoname_id}.json") != entry["sha256"]:
                raise ValueError(f"NASA checksum mismatch for {path_name}")
            request_query = parse_qs(urlparse(entry["url"]).query)
            if float(request_query["latitude"][0]) != reviewed_city["latitude"] or float(request_query["longitude"][0]) != reviewed_city["longitude"]:
                raise ValueError(f"NASA request coordinate mismatch for {path_name}")
            raw = json.loads((nasa_dir / f"{geoname_id}.json").read_text())
            header = raw["header"]
            values = raw["properties"]["parameter"]["T2MWET"]
            monthly = [values.get(month) for month in MONTHS]
            if (header.get("time_standard") != "LST" or header.get("api", {}).get("version") != entry["apiVersion"]
                    or raw.get("parameters", {}).get("T2MWET", {}).get("units") != "C"
                    or any(not isinstance(value, (int, float)) or not math.isfinite(value) or value == -999 or value < -100 or value > 60 for value in monthly)):
                raise ValueError(f"Invalid NASA monthly values for {path_name}")
            peak = max(monthly)
            rounded_monthly = [float(Decimal(str(value)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)) for value in monthly]
            elevation = record["elevationM"] if record["elevationM"] is not None else record["demM"]
            elevation_source = "elevation" if record["elevationM"] is not None else ("dem" if record["demM"] is not None else None)
            cities.append({
                "path": path_name,
                "geonames": {"id": geoname_id, "timezone": record["timezone"], "elevationM": elevation, "elevationSource": elevation_source},
                "koppenGeiger": raster_sample(dataset, record["longitude"], record["latitude"]),
                "nasaPower": {
                    "monthlyC": rounded_monthly,
                    "peakMonths": [index + 1 for index, value in enumerate(monthly) if value == peak],
                    "requestUrl": entry["url"],
                    "responseSha256": entry["sha256"],
                },
            })
    output = {
        "schemaVersion": 1,
        "dataVersion": "popular-40-2026-09-16",
        "provenance": {
            "geonames": {"snapshot": "2026-09-16", "file": "cities1000.zip", "sha256": sha256(args.geonames), "license": "CC BY 4.0", "url": "https://download.geonames.org/export/dump/cities1000.zip"},
            "beck": {"version": "v3", "period": "1991-2020", "file": "koppen_geiger_tif.zip", "sha256": sha256(args.beck_zip), "rasterSha256": sha256(args.raster), "legendSha256": sha256(args.legend), "method": "center plus 3x3 modal share", "license": "CC BY 4.0", "url": "https://doi.org/10.6084/m9.figshare.21789074.v3"},
            "nasaPower": {"accessedDate": lock["accessedDate"], "apiVersion": lock["entries"][0]["apiVersion"], "parameter": "T2MWET", "period": "1991-2020", "timeStandard": "LST", "sourceLockSha256": sha256(lock_path)},
        },
        "reviewCohort": sorted(reviewed["reviewCohort"]),
        "cities": cities,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(output, indent=2) + "\n")

if __name__ == "__main__":
    main()
