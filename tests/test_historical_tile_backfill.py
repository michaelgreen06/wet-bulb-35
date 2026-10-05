import hashlib
import json
import math
import fcntl
import os
import struct
import subprocess
import sys
import tempfile
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts/historical-wetbulb'


def load(name):
    spec = spec_from_file_location(name.removesuffix('.py'), SCRIPTS / name)
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RUN = load('run_tile_backfill.py')
ARCO = load('arco_pinned_source.py')
HOUR = 3_600_000


def fake_job(root, cell, year, rows, rank=2):
    """Synthetic PR #41-shaped checkpoint (test fixture only, never data)."""
    job = Path(root) / f'r{rank:02d}-y{year}'
    (job / 'normalized').mkdir(parents=True)
    body = ''.join(json.dumps(r) + '\n' for r in rows).encode()
    manifest = {'files': {cell: {'file': 'cell-x.ndjson', 'sha256': hashlib.sha256(body).hexdigest(), 'hours': len(rows)}},
                'sourceSha256': 'f' * 64}
    (job / 'normalized' / 'cell-x.ndjson').write_bytes(body)
    (job / 'normalized' / 'manifest.json').write_text(json.dumps(manifest))
    status = {'status': 'complete', 'plan': {'cellKey': cell, 'year': year},
              'normalizedManifestSha256': hashlib.sha256((job / 'normalized' / 'manifest.json').read_bytes()).hexdigest()}
    (job / 'status.json').write_text(json.dumps(status))
    return job


