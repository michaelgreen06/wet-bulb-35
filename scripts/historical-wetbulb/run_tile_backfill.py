#!/usr/bin/env python3
"""Restartable, tile-deduplicated ERA5-Land history run for one rollout stage.

Dry-run by default. One sequential worker; per-tile hourly chunks are written
atomically with SHA-256 and verified on restart; reduction (Node, pinned Romps)
is deterministic and must reproduce retained annual files byte-for-byte.

Sources:
  archive  Replays hourly inputs already retained privately by PR #41 (read-only;
           no network). Used to prove the pipeline reproduces the pilot periods.
  arco     Approval-gated ECMWF ARCO fetch that hashes every compressed upstream
           chunk object (see arco_pinned_source.py). Refused without a matching
           approval file naming Michael, the plan digest, stages and byte/fetch caps.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import math
import os
import shutil
import struct
import subprocess
import tempfile
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HISTORY_PRIVATE = Path('.local/share/wetbulb35/historical-wbt')


def pr41_root():
    """PR #41 private research: read-only input."""
    return Path.home() / HISTORY_PRIVATE / 'private'


def issue57_root():
    """The only authorized write root for issue #57 checkpoints."""
    return Path.home() / HISTORY_PRIVATE / 'issue57-private'


def approval_ledger_root():
    """One fixed ledger folder for every run: caps are per approval digest, not per --out."""
    return issue57_root() / 'approval-ledgers'


PRIVATE_READ_ONLY = pr41_root()
HOUR_MS = 3_600_000


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for part in iter(lambda: f.read(1 << 20), b''):
            h.update(part)
    return h.hexdigest()


def iso_ms(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime('%Y-%m-%dT%H:00:00.000Z')


def parse_iso(stamp):
    return int(datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1000)


def check_private_out(out, root=None):
    """--out must resolve (symlinks followed) to a subfolder of issue57-private."""
    root = Path(root or issue57_root()).resolve()
    out = Path(out).resolve()
    if out == REPO or out.is_relative_to(REPO):
        raise ValueError('Hourly chunks and checkpoints must remain outside Git')
    if out.is_relative_to(Path(pr41_root()).resolve()):
        raise ValueError('PR #41 private research is read-only; write under issue57-private')
    if out == root or not out.is_relative_to(root):
        raise ValueError(f'--out must be a subfolder of {root}')
    if out.is_relative_to(root / 'approval-ledgers'):
        raise ValueError('--out must not be the approval-ledger folder')
    return out


def stage_tiles(plan_rows, stage):
    """Tiles assigned to a stage → {cellKey: sorted timezones} for every mapped group."""
    tiles = defaultdict(lambda: defaultdict(set))
    for row in plan_rows:
        name = row.get('stage')
        if 'group' not in row or not name:
            continue
        if name == stage or (stage == 'remaining' and name.startswith('remaining-')):
            cell_key, zone = row['group'].split('|', 1)
            tiles[tuple(row['tile'])][cell_key].add(zone)
    return {tile: {cell: sorted(zones) for cell, zones in sorted(cells.items())} for tile, cells in sorted(tiles.items())}


def write_chunk(tile_dir, index, *, cells, start_ms, hours, values, data_start_ms, source):
    """values: flat list/array of float32 [hour][cell][t2m,d2m,sp]; NaN = missing."""
    name = f'chunk-{index:04d}'
    if len(values) != hours * len(cells) * 3:
        raise ValueError('Chunk shape mismatch')
    raw = struct.pack(f'<{len(values)}f', *values)
    manifest = {'schemaVersion': 1, 'cells': cells, 'startUTC': iso_ms(start_ms), 'hours': hours,
                'dataStartUTC': iso_ms(data_start_ms), 'sha256': sha256_bytes(raw), 'source': source}
    tile_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    for suffix, data in (('.bin', raw), ('.json', (json.dumps(manifest, sort_keys=True) + '\n').encode())):
        fd, tmp = tempfile.mkstemp(prefix=f'.{name}-', dir=tile_dir)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, tile_dir / f'{name}{suffix}')
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    return manifest


