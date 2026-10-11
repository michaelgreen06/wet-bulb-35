#!/usr/bin/env python3
"""HEAD-only ARCO chunk-object size/ETag sample for planned tiles (no climate values read).

Sequential, paced, bounded (≤400 requests). Samples tiles per stage with a fixed
seed and records Content-Length, ETag and Last-Modified for t2m/d2m/sp objects
at chosen time-chunk indices. Output is private; it sizes the acquisition gate.
"""
import argparse
import json
import random
import statistics
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

FIELDS = (('t2m', 'https://arco.datastores.ecmwf.int/cadl-arco-geo-007/arco/reanalysis_era5_land/sfc-2m-temperature/geoChunked.zarr'),
          ('d2m', 'https://arco.datastores.ecmwf.int/cadl-arco-geo-007/arco/reanalysis_era5_land/sfc-2m-temperature/geoChunked.zarr'),
          ('sp', 'https://arco.datastores.ecmwf.int/cadl-arco-geo-009/arco/reanalysis_era5_land/sfc-pressure-precipitation/geoChunked.zarr'))
MAX_REQUESTS = 400


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise PermissionError('Authenticated ARCO requests must not redirect')


def head(url, token):
    request = urllib.request.Request(url, method='HEAD', headers={'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=60) as reply:
            return {'status': reply.status, 'bytes': int(reply.headers['Content-Length']),
                    'etag': reply.headers.get('ETag'), 'lastModified': reply.headers.get('Last-Modified')}
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return {'status': 404, 'bytes': 0}
        raise


def sample_tiles(plan_rows, per_stage, seed):
    tiles = defaultdict(set)
    for row in plan_rows:
        if row.get('stage') and 'group' in row:
            stage = 'remaining' if row['stage'].startswith('remaining-') else row['stage']
            tiles[stage].add(tuple(row['tile']))
    rng = random.Random(seed)
    return {stage: sorted(rng.sample(sorted(found), min(per_stage, len(found)))) for stage, found in sorted(tiles.items())}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--plan', required=True, type=Path)
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--per-stage', type=int, default=10)
    p.add_argument('--chunks', default='0,10')
    p.add_argument('--seed', type=int, default=20261004)
    p.add_argument('--pause-seconds', type=float, default=0.5)
    a = p.parse_args()
    chunks = [int(x) for x in a.chunks.split(',')]
    tiles = sample_tiles(json.loads(a.plan.read_text())['rows'], a.per_stage, a.seed)
    total = sum(len(t) for t in tiles.values()) * len(chunks) * len(FIELDS)
    if total > MAX_REQUESTS or a.pause_seconds < 0.2:
        raise ValueError('Probe exceeds the HEAD request bound or pacing')
    lines = dict(line.split(': ', 1) for line in (Path.home() / '.cdsapirc').read_text().splitlines() if ': ' in line)
    token = lines.get('key', '')
    results = []
    for stage, sampled in tiles.items():
        for tile in sampled:
            for k in chunks:
                entry = {'stage': stage, 'tile': list(tile), 'chunk': k}
                for name, url in FIELDS:
                    entry[name] = head(f'{url}/{name}/{k}.{tile[0]}.{tile[1]}', token)
                    time.sleep(a.pause_seconds)
                entry['setBytes'] = sum(entry[n]['bytes'] for n, _ in FIELDS)
                results.append(entry)
    by_stage = {}
    for stage in tiles:
        sizes = [r['setBytes'] for r in results if r['stage'] == stage]
        by_stage[stage] = {'samples': len(sizes), 'meanSetBytes': round(statistics.mean(sizes)),
                           'minSetBytes': min(sizes), 'maxSetBytes': max(sizes)}
    sizes = [r['setBytes'] for r in results]
    report = {'schemaVersion': 1, 'probedUTC': datetime.now(timezone.utc).isoformat(), 'requests': total,
              'chunks': chunks, 'byStage': by_stage, 'meanSetBytes': round(statistics.mean(sizes)),
              'medianSetBytes': round(statistics.median(sizes)), 'samples': results}
    a.out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    a.out.write_text(json.dumps(report, indent=1) + '\n')
    a.out.chmod(0o600)
    print(json.dumps({k: report[k] for k in ('requests', 'byStage', 'meanSetBytes', 'medianSetBytes')}))


if __name__ == '__main__':
    main()
