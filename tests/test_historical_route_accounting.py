import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_historical_tile_backfill import RUN, fake_job, hours, load

ACCOUNT = load('account_routes.py')
VERIFY = load('verify_period_independent.py')


class Pinned(RUN.ArchiveSource):
    """Archive replay labelled as content-pinned; cells absent from the archive are NaN (masked)."""
    name, chunk_type = 'arco', 'ARCO-pinned-chunks'

    def expected_cells(self, tile, cells):
        return list(cells)

    def fetch(self, tile, cells, index):
        chunk = super().fetch(tile, [c for c in cells if c in self.years], index)
        missing = [c for c in cells if c not in self.years]
        values, n = [], len(chunk['cells'])
        for h in range(chunk['hours']):
            values += chunk['values'][h * n * 3:(h + 1) * n * 3] + [float('nan')] * (3 * len(missing))
        return {**chunk, 'cells': list(cells), 'values': values,
                'source': {'type': 'ARCO-pinned-chunks', 'pinned': True,
                           'objects': [{'key': f'k{index}', 'bytes': 1, 'sha256': 'a' * 64}]}}


def row(path, status, group=None, tile=None, stage='pilot'):
    out = {'path': path, 'status': status, 'stage': stage}
    if group:
        out.update(group=group, tile=list(tile))
    return out


