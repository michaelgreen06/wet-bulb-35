#!/usr/bin/env python3
"""Unattended, sequential, capped ERA5-Land acquisition campaign (one writer, fail closed).

Runs run_tile_backfill.py as consecutive jobs. Each job:
  * gets its own approval file and therefore its own ledger, capped at
    --job-max-bytes (≤ 10,000,000,000 B, Michael's 2026-10-11 overnight authorization);
  * starts only when the output folder's run lock is free (no concurrent fetches),
    the frozen plan/code hashes are unchanged, cumulative campaign bytes stay under
    --campaign-max-bytes, and projected disk use leaves --min-free-gb free;
  * is followed by independent QA (vectorized verifier, digest-bound, highs AND
    low-v1 lows) and route accounting. QA of job k runs while job k+1 fetches; job
    k+2 never starts unless QA k passed and every tile sealed when QA k started has a
    passing high and low verdict for its exact digests (coverage gate). A transient
    retry settles the previous QA first, exactly like a clean job end.
On (re)start, sealed tiles without lows are backfilled offline from their retained
chunks (backfill_lows.py) and a blocking catch-up QA + coverage gate runs before any
fetch.
Stops (never retries) on HTTP 429/5xx, 401/402/403, integrity or checksum errors,
QA failure or coverage gap, reduce or low failure, disk floor, code drift, or an
operator STOP file. Transient network errors get at most 2 consecutive retries after
a 15-minute pause. Raw chunks are never deleted here. `--status` prints a live
readback; `--refreeze REASON` re-freezes code at a stopped boundary (old freeze kept).
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
spec = spec_from_file_location('run_tile_backfill', HERE / 'run_tile_backfill.py')
RUN = module_from_spec(spec)
spec.loader.exec_module(RUN)
vspec = spec_from_file_location('verify_period_independent', HERE / 'verify_period_independent.py')
VERIFY = module_from_spec(vspec)
vspec.loader.exec_module(VERIFY)

AUTHORIZED_JOB_BYTES = 10_000_000_000
CHUNKS_PER_TILE = 20
WORST_SET_BYTES = 8_500_000          # largest probed t2m+d2m+sp set was 8.10 MB
BYTES_PER_CELL_ON_DISK = 12_700_000  # measured: 8.6 MB raw hourly + ~4 MB high + ~84 KB low-v1 derived per cell
TRANSIENT_RETRIES, TRANSIENT_PAUSE_S = 2, 900
FROZEN_CODE = [
    'scripts/historical-wetbulb/run_tile_backfill.py', 'scripts/historical-wetbulb/arco_pinned_source.py',
    'scripts/historical-wetbulb/reduce-tile-chunks.mjs', 'scripts/historical-wetbulb/verify_period_independent.py',
    'scripts/historical-wetbulb/account_routes.py', 'scripts/historical-wetbulb/campaign_supervisor.py',
    'lib/historical-wetbulb/aggregate.mjs', 'lib/historical-wetbulb/merge.mjs', 'lib/historical-wetbulb/publication.mjs',
    'lib/historical-wetbulb/page-history.mjs', 'lib/historical-wetbulb/grid.mjs', 'lib/forecast/romps.ts',
    'lib/historical-wetbulb/lows.mjs', 'scripts/historical-wetbulb/backfill_lows.py',
    'tests/fixtures/romps-reference-vectors.v1.json', 'tests/fixtures/romps-reference-vectors-cold.v1.json',
    'scripts/historical-wetbulb/tz-offsets.mjs', 'scripts/historical-wetbulb/tzdata-iana-2026c/MANIFEST.json',
]
STOP_PATTERNS = [
    ('provider-throttle-or-error', ('HTTP Error 429', 'HTTP Error 5')),
    ('auth-or-billing', ('HTTP Error 401', 'HTTP Error 402', 'HTTP Error 403')),
    ('disk-floor', ('GB free',)),
    ('ledger-cap', ('cap reached', 'byte allowance', 'budget exceeds')),
    ('integrity', ('checksum', 'mismatch', 'differs', 'Self-check', 'self-check', 'layout changed',
                   'unexpected size', 'CF encoding', 'time axis', 'different cell set', 'different source',
                   'low periods do not cover', 'low backfill')),
]
TRANSIENT = ('URLError', 'timed out', 'TimeoutError', 'Connection', 'RemoteDisconnected', 'IncompleteRead', 'truncated')


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def classify(error):
    error = error or ''
    for reason, needles in STOP_PATTERNS:
        if any(n in error for n in needles):
            return reason
    if any(n in error for n in TRANSIENT):
        return 'transient'
    return 'unclassified'


def code_hashes():
    return {path: RUN.sha256_file(REPO / path) for path in FROZEN_CODE}


def ledger_bytes(path):
    state = json.loads(Path(path).read_text())
    return state['settledBytes'] + sum(r['bytes'] for r in state['reservations'].values()), state['chunkAttempts']


def all_ledger_bytes():
    return sum(ledger_bytes(p)[0] for p in RUN.approval_ledger_root().glob('*.json'))


def tile_dir(out, tile):
    return out / 'tiles' / 'arco' / f't{tile[0]:03d}-{tile[1]:03d}'


def sealed_tiles(out):
    return sorted(p.parent.name for p in (out / 'tiles' / 'arco').glob('t*-*/status.json'))


def tiles_without_lows(out):
    return [name for name in sealed_tiles(out) if not (out / 'tiles' / 'arco' / name / RUN.LOW_STATUS).exists()]


def coverage_gaps(out, tile_names, verdict_files):
    """Why any of these sealed tiles lacks a passing high AND low verdict for its exact digests."""
    high = VERIFY.previously_verified(verdict_files)
    low = VERIFY.previously_verified(verdict_files, 'low')
    gaps = []
    for name in tile_names:
        folder = out / 'tiles' / 'arco' / name
        status = json.loads((folder / 'status.json').read_text())
        gaps += [f"{name}: high {p['groupKey']}" for p in status['periods'] if (p['groupKey'], p['periodSha256']) not in high]
        low_path = folder / RUN.LOW_STATUS
        if not low_path.exists():
            gaps.append(f'{name}: no low-status.json')
            continue
        record = json.loads(low_path.read_text())
        if record.get('highStatusSha256') != RUN.sha256_file(folder / 'status.json'):
            gaps.append(f'{name}: low-status.json not bound to status.json')
        # Exact group set: a truncated low-status must never pass on the strength of high verdicts.
        listed = [p['groupKey'] for p in record['lowPeriods']] + [f['groupKey'] for f in record['failedLowGroups']]
        sealed = {p['groupKey'] for p in status['periods']}
        if len(listed) != len(set(listed)) or set(listed) != sealed:
            gaps.append(f'{name}: low-status groups {sorted(set(listed) ^ sealed)[:5]} differ from sealed periods')
        gaps += [f"{name}: low failed {f['groupKey']}" for f in record['failedLowGroups']]
        gaps += [f"{name}: low {p['groupKey']}" for p in record['lowPeriods'] if (p['groupKey'], p['lowPeriodSha256']) not in low]
    return gaps


def chunks_needed(out, tiles):
    """[(tile, cells, chunks still to fetch)] for unsealed tiles, in the runner's order."""
    needed = []
    for tile, cells in tiles.items():
        folder = tile_dir(out, tile)
        if (folder / 'status.json').exists():
            continue
        have = len(list(folder.glob('chunk-*.json'))) if folder.exists() else 0
        needed.append((tile, len(cells), max(CHUNKS_PER_TILE - have, 0)))
    return needed