def hours(start, end, cell=(1.0, 2.0), offset=0.0, vary=False):
    out, ms = [], RUN.parse_iso(start)
    while ms <= RUN.parse_iso(end):
        bump = struct.unpack('<f', struct.pack('<f', (ms // HOUR % 997) / 100))[0] if vary else 0.0
        out.append({'timeUTC': RUN.iso_ms(ms), 'temperatureK': 300.5 + offset + bump, 'dewpointK': 290.25,
                    'pressurePa': 100000.0, 'gridCell': list(cell)})
        ms += HOUR
    return out


class TestTileBackfill(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

    def test_private_destinations_only(self):
        with self.assertRaises(ValueError):
            RUN.check_private_out(RUN.REPO / 'scratch')
        with self.assertRaises(ValueError):
            RUN.check_private_out(RUN.PRIVATE_READ_ONLY / 'new')
        self.assertEqual(RUN.check_private_out(self.base / 'ok'), (self.base / 'ok').resolve())

    def test_stage_tiles_groups_cells_and_timezones(self):
        rows = [{'group': '1.0,2.0|UTC', 'tile': [1, 2], 'stage': 'remaining-001'},
                {'group': '1.0,2.0|Asia/Dubai', 'tile': [1, 2], 'stage': 'remaining-001'},
                {'group': '1.1,2.0|UTC', 'tile': [1, 2], 'stage': 'remaining-001'},
                {'tile': [9, 9], 'stage': None}, {'group': '5.0,5.0|UTC', 'tile': [3, 3], 'stage': 'pilot'}]
        self.assertEqual(RUN.stage_tiles(rows, 'remaining'), {(1, 2): {'1.0,2.0': ['Asia/Dubai', 'UTC'], '1.1,2.0': ['UTC']}})
        self.assertEqual(list(RUN.stage_tiles(rows, 'pilot')), [(3, 3)])

    def test_chunk_checksums_are_verified_on_restart(self):
        tile = self.base / 'tile'
        RUN.write_chunk(tile, 0, cells=['1.0,2.0'], start_ms=0, hours=2, values=[1.0] * 6, data_start_ms=0, source={'pinned': False})
        self.assertEqual(RUN.verified_chunk(tile, 0)['hours'], 2)
        self.assertIsNone(RUN.verified_chunk(tile, 1))
        raw = bytearray((tile / 'chunk-0000.bin').read_bytes())
        raw[0] ^= 1
        (tile / 'chunk-0000.bin').write_bytes(raw)
        with self.assertRaises(ValueError):
            RUN.verified_chunk(tile, 0)
        with self.assertRaises(ValueError):
            RUN.write_chunk(tile, 1, cells=['a'], start_ms=0, hours=2, values=[1.0] * 5, data_start_ms=0, source={})

    def test_archive_replays_years_and_rejects_disagreeing_overlaps(self):
        jobs = self.base / 'jobs'
        fake_job(jobs, '1.0,2.0', 1950, hours('1950-01-02T00:00:00.000Z', '1951-01-02T23:00:00.000Z'))
        fake_job(jobs, '1.0,2.0', 1951, hours('1950-12-31T00:00:00.000Z', '1952-01-02T23:00:00.000Z'))
        source = RUN.ArchiveSource(jobs, 1950, 1951)
        first = source.fetch((0, 0), ['1.0,2.0'], 0)
        self.assertEqual(first['start_ms'], RUN.parse_iso('1950-01-02T00:00:00.000Z'))
        self.assertEqual(first['hours'], 364 * 24)
        tail = source.fetch((0, 0), ['1.0,2.0'], 2)
        self.assertEqual((tail['hours'], RUN.iso_ms(tail['start_ms'])), (48, '1952-01-01T00:00:00.000Z'))
        self.assertIsNone(source.fetch((0, 0), ['9.0,9.0'], 0))
        jobs2 = self.base / 'jobs2'
        fake_job(jobs2, '1.0,2.0', 1950, hours('1950-01-02T00:00:00.000Z', '1951-01-02T23:00:00.000Z'))
        fake_job(jobs2, '1.0,2.0', 1951, hours('1950-12-31T00:00:00.000Z', '1952-01-02T23:00:00.000Z', offset=0.5))
        with self.assertRaisesRegex(ValueError, 'disagree'):
            RUN.ArchiveSource(jobs2, 1950, 1951).fetch((0, 0), ['1.0,2.0'], 1)

    def test_archive_input_tampering_is_detected(self):
        jobs = self.base / 'jobs'
        job = fake_job(jobs, '1.0,2.0', 1950, hours('1950-01-02T00:00:00.000Z', '1951-01-02T23:00:00.000Z'))
        (job / 'normalized' / 'cell-x.ndjson').write_text('{}\n')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            RUN.ArchiveSource(jobs, 1950, 1950).fetch((0, 0), ['1.0,2.0'], 0)

    def test_acquisition_approval_must_match_plan_stage_and_caps(self):
        path = self.base / 'approval.json'
        good = {'scope': 'acquire-era5land-arco', 'approvedBy': 'Michael', 'approvedAt': '2026-10-05',
                'planSha256': 'p' * 64, 'stages': ['pilot'], 'maxChunkFetches': 10, 'maxBytes': 10 ** 8}
        path.write_text(json.dumps(good))
        self.assertEqual(RUN.load_approval(path, 'p' * 64, 'pilot')['approvedBy'], 'Michael')
        for change in ({'planSha256': 'q' * 64}, {'stages': ['top50']}, {'approvedBy': ''}, {'maxBytes': 0}, {'scope': 'x'}):
            path.write_text(json.dumps({**good, **change}))
            with self.assertRaises(PermissionError):
                RUN.load_approval(path, 'p' * 64, 'pilot')

    def pinned(self, start_iso, n_hours, value=(300.5, 290.25, 100000.0), digest='d'):
        return {'cells': ['1.0,2.0'], 'start_ms': RUN.parse_iso(start_iso), 'hours': n_hours, 'values': list(value) * n_hours,
                'source': {'type': 'ARCO-pinned-chunks', 'pinned': True,
                           'objects': [{'key': 't2m/0.0.0', 'sha256': digest * 64, 'bytes': 1}]}}

    def self_check_setup(self):
        jobs = self.base / 'jobs'
        fake_job(jobs, '1.0,2.0', 1950, hours('1950-01-02T00:00:00.000Z', '1951-01-02T23:00:00.000Z'))
        out = self.base / 'out'
        out.mkdir()
        return RUN.ArchiveSource(jobs, 1950, 1950), out

    def test_self_check_needs_364_contiguous_unique_matching_days(self):
        archive, out = self.self_check_setup()
        with self.assertRaises(PermissionError):
            RUN.require_self_check(out)
        self.assertEqual(RUN.self_check(self.pinned('1950-01-02T00:00:00.000Z', 8760), archive, out), 8736)
        self.assertEqual(RUN.require_self_check(out), 8736)  # hours inside the archived 1950 file only

    def test_replaying_a_short_span_never_accumulates_into_approval(self):
        archive, out = self.self_check_setup()
        for i in range(200):  # same 48 hours re-fetched again and again (e.g. after deleting chunk/status)
            RUN.self_check(self.pinned('1950-03-01T00:00:00.000Z', 48, digest='abcdef'[i % 6]), archive, out)
        with self.assertRaises(PermissionError):
            RUN.require_self_check(out)
        evidence = json.loads((out / 'self-check.json').read_text())
        self.assertEqual(evidence['cells']['1.0,2.0'], [[RUN.parse_iso('1950-03-01T00:00:00.000Z'), RUN.parse_iso('1950-03-03T00:00:00.000Z')]])

    def test_disjoint_spans_do_not_add_up_to_a_contiguous_year(self):
        archive, out = self.self_check_setup()
        RUN.self_check(self.pinned('1950-01-02T00:00:00.000Z', 4400), archive, out)
        RUN.self_check(self.pinned('1950-07-10T00:00:00.000Z', 4300), archive, out)  # leaves a gap
        with self.assertRaises(PermissionError):
            RUN.require_self_check(out)
        RUN.self_check(self.pinned('1950-07-03T00:00:00.000Z', 200), archive, out)  # closes the gap
        self.assertEqual(RUN.require_self_check(out), 8736)

    def test_mismatch_is_durable_and_unpinned_or_legacy_evidence_is_refused(self):
        archive, out = self.self_check_setup()
        with self.assertRaisesRegex(ValueError, 'Self-check failed'):
            RUN.self_check(self.pinned('1950-01-02T00:00:00.000Z', 24, value=(300.5, 290.25, 100000.5)), archive, out)
        RUN.self_check(self.pinned('1950-01-02T00:00:00.000Z', 8760), archive, out)
        with self.assertRaises(PermissionError):
            RUN.require_self_check(out)  # an earlier mismatch blocks until reviewed
        unpinned = self.pinned('1950-01-02T00:00:00.000Z', 24)
        unpinned['source'] = {'type': 'ARCO-unpinned-research-archive', 'pinned': False}
        with self.assertRaisesRegex(ValueError, 'content-pinned'):
            RUN.self_check(unpinned, archive, out)
        (out / 'self-check.json').write_text(json.dumps({'schemaVersion': 1, 'comparedHours': 10 ** 6, 'mismatches': 0}))
        with self.assertRaises(PermissionError):
            RUN.require_self_check(out)


PLAN = load('plan_all_routes.py')
VERIFY = load('verify_period_independent.py')


class TestEndToEnd(unittest.TestCase):
    """Python orchestrator → Node reducer → planner scan → independent verifier, on synthetic hours."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.jobs, self.out = base / 'jobs', base / 'out'
        fake_job(self.jobs, '1.0,2.0', 1950, hours('1950-01-02T00:00:00.000Z', '1951-01-02T23:00:00.000Z', vary=True))
        fake_job(self.jobs, '1.0,2.0', 1951, hours('1950-12-31T00:00:00.000Z', '1952-01-02T23:00:00.000Z', vary=True))
        self.groups = {'1.0,2.0': ['Asia/Kolkata', 'Pacific/Kiritimati', 'UTC']}

    def run_tile(self, source=None):
        source = source or RUN.ArchiveSource(self.jobs, 1950, 1951)
        return RUN.run_tile((1, 2), self.groups, source, self.out, start_year=1950, end_year=1951,
                            budget={'remaining': 10}, pause=0)

    def test_full_chain_restart_and_independent_check(self):
        status, fetched = self.run_tile()
        self.assertEqual((fetched, len(status['periods']), status['failedGroups']), (3, 3, []))
        research = PLAN.scan_research([self.out])
        self.assertEqual(sorted(k for k, v in research.items() if v['period']),
                         ['1.0,2.0|Asia/Kolkata', '1.0,2.0|Pacific/Kiritimati', '1.0,2.0|UTC'])
        tile_dir = self.out / 'tiles' / 'archive' / 't001-002'
        for manifest in sorted((self.out / 'groups' / 'archive').glob('*/manifest.json')):
            result = VERIFY.verify_tile_group(manifest.parent, tile_dir, 1)
            self.assertTrue(result['ok'], result)
        (tile_dir / 'status.json').unlink()
        (tile_dir / 'chunk-0001.bin').unlink()
        again, fetched = self.run_tile()
        self.assertEqual((fetched, again['periods']), (1, status['periods']))

    def test_restart_refuses_chunks_or_status_from_another_source(self):
        self.run_tile()
        class Other(RUN.ArchiveSource):
            chunk_type = 'ARCO-pinned-chunks'
        (self.out / 'tiles' / 'archive' / 't001-002' / 'status.json').unlink()
        with self.assertRaisesRegex(ValueError, 'different source'):
            self.run_tile(Other(self.jobs, 1950, 1951))

    def test_ledger_charges_before_requests_and_survives_failures_and_restarts(self):
        self.out.mkdir()
        approval = {'maxChunkFetches': 3, 'maxBytes': 1000}
        ledger = RUN.ApprovalLedger(self.out, 'a' * 64, approval)
        ledger.begin_chunk()
        rid = ledger.reserve('u1', 400)
        ledger.settle(rid, 250)                      # completed: charged what was received
        ledger.begin_chunk()
        ledger.reserve('u2', 500)                    # request dies: never settled
        again = RUN.ApprovalLedger(self.out, 'a' * 64, approval)   # fresh run after the crash
        self.assertEqual((again.remaining_chunks(), again.remaining_bytes()), (1, 250))
        with self.assertRaises(PermissionError):
            again.reserve('u3', 251)                 # cannot exceed what remains
        with self.assertRaises(PermissionError):
            again.settle(again.reserve('u3', 100), 101)
        again.begin_chunk()
        with self.assertRaises(PermissionError):
            again.begin_chunk()
        self.assertEqual(RUN.ApprovalLedger(self.out, 'b' * 64, approval).remaining_chunks(), 3)
        (self.out / f"approval-ledger-{'a' * 16}.json").write_text(json.dumps({'chunks': 0, 'bytes': 0}))
        with self.assertRaises(PermissionError):
            RUN.ApprovalLedger(self.out, 'a' * 64, approval)  # legacy/tampered ledger is not trusted

    def test_failed_fetch_counts_and_never_writes_a_chunk_or_status(self):
        self.out.mkdir()
        ledger = RUN.ApprovalLedger(self.out, 'c' * 64, {'maxChunkFetches': 5, 'maxBytes': 10 ** 6})

        class Broken:
            name, chunk_type, data_start_ms = 'arco', 'ARCO-pinned-chunks', 0

            def chunk_count(self, tile, cells):
                return 2

            def fetch(self, tile, cells, index):
                raise ConnectionResetError('interrupted')
        with self.assertRaises(ConnectionResetError):
            RUN.run_tile((1, 2), self.groups, Broken(), self.out, start_year=1950, end_year=1951,
                         budget={'remaining': 5}, pause=0, ledger=ledger)
        self.assertEqual(RUN.ApprovalLedger(self.out, 'c' * 64, {'maxChunkFetches': 5, 'maxBytes': 10 ** 6}).remaining_chunks(), 4)
        tile_dir = self.out / 'tiles' / 'arco' / 't001-002'
        self.assertFalse((tile_dir / 'status.json').exists())
        self.assertFalse(list(tile_dir.glob('chunk-*')) if tile_dir.exists() else [])


LEDGER_WORKER = '''
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('run', sys.argv[1]); run = importlib.util.module_from_spec(spec); spec.loader.exec_module(run)
approval = json.loads(sys.argv[3])
ledger = run.ApprovalLedger(sys.argv[2], 'd' * 64, approval)   # constructed early: in-memory state goes stale
settled = refused = 0
for i in range(40):
    try:
        ledger.begin_chunk()
        rid = ledger.reserve(f'u{i}', 30)
        ledger.settle(rid, 20)
        settled += 20
    except PermissionError:
        refused += 1
print(json.dumps({'settled': settled, 'refused': refused}))
'''


class TestConcurrency(unittest.TestCase):
    """Serialized, fail-closed accounting even with several ledger objects or processes."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name)

    def test_stale_ledger_objects_cannot_spend_the_same_allowance(self):
        approval = {'maxChunkFetches': 2, 'maxBytes': 1000}
        first = RUN.ApprovalLedger(self.out, 'a' * 64, approval)
        second = RUN.ApprovalLedger(self.out, 'a' * 64, approval)   # loaded before first spends
        first.begin_chunk()
        first.reserve('u1', 700)
        with self.assertRaises(PermissionError):
            second.reserve('u2', 400)                                # sees first's reservation on disk
        second.begin_chunk()
        with self.assertRaises(PermissionError):
            first.begin_chunk()                                      # cap of 2 attempts already used
        self.assertEqual(RUN.ApprovalLedger(self.out, 'a' * 64, approval).charged_bytes(), 700)

    def race(self, approval, workers=6):
        procs = [subprocess.Popen([sys.executable, '-c', LEDGER_WORKER, str(SCRIPTS / 'run_tile_backfill.py'),
                                   str(self.out), json.dumps(approval)], stdout=subprocess.PIPE, text=True)
                 for _ in range(workers)]
        results = [json.loads(p.communicate(timeout=120)[0]) for p in procs]
        final = RUN.ApprovalLedger(self.out, 'd' * 64, approval)
        self.assertEqual(final.state['reservations'], {})
        self.assertEqual(final.charged_bytes(), sum(r['settled'] for r in results))
        self.assertLessEqual(final.charged_bytes(), approval['maxBytes'])
        self.assertLessEqual(final.state['chunkAttempts'], approval['maxChunkFetches'])
        return final, results

    def test_parallel_processes_respect_the_attempt_cap_exactly(self):
        final, results = self.race({'maxChunkFetches': 100, 'maxBytes': 10 ** 6})
        self.assertEqual(final.state['chunkAttempts'], 100)
        self.assertEqual(sum(r['settled'] for r in results), 100 * 20)    # 240 tries, exactly 100 spent, none twice

    def test_parallel_processes_respect_the_byte_cap(self):
        final, results = self.race({'maxChunkFetches': 10 ** 6, 'maxBytes': 2000})
        self.assertGreater(final.charged_bytes(), 2000 - 30)                 # filled up to the last whole reservation

    def test_main_takes_the_run_lock_before_any_ledger_or_source_work(self):
        plan = self.out / 'plan.json'
        plan.write_text(json.dumps({'rows': [{'group': '1.0,2.0|UTC', 'tile': [1, 2], 'stage': 'pilot'}]}))
        approval = self.out / 'approval.json'
        approval.write_text(json.dumps({'scope': 'acquire-era5land-arco', 'approvedBy': 'Test fixture (not an approval)',
                                        'approvedAt': '2026-10-05', 'planSha256': RUN.sha256_file(plan),
                                        'stages': ['pilot'], 'maxChunkFetches': 1, 'maxBytes': 1}))
        run_out = self.out / 'run'
        run_out.mkdir()
        home = self.out / 'home'  # no ~/.cdsapirc: a constructed source fails on the token, never on the network
        home.mkdir()
        cmd = [sys.executable, str(SCRIPTS / 'run_tile_backfill.py'), '--plan', str(plan), '--stage', 'pilot',
               '--source', 'arco', '--approval', str(approval), '--out', str(run_out), '--max-new-chunks', '1', '--execute']
        env = {**os.environ, 'HOME': str(home)}
        with (run_out / '.run.lock').open('a+') as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            blocked = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=60)
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn('Another run holds the lock', blocked.stderr)
        self.assertEqual(list(run_out.glob('approval-ledger-*')), [], 'no ledger touched while another run holds the lock')
        free = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=60)
        self.assertNotEqual(free.returncode, 0)
        self.assertIn('cdsapirc', free.stderr)                       # failed on the missing token, after locking
        self.assertEqual(len(list(run_out.glob('approval-ledger-*.json'))), 1)
        progress = run_out / 'progress-pilot-arco.json'
        self.assertFalse(progress.exists() and json.loads(progress.read_text()).get('outcome') == 'finished')


class FakeArco:
    """In-memory stand-in for authenticated GETs; identity 'codec' (raw packed values)."""

    def __init__(self, times, field_values, absent=()):
        meta = {}
        for name, url in ARCO.FIELDS:
            meta.setdefault(url, {})[f'{name}/.zarray'] = {'chunks': list(ARCO.CHUNK), 'dtype': '<f4', 'filters': None,
                                                          'compressor': {'id': 'blosc'}, 'fill_value': 'NaN',
                                                          'shape': [len(times), 1801, 3600], 'order': 'C'}
        meta[ARCO.TEMP_URL]['time/.zarray'] = {'shape': [len(times)], 'chunks': [len(times)], 'dtype': '<i8'}
        meta[ARCO.TEMP_URL]['time/.zattrs'] = {'units': 'hours since 1970-01-01'}
        self.objects = {f'{url}/.zmetadata': json.dumps({'metadata': meta[url]}).encode() for url in meta}
        self.objects[f'{ARCO.TEMP_URL}/time/0'] = struct.pack(f'<{len(times)}q', *times)
        for (name, url), block in zip(ARCO.FIELDS, field_values):
            if name not in absent:
                self.objects[f'{url}/{name}/0.0.0'] = struct.pack(f'<{len(block)}f', *block)
        self.requested, self.fail = [], set()

    def get(self, url, token, limit=0):
        self.requested.append(url)
        if url in self.fail:
            raise ConnectionResetError('transfer interrupted')
        data = self.objects.get(url)
        if data is not None and len(data) > limit:
            raise PermissionError('exceeds allowance')
        return data


class TestArcoPinnedSource(unittest.TestCase):
    def setUp(self):
        first = ARCO.FIRST_MS // HOUR
        self.times = list(range(first - 24, ARCO.LAST_MS // HOUR + 25))
        size = ARCO.CHUNK[0] * ARCO.CHUNK[1] * ARCO.CHUNK[2]
        self.blocks = [[float(v % 97) + 250 for v in range(size)], [float(v % 89) + 240 for v in range(size)],
                       [100000.0 + (v % 7) for v in range(size)]]

    def ledger(self, max_bytes=10 ** 9, digest='e'):
        if not hasattr(self, 'tmp'):
            self.tmp = tempfile.TemporaryDirectory()
            self.addCleanup(self.tmp.cleanup)
        return RUN.ApprovalLedger(Path(self.tmp.name), digest * 64, {'maxChunkFetches': 100, 'maxBytes': max_bytes})

    def source(self, fake, max_bytes=10 ** 9, ledger=None):
        return ARCO.ArcoPinnedSource(ledger=ledger or self.ledger(max_bytes), token='t', get=fake.get,
                                     decode=lambda data, code: struct.unpack(f'<{len(data) // struct.calcsize(code)}{code}', data))

    def test_chunk_hashes_every_object_and_trims_to_the_stated_period(self):
        fake = FakeArco(self.times, self.blocks)
        source = self.source(fake)
        self.assertEqual(source.data_start_ms, ARCO.FIRST_MS)
        self.assertGreaterEqual(source.chunk_count((0, 0), ['-90.0,-179.9']), 1)
        chunk = source.fetch((0, 0), ['-90.0,-179.8', '-89.9,-179.9'], 0)
        self.assertEqual(chunk['start_ms'], ARCO.FIRST_MS)
        self.assertEqual([o['key'] for o in chunk['source']['objects']], ['t2m/0.0.0', 'd2m/0.0.0', 'sp/0.0.0'])
        for obj in chunk['source']['objects']:
            self.assertEqual(obj['sha256'], hashlib.sha256(fake.objects[f"{dict(ARCO.FIELDS)[obj['key'][:obj['key'].index('/')]]}/{obj['key']}"]).hexdigest())
        # cell order in the tile: (lat 0, lon 1) → position 1; (lat 1, lon 0) → position 8; first hour is index 24
        self.assertEqual(chunk['values'][:3], [self.blocks[0][24 * 32 + 1], self.blocks[1][24 * 32 + 1], self.blocks[2][24 * 32 + 1]])
        self.assertEqual(chunk['values'][3], self.blocks[0][24 * 32 + 8])
        self.assertTrue(chunk['source']['pinned'])

    def test_absent_object_is_fill_and_byte_cap_stops(self):
        chunk = self.source(FakeArco(self.times, self.blocks, absent=('sp',))).fetch((0, 0), ['-90.0,-179.9'], 0)
        self.assertTrue(math.isnan(chunk['values'][2]))
        self.assertEqual(chunk['source']['objects'][2], {'key': 'sp/0.0.0', 'absent': True})
        with self.assertRaises(PermissionError):
            self.source(FakeArco(self.times, self.blocks), max_bytes=1000)  # metadata alone exceeds the cap

    def test_every_request_is_charged_and_an_interrupted_object_stays_charged(self):
        fake = FakeArco(self.times, self.blocks)
        ledger = self.ledger(digest='f')
        source = self.source(fake, ledger=ledger)
        metadata_bytes = ledger.charged_bytes()
        self.assertEqual(metadata_bytes, sum(len(fake.objects[u]) for u in fake.requested))
        fake.fail.add(f'{ARCO.FIELDS[2][1]}/sp/0.0.0')
        with self.assertRaises(ConnectionResetError):
            source.fetch((0, 0), ['-90.0,-179.9'], 0)
        t2m = len(fake.objects[f'{ARCO.TEMP_URL}/t2m/0.0.0'])
        restarted = RUN.ApprovalLedger(Path(self.tmp.name), 'f' * 64, ledger.approval)
        # t2m + d2m settled at actual size; the interrupted sp keeps its whole allowance charged.
        self.assertEqual(restarted.charged_bytes(), metadata_bytes + 2 * t2m + min(ARCO.MAX_OBJECT_BYTES, 10 ** 9 - metadata_bytes - 2 * t2m))
        self.assertEqual(len(restarted.state['reservations']), 1)

    def test_remaining_allowance_bounds_each_request(self):
        fake = FakeArco(self.times, self.blocks)
        ledger = self.ledger(digest='g')
        source = self.source(fake, ledger=ledger)
        tight = ledger.charged_bytes() + len(fake.objects[f'{ARCO.TEMP_URL}/t2m/0.0.0']) + 10
        source.ledger = RUN.ApprovalLedger(Path(self.tmp.name), 'g' * 64, {'maxChunkFetches': 100, 'maxBytes': tight})
        with self.assertRaises(PermissionError):
            source.fetch((0, 0), ['-90.0,-179.9'], 0)  # d2m would need more than the 10 bytes left
        self.assertNotIn(f'{ARCO.PRESS_URL}/sp/0.0.0', fake.requested)

    def test_layout_or_encoding_drift_refuses(self):
        fake = FakeArco(self.times, self.blocks)
        meta = json.loads(fake.objects[f'{ARCO.TEMP_URL}/.zmetadata'])
        meta['metadata']['t2m/.zattrs'] = {'scale_factor': 0.01}
        fake.objects[f'{ARCO.TEMP_URL}/.zmetadata'] = json.dumps(meta).encode()
        with self.assertRaisesRegex(ValueError, 'CF encoding'):
            self.source(fake)
        short = FakeArco(self.times[:30], [b[:] for b in self.blocks])
        with self.assertRaisesRegex(ValueError, 'stated period'):
            self.source(short)

    def test_http_get_enforces_the_limit_while_reading(self):
        class Reply:
            def __init__(self, body, declared):
                self.body, self.read_total = body, 0
                self.headers = {} if declared is None else {'Content-Length': str(declared)}

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self, n):
                block = self.body[self.read_total:self.read_total + n]
                self.read_total += len(block)
                return block

        class Opener:
            def __init__(self, reply):
                self.reply = reply

            def open(self, request, timeout):
                return self.reply
        url = f'{ARCO.TEMP_URL}/t2m/0.0.0'
        declared = Reply(b'x' * 5000, 5000)
        with self.assertRaises(PermissionError):
            ARCO.http_get(url, 't', limit=4096, opener=Opener(declared))
        self.assertEqual(declared.read_total, 0, 'declared oversize aborts before the body')
        undeclared = Reply(b'x' * 10 ** 6, None)
        with self.assertRaises(PermissionError):
            ARCO.http_get(url, 't', limit=4096, opener=Opener(undeclared))
        self.assertLessEqual(undeclared.read_total, 4097)
        with self.assertRaisesRegex(ValueError, 'truncated'):
            ARCO.http_get(url, 't', limit=4096, opener=Opener(Reply(b'x' * 100, 200)))
        self.assertEqual(ARCO.http_get(url, 't', limit=4096, opener=Opener(Reply(b'ok', 2))), b'ok')
        with self.assertRaises(PermissionError):
            ARCO.http_get(url, 't', limit=0, opener=Opener(Reply(b'ok', 2)))

    def test_untrusted_origin_never_reaches_the_network(self):
        with mock.patch.object(ARCO.urllib.request, 'build_opener', side_effect=AssertionError('network')):
            with self.assertRaises(PermissionError):
                ARCO.http_get('https://example.invalid/x', 't', limit=10)

    def test_tile_cell_keys_follow_zarr_c_order(self):
        keys = ARCO.tile_cells((209, 358))
        self.assertEqual(len(keys), 32)
        self.assertIn('-6.2,106.8', keys)
        self.assertEqual(keys.index('-6.2,106.8'), (838 - 836) * 8 + (2867 - 2864))


if __name__ == '__main__':
    unittest.main()
