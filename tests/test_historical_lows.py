"""Low-v1 companion: one-pass reduction, offline backfill, independent verification, accounting."""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_historical_route_accounting import ACCOUNT, VERIFY, Pinned, row
from test_historical_tile_backfill import RUN, SCRIPTS, fake_job, hours

ROOT = Path(__file__).resolve().parents[1]
TILE = 't001-002'

try:
    import numpy  # noqa: F401
except ImportError:
    numpy = None


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def high_files(out):
    """Every legacy high artefact and tile status, by relative path → SHA-256."""
    files = [p for p in (out / 'groups').rglob('*.json') if 'low-v1' not in p.parts]
    files += [p for p in (out / 'tiles').rglob('*') if p.is_file() and p.name != RUN.LOW_STATUS]
    return {str(p.relative_to(out)): digest(p) for p in sorted(files)}


def strip_lows(out):
    (out / 'tiles' / 'arco' / TILE / RUN.LOW_STATUS).unlink()
    for folder in (out / 'groups' / 'arco').glob('*/low-v1'):
        shutil.rmtree(folder)


class TestLows(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        base = Path(cls.tmp.name)
        cls.jobs, cls.out = base / 'jobs', base / 'out'
        fake_job(cls.jobs, '1.0,2.0', 1950, hours('1950-01-02T00:00:00.000Z', '1951-01-02T23:00:00.000Z', vary=True))
        fake_job(cls.jobs, '1.0,2.0', 1951, hours('1950-12-31T00:00:00.000Z', '1952-01-02T23:00:00.000Z', vary=True))
        cls.groups = {'1.0,2.0': ['Asia/Kolkata', 'UTC'], '1.1,2.0': ['UTC']}
        cls.status, _ = RUN.run_tile((1, 2), cls.groups, Pinned(cls.jobs, 1950, 1951), cls.out, start_year=1950,
                                     end_year=1951, budget={'remaining': 10}, pause=0)
        cls.tile_dir = cls.out / 'tiles' / 'arco' / TILE

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def copy(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        out = Path(tmp.name) / 'out'
        shutil.copytree(self.out, out)
        return out

    def group_dirs(self, out):
        return sorted(p.parent for p in (out / 'groups' / 'arco').glob('*/manifest.json'))

    def test_new_tile_seals_highs_and_lows_from_one_pass(self):
        low = json.loads((self.tile_dir / RUN.LOW_STATUS).read_text())
        self.assertEqual(low['highStatusSha256'], digest(self.tile_dir / 'status.json'))
        self.assertEqual(low['failedLowGroups'], [])
        self.assertEqual({p['groupKey']: p['highPeriodSha256'] for p in low['lowPeriods']},
                         {p['groupKey']: p['periodSha256'] for p in self.status['periods']})
        self.assertEqual(len(low['lowPeriods']), 2, 'the masked cell has neither a high nor a low')
        for group in self.group_dirs(self.out):
            manifest = json.loads((group / 'low-v1' / 'manifest.json').read_text())
            self.assertIs(manifest['publicationApproved'], False)
            self.assertEqual(manifest['hourlyChunks'], json.loads((group / 'manifest.json').read_text())['hourlyChunks'])

    def test_independent_low_verification_passes_and_is_bound_to_both_digests(self):
        for group in self.group_dirs(self.out):
            high, low = VERIFY.verify_tile_group_extrema(group, self.tile_dir, 1)
            self.assertTrue(high['ok'], high)
            self.assertTrue(low['ok'], low)
            self.assertNotIn('periodSha256', low, 'a low verdict must never look like a high verdict')
            self.assertEqual(low['highPeriodSha256'], high['periodSha256'])
            self.assertEqual(low['lowPeriodSha256'], digest(group / 'low-v1' / 'period.json'))
            self.assertEqual(high, VERIFY.verify_tile_group(group, self.tile_dir, 1), 'high verdict unchanged by lows')

    @unittest.skipUnless(numpy, 'vectorized verifier needs NumPy (private research venv)')
    def test_vectorized_low_verdicts_equal_scalar(self):
        for group in self.group_dirs(self.out):
            scalar = VERIFY.verify_tile_group_extrema(group, self.tile_dir, 1)
            vector = VERIFY.verify_tile_group_extrema(group, self.tile_dir, 1, vectorized=True)
            strip = lambda rows: [{k: v for k, v in r.items() if k != 'solver'} for r in rows]
            self.assertEqual(strip(scalar), strip(vector))

    def test_recomputation_catches_a_wrong_low_even_when_rehashed(self):
        """Not a code-path mirror: a consistently re-hashed wrong value still fails."""
        out = self.copy()
        group = self.group_dirs(out)[0]
        folder = group / 'low-v1'
        period = json.loads((folder / 'period.json').read_text())
        period['daily']['06-15']['valueC'] -= 0.01
        text = json.dumps(period, separators=(',', ':')) + '\n'
        (folder / 'period.json').write_text(text)
        manifest = json.loads((folder / 'manifest.json').read_text())
        manifest['lowPeriodSha256'] = hashlib.sha256(text.encode()).hexdigest()
        (folder / 'manifest.json').write_text(json.dumps(manifest))
        _, low = VERIFY.verify_tile_group_extrema(group, out / 'tiles' / 'arco' / TILE, 1)
        self.assertFalse(low['ok'])
        self.assertEqual([m['key'] for m in low['valueMismatches']], ['06-15'])

    def test_low_joins_fail_closed(self):
        out = self.copy()
        group = self.group_dirs(out)[0]
        path = group / 'low-v1' / 'manifest.json'
        original = json.loads(path.read_text())
        for change, needle in (({'publicationApproved': True}, 'notPublishable'),
                               ({'highPeriodSha256': 'b' * 64}, 'highPeriodBytes'),
                               ({'hourlyChunks': original['hourlyChunks'][:-1]}, 'sameHourlyChunks'),
                               ({'timeZone': 'Asia/Tokyo'}, 'identity'),
                               ({'lowPeriodSha256': 'c' * 64}, 'checksum')):
            path.write_text(json.dumps({**original, **change}))
            with self.assertRaisesRegex(ValueError, needle):
                VERIFY.verify_tile_group_extrema(group, out / 'tiles' / 'arco' / TILE, 1)
        path.write_text(json.dumps(original))
        with self.assertRaisesRegex(ValueError, 'checksum'):
            VERIFY.verify_tile_group_extrema(group, out / 'tiles' / 'arco' / TILE, 1, expected_low_sha='d' * 64)

    def test_offline_backfill_reproduces_highs_byte_for_byte_and_restores_identical_lows(self):
        out = self.copy()
        tile_dir = out / 'tiles' / 'arco' / TILE
        lows_before = {str(p.relative_to(out)): digest(p) for p in out.rglob('*') if p.is_file() and
                       ('low-v1' in p.parts or p.name == RUN.LOW_STATUS)}
        strip_lows(out)
        before = high_files(out)
        record = RUN.backfill_tile_lows(tile_dir, out, start_year=1950, end_year=1951)
        self.assertEqual(high_files(out), before)
        self.assertEqual(record['highOutputsSha256'], RUN.high_outputs_digest(out, 'arco', self.groups))
        self.assertEqual({str(p.relative_to(out)): digest(p) for p in out.rglob('*') if p.is_file() and
                          ('low-v1' in p.parts or p.name == RUN.LOW_STATUS)}, lows_before)
        self.assertEqual(RUN.backfill_tile_lows(tile_dir, out, start_year=1950, end_year=1951), record, 'idempotent')

    def test_backfill_refuses_when_any_high_output_was_altered(self):
        out = self.copy()
        strip_lows(out)
        annual = self.group_dirs(out)[0] / 'y1950.json'
        annual.write_text(annual.read_text().replace('"schemaVersion":1', '"schemaVersion":1 '))
        with self.assertRaisesRegex(ValueError, 'differs from retained'):
            RUN.backfill_tile_lows(out / 'tiles' / 'arco' / TILE, out, start_year=1950, end_year=1951)
        self.assertFalse((out / 'tiles' / 'arco' / TILE / RUN.LOW_STATUS).exists())

    def test_backfill_refuses_a_sealed_status_the_chunks_no_longer_reproduce(self):
        out = self.copy()
        strip_lows(out)
        status_path = out / 'tiles' / 'arco' / TILE / 'status.json'
        status = json.loads(status_path.read_text())
        status_path.write_text(json.dumps({**status, 'maskedCells': []}))
        with self.assertRaisesRegex(ValueError, 'differs from the sealed tile status'):
            RUN.backfill_tile_lows(status_path.parent, out, start_year=1950, end_year=1951)

    def test_run_tile_self_heals_a_sealed_tile_without_lows_and_never_fetches(self):
        out = self.copy()
        strip_lows(out)
        source = Pinned(self.jobs, 1950, 1951)
        source.fetch = lambda *a: self.fail('a sealed tile must never fetch')
        status, fetched = RUN.run_tile((1, 2), self.groups, source, out, start_year=1950, end_year=1951,
                                       budget={'remaining': 0}, pause=0)
        self.assertEqual(fetched, 0)
        self.assertTrue((out / 'tiles' / 'arco' / TILE / RUN.LOW_STATUS).exists())

    def test_verifier_cli_fails_closed_on_missing_lows_and_skips_only_same_digest(self):
        out = self.copy()
        cmd = [sys.executable, str(SCRIPTS / 'verify_period_independent.py'), '--tile-run', str(out), '--source', 'arco',
               '--workers', '1']
        full = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(full.returncode, 0, full.stderr)
        rows = [json.loads(line) for line in full.stdout.splitlines()]
        self.assertEqual(rows[0]['coldReferenceVectors'], 500)
        self.assertEqual(sorted(r.get('extremum', 'high') for r in rows[1:]), ['high', 'high', 'low', 'low'])
        verdicts = Path(out.parent) / 'verdicts.ndjson'
        verdicts.write_text(full.stdout)
        again = subprocess.run(cmd + ['--skip-verified', str(verdicts)], capture_output=True, text=True)
        self.assertEqual((again.returncode, len(again.stdout.splitlines())), (0, 1), 'nothing left to verify')
        low_path = out / 'tiles' / 'arco' / TILE / RUN.LOW_STATUS
        record = json.loads(low_path.read_text())
        low_path.write_text(json.dumps({**record, 'lowPeriods': record['lowPeriods'][:1]}))
        truncated = subprocess.run(cmd + ['--skip-verified', str(verdicts)], capture_output=True, text=True)
        self.assertEqual(truncated.returncode, 1, 'a truncated low-status never passes on earlier verdicts')
        self.assertIn('differ from the sealed periods', truncated.stdout)
        low_path.unlink()
        gap = subprocess.run(cmd + ['--skip-verified', str(verdicts)], capture_output=True, text=True)
        self.assertEqual(gap.returncode, 1)
        self.assertIn('low coverage absent', gap.stdout)
        self.assertEqual(subprocess.run(cmd + ['--extrema', 'high'], capture_output=True, text=True).returncode, 0)

    def test_cold_reference_vectors_cover_lows(self):
        data = json.loads((ROOT / 'tests/fixtures/romps-reference-vectors-cold.v1.json').read_text())
        self.assertEqual(data['source']['version'], '0.0.2')
        self.assertLessEqual(min(v['airTemperatureK'] for v in data['vectors']), 191)
        count, worst = VERIFY.reference_vectors(ROOT / 'tests/fixtures/romps-reference-vectors-cold.v1.json')
        self.assertEqual(count, 500)
        self.assertLess(worst, 1e-9)

    def test_accounting_keeps_high_statuses_and_adds_digest_bound_low_statuses(self):
        out = self.copy()
        verdicts = []
        for group in self.group_dirs(out):
            verdicts += VERIFY.verify_tile_group_extrema(group, out / 'tiles' / 'arco' / TILE, 1)
        plan = [row('/a/kolkata/', 'pending-acquisition', '1.0,2.0|Asia/Kolkata', (1, 2)),
                row('/a/utc/', 'pending-acquisition', '1.0,2.0|UTC', (1, 2)),
                row('/a/sea/', 'pending-acquisition', '1.1,2.0|UTC', (1, 2))]
        path = out.parent / 'v.ndjson'

        def run(rows):
            path.write_text(''.join(json.dumps(r) + '\n' for r in [{'referenceVectors': 500}] + rows))
            sealed, started, periods = ACCOUNT.load_runs([out], 'arco', years=(1950, 1951))
            lows, failed = ACCOUNT.load_low_runs([out], 'arco', periods, years=(1950, 1951))
            got = ACCOUNT.account(plan, sealed, started, periods, ACCOUNT.load_verdicts([path]), lows, failed,
                                  ACCOUNT.load_low_verdicts([path]))
            return {r['path']: (r['status'], r.get('lowStatus')) for r in got}

        self.assertEqual(run(verdicts), {'/a/kolkata/': (ACCOUNT.VERIFIED, ACCOUNT.LOW_VERIFIED),
                                         '/a/utc/': (ACCOUNT.VERIFIED, ACCOUNT.LOW_VERIFIED),
                                         '/a/sea/': ('unavailable-masked-cell', None)})
        highs_only = [v for v in verdicts if v.get('extremum', 'high') == 'high']
        self.assertEqual(run(highs_only)['/a/utc/'], (ACCOUNT.VERIFIED, 'low-acquired-unverified'))
        low_failed = [{**v, 'ok': False} if v.get('extremum') == 'low' else v for v in verdicts]
        self.assertEqual(run(verdicts + low_failed)['/a/utc/'], (ACCOUNT.VERIFIED, 'low-unavailable-verification-failed'))
        lows_only = [v for v in verdicts if v.get('extremum') == 'low']
        self.assertEqual(run(lows_only)['/a/utc/'], ('acquired-unverified', ACCOUNT.LOW_VERIFIED),
                         'a low verdict never verifies a high')
        strip_lows(out)
        self.assertEqual(run(verdicts)['/a/utc/'], (ACCOUNT.VERIFIED, 'low-pending-backfill'))


if __name__ == '__main__':
    unittest.main()


class TestBackfillCli(unittest.TestCase):
    """backfill_lows.py reports each tile as it finishes and stops cleanly on the first failure."""

    def setUp(self):
        from test_historical_tile_backfill import load
        self.mod = load('backfill_lows.py')
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.out = Path(tmp.name)
        for name in ('t001-001', 't001-002', 't001-003'):
            (self.out / 'tiles' / 'arco' / name).mkdir(parents=True)
            (self.out / 'tiles' / 'arco' / name / 'status.json').write_text('{}')

    def run_main(self, backfill, workers):
        from unittest import mock
        lines = []
        argv = ['backfill_lows.py', '--out', str(self.out), '--workers', str(workers)]
        with mock.patch.object(self.mod.RUN, 'check_private_out', side_effect=lambda p: Path(p)), \
                mock.patch.object(self.mod.RUN, 'backfill_tile_lows', side_effect=backfill), \
                mock.patch.object(sys, 'argv', argv), \
                mock.patch('builtins.print', side_effect=lambda text, **_: lines.append(json.loads(text))):
            try:
                self.mod.main()
            except SystemExit as stop:
                self.assertEqual(stop.code, 0)
        return lines

    def test_each_tile_is_reported_while_others_still_run(self):
        import threading
        first_reported = threading.Event()
        seen = []

        def backfill(tile_dir, out, **_):
            if tile_dir.name == 't001-002':
                seen.append(first_reported.wait(10))  # still running when t001-001 must already be reported
            return {'lowPeriods': [{}], 'failedLowGroups': []}

        from unittest import mock
        lines = []

        def capture(text, **_):
            row = json.loads(text)
            lines.append(row)
            if row.get('tile') == 't001-001':
                first_reported.set()

        argv = ['backfill_lows.py', '--out', str(self.out), '--workers', '2']
        with mock.patch.object(self.mod.RUN, 'check_private_out', side_effect=lambda p: Path(p)), \
                mock.patch.object(self.mod.RUN, 'backfill_tile_lows', side_effect=backfill), \
                mock.patch.object(sys, 'argv', argv), mock.patch('builtins.print', side_effect=capture):
            with self.assertRaises(SystemExit) as stop:
                self.mod.main()
        self.assertEqual(stop.exception.code, 0)
        self.assertEqual(seen, [True], 'progress must not wait for every tile to finish')
        self.assertEqual([r['tile'] for r in lines[:-1]][0], 't001-001')
        self.assertEqual((lines[-1]['outcome'], lines[-1]['tilesBackfilled']), ('finished', 3))

    def test_first_failure_cancels_unstarted_tiles_and_is_recorded(self):
        called = []

        def backfill(tile_dir, out, **_):
            called.append(tile_dir.name)
            if tile_dir.name == 't001-002':
                raise ValueError('t001-002: re-reduction differs from the sealed tile status')
            return {'lowPeriods': [{}], 'failedLowGroups': []}

        with self.assertRaisesRegex(ValueError, 'differs'):
            self.run_main(backfill, workers=1)
        self.assertEqual(called, ['t001-001', 't001-002'], 't001-003 never starts')
        progress = json.loads((self.out / 'progress-lows-arco.json').read_text())
        self.assertEqual((progress['outcome'], progress['tilesBackfilled']), ('failed', 1))
        self.assertIn('differs', progress['error'])
