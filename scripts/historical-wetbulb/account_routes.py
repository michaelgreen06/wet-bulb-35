#!/usr/bin/env python3
"""Account for every canonical route from what was actually acquired and verified (offline).

Inputs are the frozen plan (plan_all_routes.py), one or more run_tile_backfill.py
--out folders and independent-verifier output (verify_period_independent.py
--tile-run). Each route gets exactly one status:

  verified-candidate-unpublished  sealed tile, complete source-pinned period whose exact
                                  digest passed independent verification; not yet approved
                                  for publication
  acquired-unverified             sealed tile and complete pinned period, no passing
                                  verification for that exact digest yet
  unavailable-verification-failed independent verification failed for that exact digest
  unavailable-masked-cell         the nearest ERA5-Land cell has no land data (plan or tile)
  unavailable-incomplete-period   the cell or group failed completeness/validation in the tile
  acquisition-incomplete          the tile was started, failed or bounded; a rerun resumes it
  …plan statuses                  pending-acquisition, research-complete-unpublished and
                                  unavailable-incomplete-period are resolved from the sealed
                                  tile (pinned evidence supersedes PR #41's complete or
                                  partial unpinned research years); unavailable-identity-*
                                  and unavailable-masked-cell carry over unchanged

Routes with a sealed high period also get a separate `lowStatus` for the low-v1
companion (lowest modeled hourly wet bulb), bound to its own digest and to the exact
high bytes; high statuses and counts are computed exactly as before.

Nothing here publishes, fetches or alters a value. The per-route file stays private;
the summary (counts, verified total, review queue) is safe to commit.
"""
import argparse
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

VERIFIED = 'verified-candidate-unpublished'
STATUS_MEANING = {
    'supported': 'Published, approved complete-period history',
    VERIFIED: 'Complete content-pinned 1950–2025 period, independently verified; publication approval pending',
    'acquired-unverified': 'Complete content-pinned period; independent verification pending',
    'unavailable-verification-failed': 'Independent recomputation disagreed; held for review',
    'research-complete-unpublished': 'Complete private research period from unpinned PR #41 inputs; superseded once pinned',
    'pending-acquisition': 'Mapped and planned; source data not yet acquired',
    'acquisition-incomplete': 'Tile started but not sealed (bounded, failed or in progress); a rerun resumes it',
    'unavailable-masked-cell': 'Nearest ERA5-Land cell has no land data',
    'unavailable-incomplete-period': 'Source hours missing or period validation failed for this cell/group '
                                     '(or, before its tile is sealed, only partial PR #41 research years exist)',
    'unavailable-identity-unmatched': 'No verified GeoNames identity/IANA timezone',
    'unavailable-identity-ambiguous': 'GeoNames identity shared by several canonical routes',
}
LOW_VERIFIED = 'low-verified-candidate-unpublished'
LOW_STATUS_MEANING = {
    LOW_VERIFIED: 'Complete low-v1 period from the same pinned hours, independently verified; publication approval pending',
    'low-acquired-unverified': 'Complete low-v1 period; independent low verification pending',
    'low-unavailable-verification-failed': 'Independent low recomputation disagreed; held for review',
    'low-unavailable-incomplete-period': 'Low period validation failed in the tile; held for review',
    'low-pending-backfill': 'High period sealed before lows existed; offline low backfill pending',
}
STATED_YEARS = (1950, 2025)
# Plan statuses that describe PR #41's unpinned research (none, complete, or partial years)
# rather than an identity or mask verdict: a sealed pinned tile is the evidence for them.
RESOLVED_BY_TILE = ('pending-acquisition', 'research-complete-unpublished', 'unavailable-incomplete-period')
# Verdicts count only when made with the verifier's pinned IANA 2026c main-data tree
# (verify_period_independent.TZ_SOURCE); earlier output used the system backzone build.
TZ_SOURCE = 'iana-2026c-main/pytz-2026.3.post1'
REVIEW = ('unavailable-verification-failed', 'unavailable-masked-cell', 'unavailable-incomplete-period')