def verified_chunk(tile_dir, index, chunk_type=None):
    head = tile_dir / f'chunk-{index:04d}.json'
    body = tile_dir / f'chunk-{index:04d}.bin'
    if not head.exists() or not body.exists():
        return None
    manifest = json.loads(head.read_text())
    if sha256_file(body) != manifest['sha256']:
        raise ValueError(f'{tile_dir.name}/{head.name}: retained hourly chunk checksum mismatch')
    if chunk_type is not None and manifest.get('source', {}).get('type') != chunk_type:
        raise ValueError(f'{tile_dir.name}/{head.name}: retained chunk came from a different source')
    return manifest


def durable_write(path, payload):
    """Atomic, fsynced JSON write (file and directory), so accounting survives a crash."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix=f'.{path.name}-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump(payload, handle, sort_keys=True)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


class ApprovalLedger:
    """Durable, fail-closed fetch/byte accounting, global per approval digest.

    The ledger lives in one fixed folder (issue57-private/approval-ledgers/<digest>.json)
    whatever --out a run uses, so an approval's caps cover every output folder, rerun
    and concurrent process; a run also holds that approval's exclusive run lock.

    A chunk attempt is charged before its first request. Before every GET, its full
    byte allowance is reserved and persisted; only a complete, size-checked response
    settles the reservation down to the bytes actually received. An exception, oversize
    abort or killed process leaves the full allowance charged, so a fresh run can never
    re-spend it. The ledger records consumption only; it never marks work complete.
    """

    def __init__(self, ledger_root, approval_sha256, approval):
        if not isinstance(approval_sha256, str) or len(approval_sha256) != 64:
            raise PermissionError('Approval digest must be a full SHA-256')
        root = Path(ledger_root)
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = root / f'{approval_sha256}.json'
        self.lock_path = root / f'{approval_sha256}.lock'
        self.run_lock_path = root / f'{approval_sha256}.run.lock'
        self.approval, self.approval_sha256 = approval, approval_sha256
        with self._locked():
            if not self.path.exists():
                durable_write(self.path, {'schemaVersion': 2, 'approvalSha256': approval_sha256, 'chunkAttempts': 0,
                                          'settledBytes': 0, 'reservations': {}, 'nextReservation': 0})
            self._load()

    @contextlib.contextmanager
    def _locked(self):
        # Every read-modify-write reloads the on-disk state under an exclusive lock, so
        # two ledger objects (or processes) can never spend the same allowance twice.
        with self.lock_path.open('a+') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def _load(self):
        state = json.loads(self.path.read_text())
        if (state.get('schemaVersion') != 2 or state.get('approvalSha256') != self.approval_sha256
                or not isinstance(state.get('reservations'), dict)):
            raise PermissionError('Approval ledger is unreadable or belongs to another approval; refusing to guess')
        self.state = state
        return state

    @contextlib.contextmanager
    def exclusive_run(self):
        """At most one active run per approval, whatever its --out folder."""
        with self.run_lock_path.open('a+') as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise SystemExit('Another run is already using this approval; refusing to start') from None
            try:
                yield self
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def charged_bytes(self):
        with self._locked():
            return self._charged(self._load())

    @staticmethod
    def _charged(state):
        return state['settledBytes'] + sum(r['bytes'] for r in state['reservations'].values())

    def remaining_chunks(self):
        with self._locked():
            return self.approval['maxChunkFetches'] - self._load()['chunkAttempts']

    def remaining_bytes(self):
        with self._locked():
            return self.approval['maxBytes'] - self._charged(self._load())

    def begin_chunk(self):
        with self._locked():
            state = self._load()
            if state['chunkAttempts'] >= self.approval['maxChunkFetches']:
                raise PermissionError('Approved chunk-fetch cap reached; stopping')
            state['chunkAttempts'] += 1
            durable_write(self.path, state)

    def reserve(self, url, allowance):
        with self._locked():
            state = self._load()
            if not isinstance(allowance, int) or allowance < 1 or allowance > self.approval['maxBytes'] - self._charged(state):
                raise PermissionError('Approved ARCO byte cap reached; stopping before the request')
            rid = str(state['nextReservation'])
            state['nextReservation'] += 1
            state['reservations'][rid] = {'url': url, 'bytes': allowance}
            durable_write(self.path, state)
            return rid

    def settle(self, rid, received):
        with self._locked():
            state = self._load()
            reserved = state['reservations'].get(rid)
            if reserved is None or not isinstance(received, int) or not 0 <= received <= reserved['bytes']:
                raise PermissionError('Ledger settlement does not match its reservation')
            del state['reservations'][rid]
            state['settledBytes'] += received
            durable_write(self.path, state)


class ArchiveSource:
    """Calendar-year chunks rebuilt from PR #41's retained per-year normalized cells."""
    name = 'archive'
    chunk_type = 'ARCO-unpinned-research-archive'
    data_start_ms = parse_iso('1950-01-02T00:00:00.000Z')

    def __init__(self, jobs_root, start_year, end_year):
        self.start_year, self.end_year = start_year, end_year
        self.years = defaultdict(dict)
        for status_path in sorted(Path(jobs_root).glob('r*-y*/status.json')):
            status = json.loads(status_path.read_text())
            if status.get('status') == 'complete':
                plan = status['plan']
                self.years[plan['cellKey']][plan['year']] = status_path.parent

    def chunk_count(self, tile, cells):
        return self.end_year - self.start_year + 2  # each year plus the final padded tail

    def _rows(self, cell_key, year):
        job = self.years[cell_key][year]
        status = json.loads((job / 'status.json').read_text())
        manifest_path = job / 'normalized' / 'manifest.json'
        if sha256_file(manifest_path) != status['normalizedManifestSha256']:
            raise ValueError(f'{job.name}: normalized manifest checksum mismatch')
        manifest = json.loads(manifest_path.read_text())
        record = manifest['files'][cell_key]
        raw = (job / 'normalized' / record['file']).read_bytes()
        if sha256_bytes(raw) != record['sha256']:
            raise ValueError(f'{job.name}: hourly input checksum mismatch')
        return {parse_iso(r['timeUTC']): (r['temperatureK'], r['dewpointK'], r['pressurePa'])
                for r in map(json.loads, raw.decode().splitlines())}, manifest['sourceSha256']

    def fetch(self, tile, cells, index):
        available = [c for c in cells if all(y in self.years.get(c, {}) for y in range(self.start_year, self.end_year + 1))]
        if not available:
            return None
        if index <= self.end_year - self.start_year:
            year = self.start_year + index
            start = max(parse_iso(f'{year}-01-01T00:00:00.000Z'), self.data_start_ms)
            end = parse_iso(f'{year + 1}-01-01T00:00:00.000Z')
            sources = [year] + ([year - 1] if year > self.start_year else [])
        else:
            year = self.end_year
            start = parse_iso(f'{year + 1}-01-01T00:00:00.000Z')
            end = parse_iso(f'{year + 1}-01-03T00:00:00.000Z')
            sources = [year]
        hours = (end - start) // HOUR_MS
        values, digests = [], []
        per_cell = {}
        for cell in available:
            loaded = [self._rows(cell, y) for y in sources]
            digests += [d for _, d in loaded]
            primary = loaded[0][0]
            for other, _ in loaded[1:]:  # padded overlap of adjacent years must agree exactly
                for stamp in set(primary) & set(other):
                    if primary[stamp] != other[stamp]:
                        raise ValueError(f'{cell}: adjacent retained years disagree at {iso_ms(stamp)}')
            per_cell[cell] = primary
        for h in range(hours):
            stamp = start + h * HOUR_MS
            for cell in available:
                triple = per_cell[cell].get(stamp)
                if triple is None:
                    raise ValueError(f'{cell}: retained archive lacks {iso_ms(stamp)}')
                values.extend(triple)
        return {'cells': available, 'start_ms': start, 'hours': hours, 'values': values,
                'source': {'type': 'ARCO-unpinned-research-archive', 'pinned': False,
                           'selectionSha256': sorted(set(digests))}}


