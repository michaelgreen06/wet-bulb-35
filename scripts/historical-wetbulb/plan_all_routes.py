#!/usr/bin/env python3
"""Account for every canonical route and plan the staged ERA5-Land rollout.

No network. Reads the private frozen route index, GeoNames identity index and
existing private research outputs; writes a private per-route plan and a public
count summary. Every route receives exactly one status and reason. Acquisition
is planned per ARCO 4×8-cell tile so neighbouring routes share source chunks.
Stages: pilot (routes with existing research) → top50 → varied-regions (the
highest-yield tiles of every IANA region) → remaining (spatial batches).
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

REPO = Path(__file__).resolve().parents[2]
TIME_CHUNK_HOURS = 33_792
# Measured 2026-10-04: HEAD-only Content-Length of t2m+d2m+sp objects for 40
# stage-sampled tiles × time chunks 0 and 10 (probe_chunk_sizes.py); mean 6.14 MB,
# median 6.79 MB, 2 of 40 tiles entirely absent (all-ocean). Planning estimate only.
MEASURED_TILE_CHUNK_BYTES = 6_139_869
# Measured 2026-09-30: 756 sequential single-cell city-year ARCO jobs in ~145 min.
MEASURED_SECONDS_PER_CELL_YEAR = 11.5

STATUSES = {
    'supported': 'Published, approved complete-period history',
    'research-complete-unpublished': 'Complete private research period; publication approval/provenance pending',
    'unavailable-identity-unmatched': 'No verified GeoNames identity/IANA timezone',
    'unavailable-identity-ambiguous': 'GeoNames identity shared by several canonical routes',
    'unavailable-masked-cell': 'Nearest ERA5-Land cell has no land data (coastal/island review queue)',
    'unavailable-incomplete-period': 'Only partial private research years exist',
    'pending-acquisition': 'Mapped and planned; source data not yet acquired',
}


def _load(name):
    spec = importlib.util.spec_from_file_location(name.removesuffix('.py'), Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GRID = _load('era5land_grid.py')


def route_path(row):
    return f"/wetbulb-temperature/{row['countrySlug']}/{row['stateSlug']}/{row['outputCitySlug']}/"


def group_key(cell, time_zone):
    return f'{GRID.cell_key(cell)}|{time_zone}'


def valid_zone(name):
    try:
        ZoneInfo(name)
        return True
    except (ZoneInfoNotFoundError, ValueError, TypeError, KeyError):
        return False


def scan_research(roots):
    """Index private research by cell|timezone group: annual years and complete periods."""
    groups = defaultdict(lambda: {'years': set(), 'period': None})
    for root in roots:
        root = Path(root)
        annuals = sorted(root.rglob('annual.json')) + sorted(root.rglob('*-annual.json')) + sorted(root.rglob('y[0-9][0-9][0-9][0-9].json'))
        for annual in annuals:
            data = json.loads(annual.read_text())
            if data.get('schemaVersion') != 1 or not isinstance(data.get('localYear'), int):
                continue
            groups[group_key(data['gridCell'], data['timeZone'])]['years'].add(data['localYear'])
        for manifest in sorted(root.rglob('manifest.json')):
            data = json.loads(manifest.read_text())
            if 'periodSha256' not in data:
                continue
            period = manifest.with_name('period.json')
            raw = period.read_bytes()
            if hashlib.sha256(raw).hexdigest() != data['periodSha256']:
                raise ValueError(f'Research period checksum mismatch: {manifest.parent.name}')
            summary = json.loads(raw)
            coverage = summary['coverage']
            key = group_key(data['gridCell'], data['timeZone'])
            if data.get('groupKey', key) != key or summary.get('timeZone') != data['timeZone']:
                raise ValueError(f'Research period identity mismatch: {manifest.parent.name}')
            entry = groups[key]
            entry['period'] = {'path': data.get('path'), 'startYear': data['startYear'], 'endYear': data['endYear'],
                               'firstComplete': coverage['firstComplete'], 'lastComplete': coverage['lastComplete'],
                               'completeDays': coverage['completeDays'], 'periodSha256': data['periodSha256'],
                               'researchOnly': summary.get('researchOnly') is not False,
                               'dir': str(manifest.parent)}
            entry['years'].update(coverage['years'])
    return groups


def scan_masks(survey_root):
    """Per-cell data availability from the bounded Top-50 mask survey."""
    status = {}
    if not survey_root:
        return status
    for manifest in sorted(Path(survey_root).glob('r*/manifest.json')):
        data = json.loads(manifest.read_text())
        for key in data.get('maskedCells', []):
            status[key] = 'masked'
        for key, record in data.get('files', {}).items():
            if record.get('hours', 0) > 0:
                status.setdefault(key, 'valid')
    return status


def publishable(approval, period):
    """Mirror of publication.mjs assertApproval: same scope, digest, approver, date and provenance rules."""
    return bool(approval and approval.get('scope') == 'publish-modeled-history'
                and approval.get('periodSha256') == period['periodSha256']
                and str(approval.get('approvedBy', '')).strip()
                and isinstance(approval.get('approvedAt'), str) and len(approval['approvedAt']) == 10
                and (not period['researchOnly'] or approval.get('acceptsResearchProvenance') is True))


def classify(routes, identities, *, ranked_paths, research, masks, approvals,
             varied_tiles_per_region=25, batch_tiles=250):
    if len(routes) != len(identities) or not routes:
        raise ValueError('Route and identity inventories differ')
    id_claims = Counter(r['id'] for r in identities if r.get('status') in ('exact', 'alternate'))
    ranked = {path: rank for rank, path in enumerate(ranked_paths, start=1)}
    rows = []
    for route, identity in zip(routes, identities):
        path = route_path(route)
        if identity.get('path') != path:
            raise ValueError(f'Identity index does not match canonical route order at {path}')
        row = {'path': path, 'rank': ranked.get(path)}
        mapped = GRID.map_coordinate(route['latitude'], route['longitude'])
        row.update(cell=mapped['cell'], tile=mapped['tile'],
                   distanceKm=round(GRID.haversine_km(route['latitude'], route['longitude'], *mapped['cell']), 2))
        if mapped['tie']:
            row['gridTie'] = True
        if identity.get('status') not in ('exact', 'alternate') or not valid_zone(identity.get('timeZone')):
            row['status'] = 'unavailable-identity-unmatched'
        elif id_claims[identity['id']] > 1:
            row['status'] = 'unavailable-identity-ambiguous'
        else:
            row.update(geoNamesId=identity['id'], timeZone=identity['timeZone'])
            if masks.get(GRID.cell_key(mapped['cell'])) == 'masked':
                row['status'] = 'unavailable-masked-cell'
            else:
                key = group_key(mapped['cell'], identity['timeZone'])
                row['group'] = key
                found = research.get(key)
                if found and found['period']:
                    approved = publishable(approvals.get(found['period']['periodSha256']), found['period'])
                    row['status'] = 'supported' if approved else 'research-complete-unpublished'
                    row['period'] = {k: found['period'][k] for k in ('firstComplete', 'lastComplete', 'completeDays', 'periodSha256')}
                elif found and found['years']:
                    row['status'] = 'unavailable-incomplete-period'
                    row['researchYears'] = len(found['years'])
                else:
                    row['status'] = 'pending-acquisition'
        rows.append(row)
    assign_stages(rows, research, varied_tiles_per_region, batch_tiles)
    return rows


def assign_stages(rows, research, varied_tiles_per_region, batch_tiles):
    """Earliest stage wins per tile, so a fetched tile serves every route in it."""
    tiles = defaultdict(lambda: {'routes': [], 'groups': set(), 'regions': Counter()})
    for row in rows:
        if 'group' not in row:
            continue
        t = tiles[tuple(row['tile'])]
        t['routes'].append(row)
        t['groups'].add(row['group'])
        t['regions'][row['timeZone'].split('/', 1)[0]] += 1
    stage_of = {}
    for key, t in tiles.items():
        if any(r['status'] != 'pending-acquisition' or r['group'] in research for r in t['routes']):
            stage_of[key] = 'pilot'
        elif any(r['rank'] and r['rank'] <= 50 for r in t['routes']):
            stage_of[key] = 'top50'
    by_region = defaultdict(list)
    for key, t in tiles.items():
        if key not in stage_of:
            by_region[t['regions'].most_common(1)[0][0]].append(key)
    batch_number = 0
    for region in sorted(by_region):
        ordered = sorted(by_region[region], key=lambda k: (-len(tiles[k]['groups']), k))
        for key in ordered[:varied_tiles_per_region]:
            stage_of[key] = 'varied-regions'
        rest = sorted(ordered[varied_tiles_per_region:])
        for start in range(0, len(rest), batch_tiles):
            batch_number += 1
            for key in rest[start:start + batch_tiles]:
                stage_of[key] = f'remaining-{batch_number:03d}'
    for row in rows:
        row['stage'] = stage_of.get(tuple(row['tile'])) if 'group' in row else None


def summarize(rows, *, total_hours, chunk_bytes=MEASURED_TILE_CHUNK_BYTES):
    status = Counter(r['status'] for r in rows)
    if sum(status.values()) != len(rows) or set(status) - set(STATUSES):
        raise AssertionError('Every route must have exactly one known status')
    time_chunks = math.ceil(total_hours / TIME_CHUNK_HOURS)
    stages = defaultdict(lambda: {'routes': 0, 'groups': set(), 'cells': set(), 'tiles': set(), 'pending': 0})
    for r in rows:
        if r['stage'] is None:
            continue
        name = r['stage'] if not r['stage'].startswith('remaining-') else 'remaining'
        s = stages[name]
        s['routes'] += 1
        s['pending'] += r['status'] == 'pending-acquisition'
        s['groups'].add(r['group'])
        s['cells'].add(GRID.cell_key(r['cell']))
        s['tiles'].add(tuple(r['tile']))
    stage_summary = {}
    for name in ('pilot', 'top50', 'varied-regions', 'remaining'):
        s = stages.get(name)
        if not s:
            continue
        tiles = len(s['tiles'])
        stage_summary[name] = {
            'routes': s['routes'], 'pendingRoutes': s['pending'], 'cellTimezoneGroups': len(s['groups']),
            'cells': len(s['cells']), 'tiles': tiles,
            'estimatedChunkFetchBytes': tiles * time_chunks * chunk_bytes,
            # One measured single-cell year job downloaded ≥1 whole tile time chunk;
            # treat each tile × time-chunk fetch as one such job (cells share it).
            'estimatedSequentialHours': round(tiles * time_chunks * MEASURED_SECONDS_PER_CELL_YEAR / 3600, 1),
        }
    remaining_batches = len({r['stage'] for r in rows if r['stage'] and r['stage'].startswith('remaining-')})
    review = defaultdict(list)
    for r in rows:
        if r['status'] in ('unavailable-masked-cell', 'unavailable-identity-ambiguous'):
            review[r['status']].append(r['path'])
    return {
        'schemaVersion': 1,
        'routes': len(rows),
        'statusCounts': dict(sorted(status.items())),
        'statusMeaning': STATUSES,
        'stages': stage_summary,
        'remainingBatches': remaining_batches,
        'timeChunksPerTile': time_chunks,
        'estimateBasis': {'tileChunkBytes': chunk_bytes, 'secondsPerTileChunkFetch': MEASURED_SECONDS_PER_CELL_YEAR,
                          'confidence': 'moderate for bytes (80 HEAD samples, 40 tiles); low for time '
                                        '(sequential single-cell 2026-09-30 rate; throughput/throttling at scale unmeasured)'},
        'reviewQueue': {k: sorted(v) for k, v in sorted(review.items())},
        'gridTieNorthEastRoutes': sum(1 for r in rows if r.get('gridTie')),
        'routeToCellKm': {
            'max': max((r['distanceKm'] for r in rows), default=None),
        },
    }


def private_write(path, payload):
    path = Path(path).resolve()
    if path == REPO or path.is_relative_to(REPO):
        raise ValueError('Per-route private plan must remain outside Git')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(prefix='.plan-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump(payload, handle, separators=(',', ':'), sort_keys=True)
            handle.write('\n')
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--routes', required=True, type=Path, help='Private route index (probe-location-route-identity.mjs)')
    p.add_argument('--identities', required=True, type=Path, help='Private GeoNames identity index')
    p.add_argument('--ranking', required=True, type=Path)
    p.add_argument('--mask-survey', type=Path)
    p.add_argument('--research', type=Path, action='append', default=[])
    p.add_argument('--approvals', type=Path, help='Michael-approved publication list (periodSha256 → approval)')
    p.add_argument('--total-hours', type=int, default=666_240,
                   help='Stated-period hours read per tile: 1950-01-02T00Z..2026-01-02T23Z')
    p.add_argument('--plan-out', required=True, type=Path)
    p.add_argument('--summary-out', required=True, type=Path)
    a = p.parse_args()
    routes = sorted(json.loads(a.routes.read_text())['rows'], key=lambda r: r['sourceIndex'])
    if [r['sourceIndex'] for r in routes] != list(range(len(routes))):
        raise ValueError('Route index sourceIndex values must be unique and complete')
    identities = json.loads(a.identities.read_text())['rows']
    ranking = json.loads(a.ranking.read_text())['cities']
    ranked_paths = [c['path'] for c in sorted(ranking, key=lambda c: c['rank'])]
    approvals = {}
    if a.approvals:
        data = json.loads(a.approvals.read_text())
        for entry in data.get('approved', []):
            approvals[entry['periodSha256']] = entry
    rows = classify(routes, identities, ranked_paths=ranked_paths, research=scan_research(a.research),
                    masks=scan_masks(a.mask_survey), approvals=approvals)
    summary = summarize(rows, total_hours=a.total_hours)
    summary['inputSha256'] = {name: hashlib.sha256(getattr(a, name).read_bytes()).hexdigest()
                              for name in ('routes', 'identities', 'ranking')}
    private_write(a.plan_out, {'schemaVersion': 1, 'rows': rows, 'summary': summary})
    a.summary_out.parent.mkdir(parents=True, exist_ok=True)
    a.summary_out.write_text(json.dumps(summary, indent=1, sort_keys=True) + '\n')
    print(json.dumps({'routes': summary['routes'], 'statusCounts': summary['statusCounts'],
                      'stages': {k: {x: v[x] for x in ('routes', 'tiles', 'cellTimezoneGroups')} for k, v in summary['stages'].items()}}))


if __name__ == '__main__':
    main()