def sha256_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for part in iter(lambda: f.read(1 << 20), b''):
            h.update(part)
    return h.hexdigest()


def tile_name(tile):
    return f't{tile[0]:03d}-{tile[1]:03d}'


def load_runs(run_dirs, source, years=STATED_YEARS):
    """Tile outcomes across runs. A tile sealed in two runs must agree exactly."""
    sealed, started = {}, set()
    periods = {}
    for run in run_dirs:
        for tile_dir in sorted((Path(run) / 'tiles' / source).glob('t*-*')):
            status_path = tile_dir / 'status.json'
            if not status_path.exists():
                started.add(tile_dir.name)
                continue
            status = json.loads(status_path.read_text())
            if status.get('source') != source or tile_name(status['tile']) != tile_dir.name:
                raise ValueError(f'{tile_dir}: tile status does not match its folder or source')
            previous = sealed.get(tile_dir.name)
            comparable = lambda st: {k: v for k, v in st.items() if k != 'completedUTC'}
            if previous and comparable(previous) != comparable(status):
                raise ValueError(f'{tile_dir.name}: sealed differently in two runs; review before accounting')
            sealed[tile_dir.name] = status
            for period in status['periods']:
                manifest_path = Path(run) / 'groups' / source / hashlib.sha256(period['groupKey'].encode()).hexdigest()[:20] / 'manifest.json'
                manifest = json.loads(manifest_path.read_text())
                if (manifest.get('groupKey') != period['groupKey'] or manifest.get('periodSha256') != period['periodSha256']
                        or sha256_file(manifest_path.with_name('period.json')) != period['periodSha256']):
                    raise ValueError(f"{period['groupKey']}: period bytes differ from the sealed tile status")
                if manifest.get('sourcePinned') is not True or manifest.get('researchOnly') is not False:
                    raise ValueError(f"{period['groupKey']}: period is not content-pinned")
                # A smoke or partial run sealed with other --start/--end years must never count.
                if ((manifest.get('startYear'), manifest.get('endYear')) != tuple(years)
                        or manifest.get('first') not in (f'{years[0]}-01-02', f'{years[0]}-01-03')
                        or manifest.get('last') != f'{years[1]}-12-31'):
                    raise ValueError(f"{period['groupKey']}: period is not the stated {years[0]}–{years[1]} span")
                periods[period['groupKey']] = {'periodSha256': period['periodSha256'], 'completeDays': period['completeDays'],
                                               'first': manifest['first'], 'last': manifest['last']}
    return sealed, started - set(sealed), periods


def load_low_runs(run_dirs, source, periods, years=STATED_YEARS):
    """low-v1 companions of sealed tiles: groupKey → digests, plus per-group low failures."""
    lows, failed = {}, {}
    for run in run_dirs:
        for status_path in sorted((Path(run) / 'tiles' / source).glob('t*-*/status.json')):
            low_path = status_path.with_name('low-status.json')
            if not low_path.exists():
                continue
            record = json.loads(low_path.read_text())
            if record.get('lowSchema') != 'low-v1' or record.get('highStatusSha256') != sha256_file(status_path):
                raise ValueError(f'{status_path.parent.name}: low-status.json is not bound to the sealed status')
            for entry in record['failedLowGroups']:
                failed[entry['groupKey']] = entry['reason']
            for entry in record['lowPeriods']:
                key = entry['groupKey']
                folder = Path(run) / 'groups' / source / hashlib.sha256(key.encode()).hexdigest()[:20] / 'low-v1'
                manifest = json.loads((folder / 'manifest.json').read_text())
                if (manifest.get('groupKey') != key or manifest.get('lowPeriodSha256') != entry['lowPeriodSha256']
                        or sha256_file(folder / 'period.json') != entry['lowPeriodSha256']):
                    raise ValueError(f'{key}: low period bytes differ from the sealed low status')
                if key not in periods or manifest.get('highPeriodSha256') != periods[key]['periodSha256']:
                    raise ValueError(f'{key}: low period is not bound to the sealed high period')
                if (manifest.get('publicationApproved') is not False or manifest.get('sourcePinned') is not True
                        or (manifest.get('startYear'), manifest.get('endYear')) != tuple(years)):
                    raise ValueError(f'{key}: low period is publishable, unpinned or not the stated span')
                lows[key] = {'lowPeriodSha256': entry['lowPeriodSha256'], 'periodLow': manifest['periodLow']}
    return lows, failed


