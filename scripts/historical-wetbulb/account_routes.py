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
                                  unavailable-identity-* carry over unchanged

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
    'unavailable-incomplete-period': 'Source hours missing or period validation failed for this cell/group',
    'unavailable-identity-unmatched': 'No verified GeoNames identity/IANA timezone',
    'unavailable-identity-ambiguous': 'GeoNames identity shared by several canonical routes',
}
STATED_YEARS = (1950, 2025)
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


def load_verdicts(paths):
    """(groupKey, periodSha256) → ok. Any failure for a digest outranks a pass for it."""
    verdicts = {}
    for path in paths:
        for line in Path(path).read_text().splitlines():
            row = json.loads(line)
            if 'groupKey' not in row:
                continue  # header line (reference-vector check)
            if not row.get('periodSha256'):
                continue  # legacy output without a digest cannot be bound to exact bytes
            key = (row['groupKey'], row['periodSha256'])
            verdicts[key] = verdicts.get(key, True) and row.get('ok') is True
    return verdicts


def account(plan_rows, sealed, started, periods, verdicts):
    rows = []
    for row in plan_rows:
        out = {k: row[k] for k in ('path', 'status', 'stage', 'group', 'tile') if k in row}
        group, tile = row.get('group'), row.get('tile')
        if group and tile and row['status'] in ('pending-acquisition', 'research-complete-unpublished'):
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
    return {
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
    rows = account(plan_rows, sealed, started, periods, load_verdicts(a.verified))
    if len(rows) != len(plan_rows):
        raise AssertionError('Every planned route must be accounted for exactly once')
    inputs = {'sealedTiles': len(sealed), 'startedUnsealedTiles': len(started), 'pinnedPeriods': len(periods),
              'verifierFiles': len(a.verified)}
    summary = summarize(rows, plan_sha, inputs)
    a.routes_out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    a.routes_out.write_text(json.dumps({'schemaVersion': 1, 'planSha256': plan_sha, 'rows': rows}, sort_keys=True) + '\n')
    a.routes_out.chmod(0o600)
    a.summary_out.parent.mkdir(parents=True, exist_ok=True)
    a.summary_out.write_text(json.dumps(summary, indent=1, sort_keys=True, ensure_ascii=False) + '\n')
    print(json.dumps({k: summary[k] for k in ('routes', 'verifiedCandidateRoutes', 'verifiedCandidateGroups', 'statusCounts')}))


if __name__ == '__main__':
    main()