class TestRouteAccounting(unittest.TestCase):
    """Real tile reduction + independent verification on synthetic hours, then accounting."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        base = Path(cls.tmp.name)
        jobs, cls.out = base / 'jobs', base / 'out'
        fake_job(jobs, '1.0,2.0', 1950, hours('1950-01-02T00:00:00.000Z', '1951-01-02T23:00:00.000Z', vary=True))
        fake_job(jobs, '1.0,2.0', 1951, hours('1950-12-31T00:00:00.000Z', '1952-01-02T23:00:00.000Z', vary=True))
        groups = {'1.0,2.0': ['Asia/Kolkata', 'UTC'], '1.1,2.0': ['UTC']}
        cls.status, _ = RUN.run_tile((1, 2), groups, Pinned(jobs, 1950, 1951), cls.out, start_year=1950, end_year=1951,
                                     budget={'remaining': 10}, pause=0)
        tile_dir = cls.out / 'tiles' / 'arco' / 't001-002'
        cls.verdicts = []
        for manifest in sorted((cls.out / 'groups' / 'arco').glob('*/manifest.json')):
            cls.verdicts.append(VERIFY.verify_tile_group(manifest.parent, tile_dir, 1))
        cls.plan = [
            row('/a/kolkata/', 'pending-acquisition', '1.0,2.0|Asia/Kolkata', (1, 2)),
            row('/a/utc/', 'research-complete-unpublished', '1.0,2.0|UTC', (1, 2)),
            row('/a/sea/', 'pending-acquisition', '1.1,2.0|UTC', (1, 2)),
            row('/b/later/', 'pending-acquisition', '5.0,5.0|UTC', (9, 9), stage='top50'),
            row('/c/unknown/', 'unavailable-identity-unmatched', stage=None),
        ]

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def account(self, verdicts, runs=None):
        sealed, started, periods = ACCOUNT.load_runs(runs or [self.out], 'arco', years=(1950, 1951))
        return {r['path']: r for r in ACCOUNT.account(self.plan, sealed, started, periods, verdicts)}

    def write_verdicts(self, rows):
        path = Path(self.tmp.name) / f'verdicts-{len(list(Path(self.tmp.name).glob("verdicts-*")))}.ndjson'
        path.write_text(''.join(json.dumps(r) + '\n' for r in [{'referenceVectors': 500}] + rows))
        return path

    def test_verifier_binds_its_verdict_to_the_exact_period_digest(self):
        self.assertEqual(len(self.verdicts), 2)
        for verdict in self.verdicts:
            self.assertTrue(verdict['ok'], verdict)
            self.assertRegex(verdict['periodSha256'], '^[0-9a-f]{64}$')
        self.assertEqual(sorted(v['periodSha256'] for v in self.verdicts),
                         sorted(p['periodSha256'] for p in self.status['periods']))

    def test_every_route_gets_exactly_one_evidence_based_status(self):
        rows = self.account(ACCOUNT.load_verdicts([self.write_verdicts(self.verdicts)]))
        self.assertEqual({p: r['status'] for p, r in rows.items()}, {
            '/a/kolkata/': 'verified-candidate-unpublished',
            '/a/utc/': 'verified-candidate-unpublished',      # pinned period supersedes unpinned research
            '/a/sea/': 'unavailable-masked-cell',
            '/b/later/': 'pending-acquisition',
            '/c/unknown/': 'unavailable-identity-unmatched',
        })
        self.assertEqual(rows['/a/kolkata/']['period']['first'], '1950-01-03')
        summary = ACCOUNT.summarize(list(rows.values()), 'p' * 64, {})
        self.assertEqual((summary['routes'], summary['verifiedCandidateRoutes'], summary['verifiedCandidateGroups']), (5, 2, 2))
        self.assertEqual(summary['reviewQueue'], {'unavailable-masked-cell': ['/a/sea/']})

    def test_verdicts_for_other_bytes_legacy_or_failed_never_count_as_verified(self):
        other = [{**v, 'periodSha256': 'b' * 64} for v in self.verdicts]
        legacy = [{k: v for k, v in verdict.items() if k != 'periodSha256'} for verdict in self.verdicts]
        rows = self.account(ACCOUNT.load_verdicts([self.write_verdicts(other + legacy)]))
        self.assertEqual(rows['/a/kolkata/']['status'], 'acquired-unverified')
        failed = [{**self.verdicts[0], 'ok': False}]
        rows = self.account(ACCOUNT.load_verdicts([self.write_verdicts(self.verdicts), self.write_verdicts(failed)]))
        self.assertEqual(sorted(r['status'] for r in rows.values() if r['path'].startswith('/a/') and r['path'] != '/a/sea/'),
                         ['unavailable-verification-failed', 'verified-candidate-unpublished'])

    def test_unsealed_tiles_and_tampered_periods_fail_closed(self):
        base = Path(self.tmp.name) / 'second'
        (base / 'tiles' / 'arco' / 't009-009').mkdir(parents=True)  # started, never sealed
        rows = self.account({}, runs=[self.out, base])
        self.assertEqual(rows['/b/later/']['status'], 'acquisition-incomplete')
        period = next((self.out / 'groups' / 'arco').glob('*/period.json'))
        original = period.read_bytes()
        try:
            period.write_bytes(original.replace(b'"groupKey"', b'"groupKey" '))
            with self.assertRaisesRegex(ValueError, 'period bytes differ'):
                ACCOUNT.load_runs([self.out], 'arco', years=(1950, 1951))
        finally:
            period.write_bytes(original)

    def test_a_period_shorter_than_the_stated_span_never_counts(self):
        with self.assertRaisesRegex(ValueError, 'not the stated 1950–2025 span'):
            ACCOUNT.load_runs([self.out], 'arco')                    # fixture sealed 1950–1951 only

    def test_two_runs_sealing_one_tile_differently_refuse(self):
        other = Path(self.tmp.name) / 'other'
        tile = self.out / 'tiles' / 'arco' / 't001-002'
        (other / 'tiles' / 'arco' / 't001-002').mkdir(parents=True)
        status = json.loads((tile / 'status.json').read_text())
        (other / 'tiles' / 'arco' / 't001-002' / 'status.json').write_text(json.dumps({**status, 'maskedCells': []}))
        import shutil
        shutil.copytree(self.out / 'groups', other / 'groups')
        with self.assertRaisesRegex(ValueError, 'sealed differently'):
            ACCOUNT.load_runs([self.out, other], 'arco', years=(1950, 1951))

    def test_unknown_tzdata_on_both_sides_is_not_a_pass(self):
        manifest = next((self.out / 'groups' / 'arco').glob('*/manifest.json'))
        real = VERIFY.python_tzdata_version
        VERIFY.python_tzdata_version = lambda: None
        try:
            record = json.loads(manifest.read_text())
            original = manifest.read_text()
            manifest.write_text(json.dumps({**record, 'tzdata': None}))
            result = VERIFY.verify_tile_group(manifest.parent, self.out / 'tiles' / 'arco' / 't001-002', 1)
            self.assertFalse(result['ok'])
        finally:
            VERIFY.python_tzdata_version = real
            manifest.write_text(original)

    def test_skip_verified_reuses_only_passing_verdicts_for_the_same_digest(self):
        path = self.write_verdicts(self.verdicts + [{**self.verdicts[0], 'periodSha256': 'c' * 64, 'ok': False}])
        done = VERIFY.previously_verified([path])
        self.assertEqual(done, {(v['groupKey'], v['periodSha256']) for v in self.verdicts})



try:
    import numpy  # noqa: F401
except ImportError:
    numpy = None


@unittest.skipUnless(numpy, 'vectorized verifier needs NumPy (private research venv)')
class TestVectorizedVerifier(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        TestRouteAccounting.setUpClass()
        cls.out = TestRouteAccounting.out

    @classmethod
    def tearDownClass(cls):
        TestRouteAccounting.tearDownClass()

    def test_vectorized_solver_matches_the_scalar_reference(self):
        import random
        rng = random.Random(57)
        t = numpy.array([rng.uniform(200, 335) for _ in range(3000)])
        d = numpy.array([x - rng.choice([0.0, rng.uniform(0, 60), -rng.uniform(0, 3)]) for x in t])
        p = numpy.array([rng.uniform(45000, 108000) for _ in range(3000)])
        vec = VERIFY.hourly_wet_bulb_c_vec(t, d, p)
        for i in range(len(t)):
            scalar = VERIFY.hourly_wet_bulb_c({'temperatureK': t[i], 'dewpointK': d[i], 'pressurePa': p[i]})
            # Bit-identical where NumPy's exp is libm's; SIMD exp kernels may differ by a few ulp.
            self.assertLessEqual(abs(scalar - float(vec[i])), VERIFY.VECTOR_CHECK_K)

    def test_vectorized_tile_verdicts_equal_the_scalar_verdicts(self):
        out = self.out
        tile_dir = out / 'tiles' / 'arco' / 't001-002'
        for manifest in sorted((out / 'groups' / 'arco').glob('*/manifest.json')):
            scalar = VERIFY.verify_tile_group(manifest.parent, tile_dir, 1)
            vector = VERIFY.verify_tile_group(manifest.parent, tile_dir, 1, vectorized=True)
            self.assertTrue(vector['ok'], vector)
            self.assertGreater(vector['solver']['scalarCrossChecks'], 0)
            self.assertEqual({k: v for k, v in scalar.items() if k != 'solver'}, {k: v for k, v in vector.items() if k != 'solver'})

    def test_a_vector_scalar_disagreement_fails_closed(self):
        out = self.out
        manifest = next((out / 'groups' / 'arco').glob('*/manifest.json'))
        real = VERIFY.hourly_wet_bulb_c_vec
        VERIFY.hourly_wet_bulb_c_vec = lambda t, d, p: real(t, d, p) + 1e-6
        try:
            with self.assertRaisesRegex(ValueError, 'disagrees with the scalar reference'):
                VERIFY.verify_tile_group(manifest.parent, out / 'tiles' / 'arco' / 't001-002', 1, vectorized=True)
        finally:
            VERIFY.hourly_wet_bulb_c_vec = real


if __name__ == '__main__':
    unittest.main()