def load_low_verdicts(paths):
    """(groupKey, lowPeriodSha256) → ok; any failure for a digest outranks a pass."""
    verdicts = {}
    for path in paths:
        for line in Path(path).read_text().splitlines():
            row = json.loads(line)
            if (row.get('extremum') != 'low' or not row.get('groupKey') or not row.get('lowPeriodSha256')
                    or row.get('tzSource') != TZ_SOURCE):
                continue
            key = (row['groupKey'], row['lowPeriodSha256'])
            verdicts[key] = verdicts.get(key, True) and row.get('ok') is True
    return verdicts


def low_status(group, lows, low_failed, low_verdicts):
    if group in low_failed:
        return {'lowStatus': 'low-unavailable-incomplete-period', 'lowReason': low_failed[group][:300]}
    if group not in lows:
        return {'lowStatus': 'low-pending-backfill'}
    verdict = low_verdicts.get((group, lows[group]['lowPeriodSha256']))
    return {'lowPeriodSha256': lows[group]['lowPeriodSha256'],
            'lowStatus': LOW_VERIFIED if verdict is True else
            'low-unavailable-verification-failed' if verdict is False else 'low-acquired-unverified'}


def load_verdicts(paths):
    """(groupKey, periodSha256) → ok. Any failure for a digest outranks a pass for it."""
    verdicts = {}
    for path in paths:
        for line in Path(path).read_text().splitlines():
            row = json.loads(line)
            if 'groupKey' not in row:
                continue  # header line (reference-vector check)
            if row.get('extremum', 'high') != 'high' or not row.get('periodSha256') or row.get('tzSource') != TZ_SOURCE:
                continue  # low rows, legacy output without a digest, or verdicts made without the pinned tz tree
            key = (row['groupKey'], row['periodSha256'])
            verdicts[key] = verdicts.get(key, True) and row.get('ok') is True
    return verdicts


def account(plan_rows, sealed, started, periods, verdicts, lows=None, low_failed=None, low_verdicts=None):
    rows = []
    for row in plan_rows:
        out = {k: row[k] for k in ('path', 'status', 'stage', 'group', 'tile') if k in row}
        group, tile = row.get('group'), row.get('tile')
        if group and tile and row['status'] in RESOLVED_BY_TILE:
            name = tile_name(tile)
            cell = group.split('|', 1)[0]
            status = sealed.get(name)
            if status is not None:
                if cell in status['maskedCells']:
                    out.update(status='unavailable-masked-cell', reason='ERA5-Land cell is all-NaN (no land data) for the full period')
                elif cell in status['unavailableCells']:
                    out.update(status='unavailable-incomplete-period', reason=status['unavailableCells'][cell])
                elif any(f['groupKey'] == group for f in status['failedGroups']):
                    reason = next(f['reason'] for f in status['failedGroups'] if f['groupKey'] == group)
                    out.update(status='unavailable-incomplete-period', reason=f'period validation failed: {reason}'[:300])
                elif group in periods:
                    period = periods[group]
                    verdict = verdicts.get((group, period['periodSha256']))
                    out['period'] = period
                    out['status'] = (VERIFIED if verdict is True else
                                     'unavailable-verification-failed' if verdict is False else 'acquired-unverified')
                    if lows is not None:
                        out.update(low_status(group, lows, low_failed or {}, low_verdicts or {}))
                else:
                    raise ValueError(f'{row["path"]}: sealed tile {name} neither produced nor excluded group {group}')
            elif name in started:
                out['status'] = 'acquisition-incomplete'
        rows.append(out)
    return rows


