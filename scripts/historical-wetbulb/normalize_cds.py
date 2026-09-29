#!/usr/bin/env python3
"""Validate and partition two grouped CDS ERA5-Land CSV members, offline only.

The request source and outputs must remain private and outside Git. The member
rows are joined strictly by the UTC timestamp and the same actual source cell.
This script never fetches a provider or creates a public asset.
"""
import argparse
import csv
import hashlib
import io
import json
import math
import os
import re
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from itertools import zip_longest
from pathlib import Path

DATASET = 'reanalysis-era5-land-timeseries'
STAMP = re.compile(r'^\d{4}-\d{2}-\d{2} \d{2}:00:00$')


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def source_cell(row):
    lat, lon = float(row['latitude']), float(row['longitude'])
    if not math.isfinite(lat) or not math.isfinite(lon) or abs(lat) > 90.01 or abs(lon) > 180.01:
        raise ValueError('Invalid ERA5-Land source grid cell')
    lat, lon = round(lat, 1), round(lon, 1)
    return (0.0 if lat == 0 else lat, 0.0 if lon == 0 else lon)


def source_number(row, key, *, minimum, maximum):
    raw = row.get(key)
    if raw is None or raw == '':
        raise ValueError(f'Missing ERA5-Land {key}')
    n = float(raw)
    if not math.isfinite(n) or not minimum <= n <= maximum:
        raise ValueError(f'Invalid ERA5-Land {key}')
    return n


def normalized_time(value):
    if not isinstance(value, str) or not STAMP.fullmatch(value):
        raise ValueError('Invalid ERA5-Land UTC timestamp')
    instant = datetime.strptime(value, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
    return instant.isoformat(timespec='milliseconds').replace('+00:00', 'Z'), instant.timestamp()


def normalize_archive(source, out_dir, *, max_zip_bytes=250_000_000, max_cells=150):
    source, out_dir = Path(source), Path(out_dir)
    if not source.is_file() or source.stat().st_size > max_zip_bytes or out_dir.exists():
        raise ValueError('Invalid input size, missing archive, or existing output directory')
    out_dir.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.era5-land-normalize-', dir=out_dir.parent))
    handles, files, last_hour = {}, {}, {}
    hours = 0
    try:
        with zipfile.ZipFile(source) as z:
            names = z.namelist()
            temperature = [n for n in names if re.fullmatch(r'reanalysis-era5-land-timeseries-sfc-2m-temperature[^/]*\.csv', n)]
            pressure = [n for n in names if re.fullmatch(r'reanalysis-era5-land-timeseries-sfc-pressure-precipitation[^/]*\.csv', n)]
            if len(names) != 2 or len(temperature) != 1 or len(pressure) != 1:
                raise ValueError('Expected exactly two known CDS CSV groups')
            if any(z.getinfo(name).file_size > max_zip_bytes * 30 for name in names):
                raise ValueError('CSV member exceeds extraction bound')
            with z.open(temperature[0]) as t, z.open(pressure[0]) as p:
                a = csv.DictReader(io.TextIOWrapper(t, encoding='utf-8-sig'))
                b = csv.DictReader(io.TextIOWrapper(p, encoding='utf-8-sig'))
                if set(a.fieldnames or []) != {'valid_time', 'latitude', 'longitude', 'd2m', 't2m'} or set(b.fieldnames or []) != {'valid_time', 'latitude', 'longitude', 'sp'}:
                    raise ValueError('Unexpected CDS CSV schema')
                for ta, pb in zip_longest(a, b):
                    if ta is None or pb is None or ta['valid_time'] != pb['valid_time'] or source_cell(ta) != source_cell(pb):
                        raise ValueError('Temperature/dewpoint and pressure do not align by UTC hour and grid cell')
                    stamp, seconds = normalized_time(ta['valid_time'])
                    cell = source_cell(ta)
                    key = f'{cell[0]:.1f},{cell[1]:.1f}'
                    if key not in files:
                        if len(files) >= max_cells:
                            raise ValueError('Too many cells in one CDS archive')
                        filename = 'cell-' + hashlib.sha256(key.encode()).hexdigest()[:20] + '.ndjson'
                        files[key] = {'file': filename, 'hours': 0}
                        handles[key] = (stage / filename).open('w', encoding='utf-8')
                    if key in last_hour and seconds != last_hour[key] + 3600:
                        raise ValueError('Missing, duplicate, or out-of-order UTC hour in source cell')
                    last_hour[key] = seconds
                    row = {
                        'timeUTC': stamp,
                        'temperatureK': source_number(ta, 't2m', minimum=150, maximum=350),
                        'dewpointK': source_number(ta, 'd2m', minimum=150, maximum=350),
                        'pressurePa': source_number(pb, 'sp', minimum=10_000, maximum=110_000),
                        'gridCell': list(cell),
                    }
                    handles[key].write(json.dumps(row, separators=(',', ':')) + '\n')
                    files[key]['hours'] += 1
                    hours += 1
        if not hours:
            raise ValueError('No CDS hourly rows')
        for handle in handles.values():
            handle.close()
        handles.clear()
        for value in files.values():
            value['sha256'] = sha256_file(stage / value['file'])
            value['bytes'] = (stage / value['file']).stat().st_size
        manifest = {'schemaVersion': 1, 'dataset': DATASET, 'sourceSha256': sha256_file(source), 'hours': hours,
                    'cells': len(files), 'files': dict(sorted(files.items()))}
        (stage / 'manifest.json').write_text(json.dumps(manifest, separators=(',', ':'), sort_keys=True) + '\n', encoding='utf-8')
        os.replace(stage, out_dir)
        return manifest
    except Exception:
        for handle in handles.values():
            handle.close()
        shutil.rmtree(stage, ignore_errors=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    result = normalize_archive(args.source, args.out)
    print(json.dumps({'cells': result['cells'], 'hours': result['hours'], 'sourceSha256': result['sourceSha256']}))


if __name__ == '__main__':
    main()