SELF_CHECK_MIN_HOURS = 8_736  # 364 contiguous days


def _merge(intervals, new):
    merged = []
    for lo, hi in sorted(intervals + new):
        if merged and lo <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    return merged


def self_check(chunk, archive, out):
    """Exact equality of freshly fetched *pinned* hours with PR #41's retained hours.

    Evidence is stored as merged [start, end) UTC-hour intervals of unique matched
    (cell, hour) pairs plus the pinned upstream object digests of each contributing
    chunk, so replaying or re-fetching the same span adds nothing. Any mismatch is
    recorded durably and blocks acquisition until reviewed.
    """
    source = chunk.get('source') or {}
    if source.get('type') != 'ARCO-pinned-chunks' or source.get('pinned') is not True or not source.get('objects'):
        raise ValueError('Self-check only accepts freshly fetched, content-pinned ARCO chunks')
    path = out / 'self-check.json'
    record = json.loads(path.read_text()) if path.exists() else {'schemaVersion': 2, 'failed': None, 'cells': {}, 'chunks': {}}
    if record.get('schemaVersion') != 2:
        raise PermissionError('Legacy or unreadable self-check evidence; delete it only after review')
    cells = chunk['cells']
    runs_by_cell = {}
    for c, cell in enumerate(cells):
        years = archive.years.get(cell, {})
        if not years:
            continue
        cache, runs, run_start, previous = {}, [], None, None
        for h in range(chunk['hours']):
            stamp = chunk['start_ms'] + h * HOUR_MS
            year = datetime.fromtimestamp(stamp / 1000, tz=timezone.utc).year
            expected = None
            if year in years:
                if year not in cache:
                    cache[year] = archive._rows(cell, year)[0]
                expected = cache[year].get(stamp)
            if expected is None:
                continue
            got = tuple(chunk['values'][(h * len(cells) + c) * 3:(h * len(cells) + c) * 3 + 3])
            if tuple(struct.unpack('<3f', struct.pack('<3f', *expected))) != tuple(struct.unpack('<3f', struct.pack('<3f', *got))):
                record['failed'] = {'cell': cell, 'hourUTC': iso_ms(stamp), 'objects': source['objects']}
                durable_write(path, record)
                raise ValueError(f'Self-check failed: pinned ARCO value differs from retained archive at {cell} {iso_ms(stamp)}')
            if previous is None or stamp != previous + HOUR_MS:
                if run_start is not None:
                    runs.append([run_start, previous + HOUR_MS])
                run_start = stamp
            previous = stamp
        if run_start is not None:
            runs.append([run_start, previous + HOUR_MS])
        if runs:
            runs_by_cell[cell] = runs
    if runs_by_cell:
        identity = hashlib.sha256(json.dumps(source['objects'], sort_keys=True).encode()).hexdigest()
        record['chunks'][identity] = {'startUTC': iso_ms(chunk['start_ms']), 'hours': chunk['hours'], 'objects': source['objects']}
        for cell, runs in runs_by_cell.items():
            record['cells'][cell] = _merge(record['cells'].get(cell, []), runs)
        durable_write(path, record)
    return sum(hi - lo for runs in runs_by_cell.values() for lo, hi in runs) // HOUR_MS


