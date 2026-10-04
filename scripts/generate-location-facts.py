#!/usr/bin/env python3
"""Generate public, path-keyed facts from private, pinned GeoNames inputs."""
import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import pathlib
import zipfile
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

PINNED_SOURCE_SHA256 = "0ba3eedb8b7c04f2b0fa9396e8c5f8746c432c76c4f247f63cc9fd63f39ceec5"
SNAPSHOT_DATE = "2026-09-29"


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def route_path(row):
    return f"/wetbulb-temperature/{row['countrySlug']}/{row['stateSlug']}/{row['outputCitySlug']}/"


def distance_km(lat1, lon1, lat2, lon2):
    lat1, lat2 = math.radians(float(lat1)), math.radians(float(lat2))
    diff_lat, diff_lon = lat2 - lat1, math.radians(float(lon2) - float(lon1))
    a = math.sin(diff_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(diff_lon / 2) ** 2
    return 12742 * math.asin(min(1, math.sqrt(a)))


def generate(source, identity_file, route_file, expected_sha=PINNED_SOURCE_SHA256, snapshot_date=SNAPSHOT_DATE, expected_count=130686):
    dt.date.fromisoformat(snapshot_date)
    sha = digest(source)
    if sha != expected_sha:
        raise ValueError("GeoNames source checksum changed; a reviewed refresh is required")
    identity = json.loads(identity_file.read_text())
    routes = json.loads(route_file.read_text())
    if not isinstance(identity.get("rows"), list) or routes.get("v") != 1 or not isinstance(routes.get("rows"), list):
        raise ValueError("Invalid identity or route index")
    route_rows = {route_path(row): row for row in routes["rows"]}
    identities = {row["path"]: row for row in identity["rows"]}
    if len(route_rows) != expected_count or len(identities) != expected_count or route_rows.keys() != identities.keys():
        raise ValueError("The pinned canonical route inventory changed")
    if identity.get("sourceSha256") != sha:
        raise ValueError("Identity index is not from the exact GeoNames source")
    ids = collections.Counter(row["id"] for row in identity["rows"] if row.get("id") is not None)
    needed = {str(value) for value in ids}
    source_records = {}
    with zipfile.ZipFile(source) as archive:
        if archive.namelist() != ["cities1000.txt"]:
            raise ValueError("Unexpected GeoNames archive members")
        with archive.open("cities1000.txt") as stream:
            for raw in stream:
                fields = raw.decode("utf-8").rstrip("\n").split("\t")
                if len(fields) < 19:
                    raise ValueError("Invalid GeoNames source row")
                if fields[0] in needed:
                    if fields[0] in source_records:
                        raise ValueError("Duplicate GeoNames ID in source")
                    source_records[fields[0]] = fields
    if source_records.keys() != needed:
        raise ValueError("Identity index references absent source IDs")
    counts = collections.Counter()
    by_path = {}
    for path in sorted(route_rows):
        row, match = route_rows[path], identities[path]
        source_id = match.get("id")
        if source_id is None:
            by_path[path] = None
            counts["unmatched"] += 1
            continue
        if ids[source_id] != 1:
            by_path[path] = None
            counts["ambiguousIdentity"] += 1
            continue
        fields = source_records[str(source_id)]
        if match.get("timeZone") != fields[17]:
            raise ValueError("Identity timezone differs from source timezone")
        if distance_km(row["latitude"], row["longitude"], fields[4], fields[5]) > 3:
            raise ValueError("Identity location is farther than reviewed matching bound")
        try:
            ZoneInfo(fields[17])
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("GeoNames timezone is not an IANA timezone") from None
        population = int(fields[14]) if fields[14] else 0
        if population < 0:
            raise ValueError("Invalid population")
        population = population or None
        if fields[15]:
            elevation, elevation_source = int(fields[15]), "elevation"
        elif fields[16]:
            elevation, elevation_source = int(fields[16]), "dem"
        else:
            elevation, elevation_source = None, None
        if elevation == -9999 and elevation_source == "dem":
            elevation, elevation_source = None, None
            counts["elevationNoData"] += 1
        elif elevation is not None and not -1000 <= elevation <= 9000:
            raise ValueError("Invalid elevation")
        by_path[path] = [source_id, population, fields[17], elevation, elevation_source]
        counts["matched"] += 1
        counts["population"] += population is not None
        counts["timezone"] += 1
        counts["elevation"] += elevation is not None
    counts["routes"] = expected_count
    return {
        "v": 1,
        "source": {"dataset": "GeoNames cities1000", "snapshot": snapshot_date, "sha256": sha,
                   "license": "CC BY 4.0", "populationReferenceYear": None},
        "counts": dict(sorted(counts.items())),
        "byPath": by_path,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=pathlib.Path)
    parser.add_argument("--identity-index", required=True, type=pathlib.Path)
    parser.add_argument("--route-index", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--expected-source-sha", default=PINNED_SOURCE_SHA256)
    parser.add_argument("--snapshot-date", default=SNAPSHOT_DATE)
    parser.add_argument("--expected-count", type=int, default=130686)
    args = parser.parse_args()
    data = generate(args.source, args.identity_index, args.route_index, args.expected_source_sha,
                    args.snapshot_date, args.expected_count)
    serialized = json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(serialized)
    print(json.dumps({"counts": data["counts"], "bytes": len(serialized.encode())}))


if __name__ == "__main__":
    main()
