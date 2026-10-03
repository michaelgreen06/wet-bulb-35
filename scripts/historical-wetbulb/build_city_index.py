#!/usr/bin/env python3
"""Offline, conservative GeoNames identity/timezone join for frozen canonical routes.

Never use this output to regenerate URLs or infer local climate grid identity.
Source archive and full report remain private; only reviewed derived rows are publishable.
"""
import argparse
import csv
import hashlib
import json
import math
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

CELL_DEG = 0.05
MATCH_RADIUS_KM = 3.0
AMBIGUITY_KM = 0.2


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def geonames_grid(source):
    cells = defaultdict(list)
    with zipfile.ZipFile(source) as archive:
        if archive.namelist() != ['cities1000.txt']:
            raise ValueError('Unexpected GeoNames archive schema')
        with archive.open('cities1000.txt') as handle:
            for raw in handle:
                f = raw.decode('utf-8').rstrip('\n').split('\t')
                if len(f) != 19:
                    raise ValueError('Unexpected GeoNames record')
                lat, lon = float(f[4]), float(f[5])
                if not math.isfinite(lat) or not math.isfinite(lon):
                    raise ValueError('Invalid GeoNames coordinate')
                record = (int(f[0]), f[1], f[2], f[3], lat, lon, f[8], f[17])
                cells[(math.floor(lat / CELL_DEG), math.floor(lon / CELL_DEG))].append(record)
    return cells


def distance_km(lat, lon, other_lat, other_lon):
    a, b = math.radians(lat), math.radians(other_lat)
    delta_lat, delta_lon = b - a, math.radians(other_lon - lon)
    value = math.sin(delta_lat / 2) ** 2 + math.cos(a) * math.cos(b) * math.sin(delta_lon / 2) ** 2
    return 12742.0176 * math.asin(min(1, math.sqrt(value)))


def candidates_for(city, grid, country_code):
    lat, lon, name = float(city['latitude']), float(city['longitude']), city['name']
    row, col = math.floor(lat / CELL_DEG), math.floor(lon / CELL_DEG)
    lat_rings = max(1, math.ceil(MATCH_RADIUS_KM / (111.195 * CELL_DEG)))
    lon_rings = min(3600, max(1, math.ceil(MATCH_RADIUS_KM / (111.195 * CELL_DEG * max(0.01, abs(math.cos(math.radians(lat))))))))
    found = []
    for dr in range(-lat_rings, lat_rings + 1):
        for dc in range(-lon_rings, lon_rings + 1):
            wrapped = ((col + dc + 3600) % 7200) - 3600
            for record in grid.get((row + dr, wrapped), ()):
                ident, primary, ascii_name, alternates, rlat, rlon, iso, zone = record
                if country_code and iso != country_code:
                    continue
                tier = 0 if primary == name else 1 if name == ascii_name or name in alternates.split(',') else None
                if tier is None:
                    continue
                distance = distance_km(lat, lon, rlat, rlon)
                if distance <= MATCH_RADIUS_KM:
                    found.append((tier, distance, record))
    return sorted(found, key=lambda item: (item[0], item[1], item[2][0]))


def build_index(cities, route_index, geonames_zip, country_codes):
    if len(cities) != len(route_index.get('rows', [])):
        raise ValueError('Canonical route index differs from inventory')
    grid = geonames_grid(geonames_zip)
    by_source_index = {r['sourceIndex']: r for r in route_index['rows']}
    if len(by_source_index) != len(cities) or set(by_source_index) != set(range(len(cities))):
        raise ValueError('Route identity is not a bijection')
    counts = Counter()
    rows = []
    seen_paths = set()
    zone_cache = {}
    for i, city in enumerate(cities):
        route = by_source_index[i]
        if route['name'] != city['name'] or route['latitude'] != city['latitude'] or route['longitude'] != city['longitude']:
            raise ValueError('Route identity does not match source inventory')
        path = '/wetbulb-temperature/{}/{}/{}/'.format(route['countrySlug'], route['stateSlug'], route['outputCitySlug'])
        if path in seen_paths:
            raise ValueError('Duplicate canonical route')
        seen_paths.add(path)
        country = country_codes.get(city['resolvedCountryName'])
        candidates = candidates_for(city, grid, country)
        record = {'path': path, 'id': None, 'timeZone': None, 'status': 'unmatched'}
        if not country:
            # Unknown geography: require exact coordinate+primary name, not a near-name inference.
            candidates = [c for c in candidates if c[0] == 0 and c[1] < 0.00001]
        if candidates:
            top = candidates[0]
            runner = candidates[1] if len(candidates) > 1 else None
            exact_coordinate = top[1] < 0.00001 and (runner is None or runner[1] >= 0.00001)
            ambiguous = runner is not None and runner[0] == top[0] and runner[1] - top[1] < AMBIGUITY_KM and not exact_coordinate
            if ambiguous:
                record['status'] = 'ambiguous'
            else:
                geoname = top[2]
                zone = geoname[7]
                if zone not in zone_cache:
                    try:
                        ZoneInfo(zone)
                        zone_cache[zone] = True
                    except (ZoneInfoNotFoundError, ValueError):
                        zone_cache[zone] = False
                if zone_cache[zone]:
                    record.update(id=geoname[0], timeZone=zone, status='exact' if top[0] == 0 else 'alternate')
        counts[record['status']] += 1
        rows.append(record)
    return {'schemaVersion':1,'source':'GeoNames cities1000','sourceSha256':sha256(geonames_zip),
            'inventoryRows':len(cities),'counts':dict(sorted(counts.items())),'rows':rows}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--inventory', required=True, type=Path)
    p.add_argument('--routes', required=True, type=Path)
    p.add_argument('--geonames', required=True, type=Path)
    p.add_argument('--country-codes', required=True, type=Path)
    p.add_argument('--out', required=True, type=Path)
    args = p.parse_args()
    if args.out.exists():
        p.error('Refusing to overwrite derived index')
    with args.country_codes.open(newline='', encoding='utf-8') as handle:
        codes = {r['Name']:r['Code'] for r in csv.DictReader(handle)}
    result = build_index(json.loads(args.inventory.read_text()), json.loads(args.routes.read_text()), args.geonames, codes)
    args.out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    args.out.write_text(json.dumps(result, separators=(',', ':')) + '\n', encoding='utf-8')
    args.out.chmod(0o600)
    print(json.dumps({'inventoryRows':result['inventoryRows'],'counts':result['counts'],'sourceSha256':result['sourceSha256']}))


if __name__ == '__main__':
    main()