def require_self_check(out):
    path = out / 'self-check.json'
    record = json.loads(path.read_text()) if path.exists() else {}
    longest = max((hi - lo for runs in record.get('cells', {}).values() for lo, hi in runs), default=0) // HOUR_MS
    if record.get('schemaVersion') != 2 or record.get('failed') is not None or longest < SELF_CHECK_MIN_HOURS or not record.get('chunks'):
        raise PermissionError('Run the pilot stage with --source arco --archive-jobs first: one cell must match the '
                              'archive exactly over ≥364 contiguous unique days, with no recorded mismatch')
    return longest


def run_tile(tile, groups, source, out, *, start_year, end_year, budget, pause, archive=None, ledger=None):
    # Each source keeps its own chunks and outputs; a restart never mixes provenance.
    tile_dir = out / 'tiles' / source.name / f't{tile[0]:03d}-{tile[1]:03d}'
    status_path = tile_dir / 'status.json'
    if status_path.exists():
        status = json.loads(status_path.read_text())
        if status.get('groups') != groups or status.get('source') != source.name:
            raise ValueError(f'{tile_dir.name}: retained tile status differs from the current plan or source')
        return status, 0
    fetched = 0
    cells = sorted(groups)
    total = source.chunk_count(tile, cells)
    for index in range(total):
        if verified_chunk(tile_dir, index, source.chunk_type):
            continue
        if budget['remaining'] <= 0:
            return {'status': 'bounded'}, fetched
        if fetched and pause:
            time.sleep(pause)
        if ledger is not None:
            ledger.begin_chunk()  # charged before any request; never refunded
        budget['remaining'] -= 1
        fetched += 1
        chunk = source.fetch(tile, cells, index)
        if chunk is None:
            return {'status': 'source-unavailable'}, fetched
        if archive is not None:
            self_check(chunk, archive, out)
        write_chunk(tile_dir, index, cells=chunk['cells'], start_ms=chunk['start_ms'], hours=chunk['hours'],
                    values=chunk['values'], data_start_ms=source.data_start_ms, source=chunk['source'])
    present = json.loads((tile_dir / 'chunk-0000.json').read_text())['cells']
    reduce_groups = {c: z for c, z in groups.items() if c in present}
    groups_file = tile_dir / 'groups.json'
    groups_file.write_text(json.dumps(reduce_groups, sort_keys=True) + '\n')
    node = shutil.which('node')
    if not node:
        raise OSError('Node.js is required for the pinned Romps reduction')
    result = subprocess.run([node, '--experimental-strip-types', str(Path(__file__).with_name('reduce-tile-chunks.mjs')),
                             '--tile-dir', str(tile_dir), '--groups', str(groups_file), '--start-year', str(start_year),
                             '--end-year', str(end_year), '--out', str(out / 'groups' / source.name)],
                            cwd=REPO, capture_output=True, text=True)
    if result.returncode:
        # Tile-level integrity failure: record it for review and let other tiles proceed; a rerun retries.
        (tile_dir / 'failed.json').write_text(json.dumps({'tile': list(tile), 'stderr': result.stderr[-2000:],
                                                          'failedUTC': datetime.now(timezone.utc).isoformat()}) + '\n')
        return {'status': 'reduce-failed'}, fetched
    reduced = json.loads(result.stdout.strip().splitlines()[-1])
    status = {'schemaVersion': 1, 'tile': list(tile), 'groups': groups, 'source': source.name,
              'reducedCells': reduced['seen'], 'maskedCells': reduced['masked'],
              'unavailableCells': reduced['unavailableCells'], 'failedGroups': reduced['failedGroups'],
              'notInSourceCells': sorted(set(groups) - set(present)), 'periods': reduced['periods'],
              'tzdata': reduced['tzdata'], 'completedUTC': datetime.now(timezone.utc).isoformat()}
    tmp = status_path.with_suffix('.tmp')
    tmp.write_text(json.dumps(status, sort_keys=True) + '\n')
    os.chmod(tmp, 0o600)
    os.replace(tmp, status_path)
    return status, fetched