def summarize(rows, plan_sha, inputs):
    counts = Counter(r['status'] for r in rows)
    by_stage = defaultdict(Counter)
    for r in rows:
        by_stage[r.get('stage') or 'unstaged'][r['status']] += 1
    groups = {r['group'] for r in rows if r['status'] == VERIFIED}
    low_counts = Counter(r['lowStatus'] for r in rows if 'lowStatus' in r)
    return {
        'lowSchema': 'low-v1', 'lowVerifiedCandidateRoutes': low_counts[LOW_VERIFIED],
        'lowVerifiedCandidateGroups': len({r['group'] for r in rows if r.get('lowStatus') == LOW_VERIFIED}),
        'lowStatusCounts': dict(sorted(low_counts.items())),
        'lowStatusMeaning': {s: LOW_STATUS_MEANING[s] for s in sorted(low_counts)},
        'schemaVersion': 1, 'planSha256': plan_sha, 'inputs': inputs, 'routes': len(rows),
        'verifiedCandidateRoutes': counts[VERIFIED], 'verifiedCandidateGroups': len(groups),
        'supportedRoutes': counts['supported'],
        'statusCounts': dict(sorted(counts.items())),
        'byStage': {stage: dict(sorted(c.items())) for stage, c in sorted(by_stage.items())},
        'reviewQueue': {s: sorted(r['path'] for r in rows if r['status'] == s) for s in REVIEW if counts[s]},
        'statusMeaning': {s: STATUS_MEANING[s] for s in sorted(counts)},
    }


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--plan', required=True, type=Path)
    p.add_argument('--tile-run', required=True, type=Path, action='append')
    p.add_argument('--verified', type=Path, action='append', default=[])
    p.add_argument('--source', default='arco')
    p.add_argument('--routes-out', required=True, type=Path, help='Private per-route accounting (never in Git)')
    p.add_argument('--summary-out', required=True, type=Path)
    a = p.parse_args()
    repo = Path(__file__).resolve().parents[2]
    if a.routes_out.resolve().is_relative_to(repo):
        raise ValueError('Per-route accounting stays private; write it outside Git')
    plan_sha = sha256_file(a.plan)
    plan_rows = json.loads(a.plan.read_text())['rows']
    if len({r['path'] for r in plan_rows}) != len(plan_rows):
        raise ValueError('Plan has duplicate routes')
    sealed, started, periods = load_runs(a.tile_run, a.source)
    lows, low_failed = load_low_runs(a.tile_run, a.source, periods)
    rows = account(plan_rows, sealed, started, periods, load_verdicts(a.verified), lows, low_failed, load_low_verdicts(a.verified))
    if len(rows) != len(plan_rows):
        raise AssertionError('Every planned route must be accounted for exactly once')
    inputs = {'sealedTiles': len(sealed), 'startedUnsealedTiles': len(started), 'pinnedPeriods': len(periods),
              'lowPeriods': len(lows), 'lowFailedGroups': len(low_failed), 'verifierFiles': len(a.verified)}
    summary = summarize(rows, plan_sha, inputs)
    a.routes_out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    a.routes_out.write_text(json.dumps({'schemaVersion': 1, 'planSha256': plan_sha, 'rows': rows}, sort_keys=True) + '\n')
    a.routes_out.chmod(0o600)
    a.summary_out.parent.mkdir(parents=True, exist_ok=True)
    a.summary_out.write_text(json.dumps(summary, indent=1, sort_keys=True, ensure_ascii=False) + '\n')
    print(json.dumps({k: summary[k] for k in ('routes', 'verifiedCandidateRoutes', 'verifiedCandidateGroups', 'statusCounts',
                                              'lowVerifiedCandidateRoutes', 'lowVerifiedCandidateGroups', 'lowStatusCounts')}))


if __name__ == '__main__':
    main()
