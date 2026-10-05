import hashlib
import json
import math
import struct
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

    def test_self_check_requires_exact_archive_match_before_non_pilot_stages(self):
        jobs = self.base / 'jobs'
        fake_job(jobs, '1.0,2.0', 1950, hours('1950-01-02T00:00:00.000Z', '1951-01-02T23:00:00.000Z'))
        archive = RUN.ArchiveSource(jobs, 1950, 1950)
        start = RUN.parse_iso('1950-01-02T00:00:00.000Z')
        good = {'cells': ['1.0,2.0'], 'start_ms': start, 'hours': 8760, 'values': [300.5, 290.25, 100000.0] * 8760}
        out = self.base / 'out'
        out.mkdir()
        with self.assertRaises(PermissionError):
            RUN.require_self_check(out)
        self.assertEqual(RUN.self_check(good, archive, out), 8736)  # hours inside the archived 1950 file only
        RUN.require_self_check(out)
        bad = {**good, 'values': [300.5, 290.25, 100000.5] * 8760}
        with self.assertRaisesRegex(ValueError, 'Self-check failed'):
            RUN.self_check(bad, archive, out)


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

    def test_approval_caps_accumulate_across_runs(self):
        self.out.mkdir()
        approval = {'maxChunkFetches': 3, 'maxBytes': 1000}
        first = RUN.ApprovalLedger(self.out, 'a' * 64, approval)
        source = type('S', (), {'used_bytes': 400})()
        first.record(source)
        first.record(source)
        second = RUN.ApprovalLedger(self.out, 'a' * 64, approval)
        self.assertEqual((second.remaining_chunks(), second.remaining_bytes()), (1, 600))
        source.used_bytes = 500
        second.record(source)
        self.assertEqual(RUN.ApprovalLedger(self.out, 'a' * 64, approval).remaining_bytes(), 100)
        self.assertEqual(RUN.ApprovalLedger(self.out, 'b' * 64, approval).remaining_chunks(), 3)


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
        self.requested = []

    def get(self, url, token, limit=0):
        self.requested.append(url)
        return self.objects.get(url)


class TestArcoPinnedSource(unittest.TestCase):
    def setUp(self):
        first = ARCO.FIRST_MS // HOUR
        self.times = list(range(first - 24, ARCO.LAST_MS // HOUR + 25))
        size = ARCO.CHUNK[0] * ARCO.CHUNK[1] * ARCO.CHUNK[2]
        self.blocks = [[float(v % 97) + 250 for v in range(size)], [float(v % 89) + 240 for v in range(size)],
                       [100000.0 + (v % 7) for v in range(size)]]

    def source(self, fake, max_bytes=10 ** 9):
        return ARCO.ArcoPinnedSource(max_bytes=max_bytes, self_check_root='/nonexistent', token='t', get=fake.get,
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
            self.source(FakeArco(self.times, self.blocks), max_bytes=1000).fetch((0, 0), ['-90.0,-179.9'], 0)

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

    def test_untrusted_origin_never_reaches_the_network(self):
        with mock.patch.object(ARCO.urllib.request, 'build_opener', side_effect=AssertionError('network')):
            with self.assertRaises(PermissionError):
                ARCO.http_get('https://example.invalid/x', 't')

    def test_tile_cell_keys_follow_zarr_c_order(self):
        keys = ARCO.tile_cells((209, 358))
        self.assertEqual(len(keys), 32)
        self.assertIn('-6.2,106.8', keys)
        self.assertEqual(keys.index('-6.2,106.8'), (838 - 836) * 8 + (2867 - 2864))


if __name__ == '__main__':
    unittest.main()