def load_approval(path, plan_sha, stage):
    data = json.loads(Path(path).read_text())
    if (data.get('scope') != 'acquire-era5land-arco' or not str(data.get('approvedBy', '')).strip()
            or not data.get('approvedAt') or data.get('planSha256') != plan_sha or stage not in data.get('stages', [])
            or not isinstance(data.get('maxChunkFetches'), int) or data['maxChunkFetches'] < 1
            or not isinstance(data.get('maxBytes'), int) or data['maxBytes'] < 1):
        raise PermissionError('ARCO acquisition needs a matching approval (approver, date, plan digest, stage, caps)')
    return data


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--plan', required=True, type=Path)
    p.add_argument('--stage', required=True)
    p.add_argument('--source', required=True, choices=('archive', 'arco'))
    p.add_argument('--archive-jobs', type=Path)
    p.add_argument('--approval', type=Path)
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--start-year', type=int, default=1950)
    p.add_argument('--end-year', type=int, default=2025)
    p.add_argument('--max-new-chunks', type=int, required=True)
    p.add_argument('--pause-seconds', type=float, default=2.5)
    p.add_argument('--execute', action='store_true')
    a = p.parse_args()
    if not (a.start_year == 1950 and a.start_year <= a.end_year <= 2025) or a.max_new_chunks < 1:
        raise ValueError('Unsupported period or chunk budget')
    out = check_private_out(a.out)
    plan_sha = sha256_file(a.plan)
    plan = json.loads(a.plan.read_text())
    tiles = stage_tiles(plan['rows'], a.stage)
    if not tiles:
        raise ValueError(f'No tiles in stage {a.stage}')
    if a.source == 'archive' and not a.archive_jobs:
        raise ValueError('--archive-jobs is required for the archive source')
    approval = None
    if a.source == 'arco':
        approval = load_approval(a.approval, plan_sha, a.stage) if a.approval else None
        if a.execute and approval is None:
            raise PermissionError('ARCO acquisition is approval-gated; no --approval supplied')
    print(json.dumps({'dryRun': not a.execute, 'stage': a.stage, 'source': a.source, 'tiles': len(tiles),
                      'cells': sum(len(c) for c in tiles.values()),
                      'groups': sum(len(z) for c in tiles.values() for z in c.values()),
                      'maxNewChunks': a.max_new_chunks, 'planSha256': plan_sha}), flush=True)
    if not a.execute:
        return  # dry run: no ledger, no source construction, no request
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    budget = {'remaining': a.max_new_chunks}
    # The exclusive run lock is taken BEFORE anything that reads or charges the
    # ledger or can send a request (ledger load, cap checks, self-check, source
    # initialization with its metadata/time-axis GETs) and is held for the whole run.
    with contextlib.ExitStack() as held, (out / '.run.lock').open('a+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('Another run holds the lock for this output folder; refusing to start') from None
        archive = ledger = None
        if a.source == 'archive':
            source = ArchiveSource(a.archive_jobs, a.start_year, a.end_year)
        else:
            if a.archive_jobs:
                archive = ArchiveSource(a.archive_jobs, a.start_year, a.end_year)
            ledger = ApprovalLedger(approval_ledger_root(), sha256_file(a.approval), approval)
            held.enter_context(ledger.exclusive_run())
            if a.max_new_chunks > ledger.remaining_chunks() or ledger.remaining_bytes() <= 0:
                raise PermissionError('Chunk/byte budget exceeds what remains of the approved cap')
            if a.stage != 'pilot':
                require_self_check(out)
            import importlib.util
            spec = importlib.util.spec_from_file_location('arco_pinned_source', Path(__file__).with_name('arco_pinned_source.py'))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            source = module.ArcoPinnedSource(ledger=ledger)
        summary = defaultdict(int)
        outcome, error = 'finished', None
        try:
            for tile, groups in tiles.items():
                if shutil.disk_usage(out).free < 10_000_000_000:
                    raise OSError('Stopped: less than 10 GB free')
                status, fetched = run_tile(tile, groups, source, out, start_year=a.start_year, end_year=a.end_year,
                                           budget=budget, pause=a.pause_seconds if a.source == 'arco' else 0,
                                           archive=archive, ledger=ledger)
                summary['sourceCalls'] += fetched
                # Only a durable tile status written after reduction counts as complete.
                durable = 'status' not in status and status.get('source') == source.name and status.get('tile') == list(tile)
                summary['complete' if durable else status.get('status', 'unknown')] += 1
                summary['periods'] += len(status.get('periods', [])) if durable else 0
                if status.get('status') == 'bounded':
                    outcome = 'bounded'
                    break
        except BaseException as caught:
            outcome, error = 'failed', f'{type(caught).__name__}: {caught}'[:500]
            raise
        finally:
            progress = {'schemaVersion': 1, 'stage': a.stage, 'source': a.source, 'planSha256': plan_sha,
                        'tiles': len(tiles), 'outcome': outcome, 'error': error, **summary,
                        'updatedUTC': datetime.now(timezone.utc).isoformat()}
            durable_write(out / f'progress-{a.stage}-{a.source}.json', progress)
        print(json.dumps(progress), flush=True)


if __name__ == '__main__':
    main()