def plan_job(needed, max_chunks, free_bytes, floor_bytes):
    """Largest chunk budget ≤ max_chunks whose projected disk use keeps the floor."""
    chunks, projected = 0, 0
    for _tile, cells, missing in needed:
        take = min(missing, max_chunks - chunks)
        if take <= 0:
            break
        extra = cells * BYTES_PER_CELL_ON_DISK * take / CHUNKS_PER_TILE
        if free_bytes - (projected + extra) < floor_bytes:
            break
        chunks, projected = chunks + take, projected + extra
    return chunks, int(projected)


@contextlib.contextmanager
def lock_or_exit(path, message):
    with Path(path).open('a+') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit(message) from None
        yield


def run_lock_free(out):
    with (out / '.run.lock').open('a+') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        fcntl.flock(handle, fcntl.LOCK_UN)
        return True


class Campaign:
    def __init__(self, a):
        self.a = a
        self.dir = a.campaign
        self.state_path = self.dir / 'state.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {
            'schemaVersion': 1, 'name': self.dir.name, 'createdUTC': now(), 'jobs': [], 'qa': [],
            'status': 'starting', 'stopReason': None}
        self.qa_proc = None

    def save(self, **fields):
        self.state.update(fields, updatedUTC=now(), supervisorPid=os.getpid(),
                          cumulativeLedgerBytes=all_ledger_bytes(), diskFreeBytes=shutil.disk_usage(self.a.out).free)
        RUN.durable_write(self.state_path, self.state)

    def log(self, message):
        line = f'{now()} {message}'
        print(line, flush=True)
        with (self.dir / 'supervisor.log').open('a') as handle:
            handle.write(line + '\n')

    def stop(self, reason, detail=''):
        self.log(f'STOP {reason} {detail}')
        self.save(status='stopped', stopReason=reason, stopDetail=str(detail)[:1000])
        raise SystemExit(f'Campaign stopped: {reason}')

    def freeze_or_check(self, plan_sha, authority_sha):
        frozen_path = self.dir / 'frozen.json'
        current = {'planSha256': plan_sha, 'authoritySha256': authority_sha, 'code': code_hashes()}
        if not frozen_path.exists():
            RUN.durable_write(frozen_path, {**current, 'frozenUTC': now()})
            return
        frozen = json.loads(frozen_path.read_text())
        drift = [k for k in ('planSha256', 'authoritySha256') if frozen[k] != current[k]]
        drift += [p for p in FROZEN_CODE if frozen['code'].get(p) != current['code'][p]]
        if drift:
            self.stop('frozen-input-drift', drift)

    def campaign_bytes(self):
        return sum(ledger_bytes(job['ledger'])[0] for job in self.state['jobs'] if Path(job['ledger']).exists())

    # --- independent QA ------------------------------------------------------------
    def verdict_files(self):
        files = [p for p in self.a.verified]
        files += sorted(q['output'] for q in self.state['qa'] if q.get('status') == 'passed')
        return [str(f) for f in files]

    def start_qa(self, job_id):
        qa_dir = self.dir / 'qa'
        qa_dir.mkdir(exist_ok=True, mode=0o700)
        output = qa_dir / f'{job_id}.ndjson'
        cmd = [self.a.python, str(HERE / 'verify_period_independent.py'), '--tile-run', str(self.a.out), '--source', 'arco',
               '--extrema', 'both', '--vectorized', '--workers', str(self.a.qa_workers)]
        for f in self.verdict_files():
            cmd += ['--skip-verified', f]
        with output.open('w') as out, (qa_dir / f'{job_id}.err').open('w') as err:
            self.qa_proc = subprocess.Popen(cmd, cwd=REPO, stdout=out, stderr=err, start_new_session=False)
        # Every tile sealed now must be fully verified (high + low) once this QA passes.
        self.state['qa'].append({'job': job_id, 'output': str(output), 'status': 'running', 'startedUTC': now(),
                                 'sealedAtStart': sealed_tiles(self.a.out)})
        self.save()
        self.log(f'QA started for {job_id} (pid {self.qa_proc.pid})')

    def finish_qa(self):
        if self.qa_proc is None:
            return
        code = self.qa_proc.wait()
        self.qa_proc = None
        entry = self.state['qa'][-1]
        output = Path(entry['output'])
        rows = [json.loads(line) for line in output.read_text().splitlines() if line.strip()]
        groups = [r for r in rows if 'groupKey' in r and r.get('extremum', 'high') == 'high']
        lows = [r for r in rows if r.get('extremum') == 'low']
        entry.update(status='passed' if code == 0 else 'failed', exitCode=code, groups=len(groups),
                     failedGroups=sum(1 for r in groups if not r['ok']), lowGroups=len(lows),
                     failedLowGroups=sum(1 for r in lows if not r['ok']), finishedUTC=now())
        self.save()
        self.log(f"QA {entry['job']}: exit {code}, {len(groups)} high + {len(lows)} low groups, "
                 f"{entry['failedGroups']} + {entry['failedLowGroups']} failed")
        if code != 0:
            self.stop('qa-failed', f"{entry['job']}: see {output}")
        gaps = coverage_gaps(self.a.out, entry.get('sealedAtStart', sealed_tiles(self.a.out)), self.verdict_files())
        if gaps:
            entry['status'] = 'coverage-gap'
            self.stop('qa-coverage-gap', f"{entry['job']}: {len(gaps)} gaps, e.g. {gaps[:5]}")
        self.account(entry['job'])

    def account(self, label):
        acc = self.dir / 'accounting'
        acc.mkdir(exist_ok=True, mode=0o700)
        cmd = [self.a.python, str(HERE / 'account_routes.py'), '--plan', str(self.a.plan), '--tile-run', str(self.a.out),
               '--routes-out', str(acc / 'routes.json'), '--summary-out', str(acc / 'summary.json')]
        for f in self.verdict_files():
            cmd += ['--verified', f]
        result = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)
        if result.returncode:
            self.stop('accounting-error', result.stderr[-800:])
        summary = json.loads((acc / 'summary.json').read_text())
        self.save(accounting={'afterQA': label, 'verifiedCandidateRoutes': summary['verifiedCandidateRoutes'],
                              'verifiedCandidateGroups': summary['verifiedCandidateGroups'],
                              'statusCounts': summary['statusCounts'],
                              'lowVerifiedCandidateRoutes': summary['lowVerifiedCandidateRoutes'],
                              'lowVerifiedCandidateGroups': summary['lowVerifiedCandidateGroups'],
                              'lowStatusCounts': summary['lowStatusCounts']})
        self.log(f"Accounting after {label}: {summary['verifiedCandidateRoutes']} verified-candidate routes "
                 f"({summary['verifiedCandidateGroups']} groups); lows {summary['lowVerifiedCandidateRoutes']} routes "
                 f"({summary['lowVerifiedCandidateGroups']} groups)")

    # --- acquisition jobs ----------------------------------------------------------
    def write_approval(self, job_id, stage, chunks, max_bytes, plan_sha, authority_sha):
        path = RUN.issue57_root() / 'approvals' / f'{self.dir.name}-{job_id}.json'
        if path.exists():
            raise FileExistsError(f'{path} already exists; job ids never repeat')
        RUN.durable_write(path, {
            'scope': 'acquire-era5land-arco', 'approvedBy': 'Michael Green', 'approvedAt': '2026-10-11',
            'authority': f'approvals/{self.a.authority.name}: sequential source-transfer jobs of at most '
                         f'{AUTHORIZED_JOB_BYTES:,} bytes each; generated by campaign_supervisor.py',
            'authoritySha256': authority_sha, 'planSha256': plan_sha, 'stages': [stage],
            'maxChunkFetches': chunks, 'maxBytes': max_bytes, 'campaign': self.dir.name, 'job': job_id,
            'createdUTC': now()})
        return path

    def run_job(self, stage, chunks, max_bytes, projected, plan_sha, authority_sha):
        job_id = f'job-{len(self.state["jobs"]) + 1:03d}'
        approval = self.write_approval(job_id, stage, chunks, max_bytes, plan_sha, authority_sha)
        ledger = RUN.approval_ledger_root() / f'{RUN.sha256_file(approval)}.json'
        job = {'id': job_id, 'stage': stage, 'approval': str(approval), 'ledger': str(ledger), 'maxNewChunks': chunks,
               'maxBytes': max_bytes, 'projectedDiskBytes': projected, 'startedUTC': now(), 'status': 'running'}
        self.state['jobs'].append(job)
        self.save(status='acquiring', currentJob=job_id, currentStage=stage)
        self.log(f'{job_id} {stage}: ≤{chunks} chunk sets, ≤{max_bytes:,} B, projected disk {projected / 1e9:.1f} GB')
        progress_path = self.a.out / f'progress-{stage}-arco.json'
        before = progress_path.stat().st_mtime if progress_path.exists() else 0
        cmd = [self.a.python, str(HERE / 'run_tile_backfill.py'), '--plan', str(self.a.plan), '--stage', stage,
               '--source', 'arco', '--approval', str(approval), '--out', str(self.a.out), '--max-new-chunks', str(chunks),
               '--pause-seconds', str(self.a.pause_seconds), '--min-free-gb', str(self.a.min_free_gb), '--execute']
        with (self.dir / 'logs').joinpath(f'{job_id}.log').open('w') as log:
            code = subprocess.run(cmd, cwd=REPO, stdout=log, stderr=subprocess.STDOUT).returncode
        progress = json.loads(progress_path.read_text()) if progress_path.exists() and progress_path.stat().st_mtime > before else {}
        used, attempts = ledger_bytes(ledger) if ledger.exists() else (0, 0)
        tail = (self.dir / 'logs' / f'{job_id}.log').read_text()[-1500:]
        job.update(status=progress.get('outcome', 'no-progress'), exitCode=code, ledgerBytes=used, chunkAttempts=attempts,
                   tilesComplete=progress.get('complete'), error=progress.get('error') or (tail if code else None),
                   finishedUTC=now())
        self.save(currentJob=None)
        self.log(f"{job_id} {job['status']} exit {code}: {attempts} attempts, {used:,} B")
        return job

    def wait_for_writer(self):
        waited = False
        while not run_lock_free(self.a.out):
            if not waited:
                self.log('Waiting for the active run on this output folder to finish (no concurrent fetches)')
                self.save(status='waiting-for-active-run')
                waited = True
            self.check_stop_file()
            time.sleep(120)

    def backfill_lows(self):
        """Offline, blocking: sealed tiles without lows get them from retained chunks."""
        pending = tiles_without_lows(self.a.out)
        if not pending:
            return
        self.log(f'Backfilling lows offline for {len(pending)} sealed tiles before QA')
        self.save(status='backfilling-lows')
        cmd = [self.a.python, str(HERE / 'backfill_lows.py'), '--out', str(self.a.out), '--min-free-gb', str(self.a.min_free_gb),
               '--workers', str(self.a.qa_workers)]
        with (self.dir / 'logs').joinpath(f'lows-backfill-{now().replace(":", "")}.log').open('w') as log:
            code = subprocess.run(cmd, cwd=REPO, stdout=log, stderr=subprocess.STDOUT).returncode
        left = tiles_without_lows(self.a.out)
        if code or left:
            self.stop('low-backfill-failed', f'exit {code}; {len(left)} sealed tiles still lack lows')

    def check_stop_file(self):
        if (self.dir / 'STOP').exists():
            self.finish_qa()
            self.stop('operator-stop', 'STOP file present')

    def run(self):
        a = self.a
        plan_sha, authority_sha = RUN.sha256_file(a.plan), RUN.sha256_file(a.authority)
        if plan_sha != a.expect_plan_sha256:
            self.stop('plan-hash-mismatch', plan_sha)
        for job in self.state['jobs']:
            if job['status'] == 'running':
                job['status'] = 'interrupted'  # its ledger keeps every charge; a new job resumes the tiles
        for qa in self.state['qa']:
            if qa['status'] == 'running':
                qa['status'] = 'interrupted'
        self.freeze_or_check(plan_sha, authority_sha)
        self.save(status='running', stopReason=None, stages=a.stage)
        # Restart restores the QA-lag invariant before any new fetch: an interrupted QA, a
        # job that ended between acquisition and QA, or a killed job all leave sealed tiles
        # unverified. One blocking sweep verifies every sealed, not-yet-passed group (cheap
        # when nothing is pending) and re-runs accounting; any failure stops here.
        self.wait_for_writer()
        self.backfill_lows()
        self.start_qa(f'catchup-{len(self.state["qa"]) + 1:03d}')
        self.finish_qa()
        plan_rows = json.loads(a.plan.read_text())['rows']
        transient = 0
        for stage in a.stage:
            tiles = RUN.stage_tiles(plan_rows, stage)
            while True:
                self.check_stop_file()
                self.wait_for_writer()
                self.freeze_or_check(plan_sha, authority_sha)
                needed = chunks_needed(a.out, tiles)
                if not needed:
                    self.log(f'Stage {stage}: all {len(tiles)} tiles sealed')
                    break
                failed_tiles = [str(tile_dir(a.out, t)) for t in tiles if (tile_dir(a.out, t) / 'failed.json').exists()]
                if failed_tiles:
                    self.finish_qa()
                    self.stop('reduce-failed', failed_tiles[:5])
                missing_lows = tiles_without_lows(a.out)
                if missing_lows:  # only a crash between seal and low write; a restart backfills + QAs them
                    self.finish_qa()
                    self.stop('low-coverage-absent', missing_lows[:5])
                remaining_campaign = a.campaign_max_bytes - self.campaign_bytes()
                max_bytes = min(a.job_max_bytes, remaining_campaign)
                max_chunks = min(int((max_bytes - 50_000_000) // WORST_SET_BYTES), sum(n for *_, n in needed))
                if max_chunks < 1:
                    self.finish_qa()
                    self.stop('campaign-byte-ceiling', f'{self.campaign_bytes():,} B used of {a.campaign_max_bytes:,}')
                chunks, projected = plan_job(needed, max_chunks, shutil.disk_usage(a.out).free, a.min_free_gb * 1e9)
                if chunks < 1:
                    self.finish_qa()
                    self.stop('disk-floor', f'free {shutil.disk_usage(a.out).free / 1e9:.1f} GB; floor {a.min_free_gb} GB')
                job = self.run_job(stage, chunks, max_bytes, projected, plan_sha, authority_sha)
                if job['status'] in ('bounded', 'finished') and job['exitCode'] == 0:
                    transient = 0
                    self.finish_qa()          # QA of the previous job must pass before this one's QA starts
                    self.start_qa(job['id'])  # …and runs while the next job fetches
                    time.sleep(a.between_jobs_s)
                    continue
                reason = classify(job.get('error'))
                if reason == 'transient' and transient < TRANSIENT_RETRIES:
                    transient += 1
                    # Same QA-lag gate as a clean job end: the previous QA must pass before the
                    # retry fetches, and tiles this job sealed before failing are verified next.
                    self.finish_qa()
                    self.start_qa(job['id'])
                    self.log(f"Transient failure ({transient}/{TRANSIENT_RETRIES}); pausing {TRANSIENT_PAUSE_S}s: {job.get('error')}")
                    self.save(status='transient-backoff')
                    time.sleep(TRANSIENT_PAUSE_S)
                    continue
                self.finish_qa()
                self.stop(reason if reason != 'transient' else 'transient-retries-exhausted', job.get('error'))
        self.finish_qa()
        self.start_qa(f'final-{len(self.state["qa"]) + 1:03d}')  # sweeps anything sealed outside campaign jobs
        self.finish_qa()
        self.log('All requested stages sealed and verified; stopping for review before the next stage')
        self.save(status='complete-awaiting-review', stopReason='requested-stages-complete')


def status(a):
    state = json.loads((a.campaign / 'state.json').read_text())
    pid = state.get('supervisorPid')
    alive = bool(pid) and Path(f'/proc/{pid}').exists()
    live = {}
    if state.get('currentJob'):
        job = next(j for j in state['jobs'] if j['id'] == state['currentJob'])
        if Path(job['ledger']).exists():
            used, attempts = ledger_bytes(job['ledger'])
            live = {'job': job['id'], 'stage': job['stage'], 'chunkAttempts': attempts, 'maxNewChunks': job['maxNewChunks'],
                    'bytes': used, 'maxBytes': job['maxBytes']}
    print(json.dumps({'status': state['status'], 'stopReason': state.get('stopReason'), 'supervisorAlive': alive,
                      'supervisorPid': pid, 'liveJob': live, 'jobs': [{k: j.get(k) for k in ('id', 'stage', 'status', 'chunkAttempts', 'ledgerBytes')} for j in state['jobs']],
                      'qa': [{k: q.get(k) for k in ('job', 'status', 'groups', 'failedGroups', 'lowGroups', 'failedLowGroups')}
                             for q in state['qa']],
                      'sealedTiles': len(sealed_tiles(a.out)), 'sealedTilesWithoutLows': len(tiles_without_lows(a.out)),
                      'accounting': state.get('accounting'), 'cumulativeLedgerBytes': all_ledger_bytes(),
                      'diskFreeGB': round(shutil.disk_usage(a.out).free / 1e9, 1), 'updatedUTC': state.get('updatedUTC')}, indent=1))


def refreeze(a, reason):
    """Controlled re-freeze at a stopped boundary: committed code only, old freeze archived."""
    frozen_path = a.campaign / 'frozen.json'
    if not frozen_path.exists() or not (a.campaign / 'STOP').exists():
        raise SystemExit('Re-freeze needs an existing frozen.json and the STOP file (stopped boundary)')
    dirty = subprocess.run(['git', 'status', '--porcelain', '--', *FROZEN_CODE], cwd=REPO, capture_output=True, text=True)
    if dirty.returncode or dirty.stdout.strip():
        raise SystemExit(f'Frozen code must be committed before a re-freeze: {dirty.stdout.strip()[:500]}')
    commit = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()
    with lock_or_exit(a.campaign / '.supervisor.lock', 'A supervisor is running; stop it before a re-freeze'):
        old = json.loads(frozen_path.read_text())
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        archive = a.campaign / f'frozen-{stamp}.json'
        if archive.exists():
            raise SystemExit(f'{archive} exists; refusing to overwrite an archived freeze')
        shutil.copy2(frozen_path, archive)
        if RUN.sha256_file(archive) != RUN.sha256_file(frozen_path):
            raise SystemExit('Archived freeze does not match; refusing to continue')
        new = {'planSha256': RUN.sha256_file(a.plan), 'authoritySha256': RUN.sha256_file(a.authority), 'code': code_hashes(),
               'frozenUTC': now(), 'commit': commit, 'reason': reason, 'previousFreeze': archive.name,
               'previousFreezeSha256': RUN.sha256_file(archive)}
        if new['planSha256'] != old['planSha256'] or new['authoritySha256'] != old['authoritySha256']:
            raise SystemExit('Plan or authority changed; a re-freeze only covers reviewed code changes')
        RUN.durable_write(frozen_path, new)
        changed = sorted(p for p in FROZEN_CODE if old['code'].get(p) != new['code'][p])
        line = f'{stamp} re-freeze ({commit[:7]}): {reason}; changed {changed}; previous kept as {archive.name}'
        with (a.campaign / 'supervisor.log').open('a') as handle:
            handle.write(line + '\n')
        print(line)


def main():
    root = RUN.issue57_root()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--campaign', type=Path, default=root / 'campaign-20261011')
    p.add_argument('--plan', type=Path, default=root / 'plan' / 'all-routes-plan.json')
    p.add_argument('--expect-plan-sha256', default='efb9c7ae9f787a07a245c89962c91b802b36f35d46408c442b20c818e794d626')
    p.add_argument('--authority', type=Path, default=root / 'approvals' / 'michael-overnight-20261011.md')
    p.add_argument('--out', type=Path, default=root / 'pilot-pinned-20261011')
    p.add_argument('--stage', action='append', help='Stages in order (default: top50, varied-regions)')
    p.add_argument('--python', default=str(Path.home() / '.local/share/wetbulb35/historical-wbt/venv/bin/python'))
    p.add_argument('--verified', type=Path, action='append', default=[], help='Completed verifier output to credit')
    p.add_argument('--job-max-bytes', type=int, default=AUTHORIZED_JOB_BYTES)
    p.add_argument('--campaign-max-bytes', type=int, default=40_000_000_000)
    p.add_argument('--min-free-gb', type=float, default=40)
    p.add_argument('--pause-seconds', type=float, default=2.5)
    p.add_argument('--between-jobs-s', type=int, default=60)
    p.add_argument('--qa-workers', type=int, default=2)
    p.add_argument('--status', action='store_true')
    p.add_argument('--refreeze', metavar='REASON', help='Re-freeze committed code at a stopped boundary, then exit')
    a = p.parse_args()
    a.stage = a.stage or ['top50', 'varied-regions']
    if a.status:
        return status(a)
    if a.refreeze:
        return refreeze(a, a.refreeze)
    if not 1 <= a.job_max_bytes <= AUTHORIZED_JOB_BYTES or a.min_free_gb < 40 or a.pause_seconds < 2.5:
        raise SystemExit('Job cap above the 10 GB authorization, disk floor under 40 GB, or pacing under 2.5 s')
    if 'remaining' in a.stage or any(s.startswith('remaining') for s in a.stage):
        raise SystemExit('The remaining stage needs the storage/retention/backup decision first')
    RUN.check_private_out(a.out)
    RUN.check_private_out(a.campaign)
    a.campaign.mkdir(parents=True, exist_ok=True, mode=0o700)
    (a.campaign / 'logs').mkdir(exist_ok=True, mode=0o700)
    with lock_or_exit(a.campaign / '.supervisor.lock', 'Another supervisor holds this campaign; refusing to start'):
        campaign = Campaign(a)
        signal.signal(signal.SIGTERM, lambda *_: campaign.stop('terminated', 'SIGTERM'))
        campaign.run()


if __name__ == '__main__':
    main()
