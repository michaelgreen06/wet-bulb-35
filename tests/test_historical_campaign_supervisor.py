import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/historical-wetbulb/campaign_supervisor.py'
SPEC = spec_from_file_location('campaign_supervisor', SCRIPT)
SUP = module_from_spec(SPEC)
SPEC.loader.exec_module(SUP)


class TestCampaignSupervisor(unittest.TestCase):
    def test_throttling_billing_and_corruption_stop_while_network_blips_retry(self):
        cases = {
            'HTTPError: HTTP Error 429: Too Many Requests': 'provider-throttle-or-error',
            'HTTPError: HTTP Error 503: Service Unavailable': 'provider-throttle-or-error',
            'HTTPError: HTTP Error 402: Payment Required': 'auth-or-billing',
            'HTTPError: HTTP Error 403: Forbidden': 'auth-or-billing',
            'ValueError: t001-002/chunk-0003.json: retained hourly chunk checksum mismatch': 'integrity',
            'ValueError: Self-check failed: pinned ARCO value differs': 'integrity',
            'OSError: Stopped: less than 40 GB free': 'disk-floor',
            'PermissionError: Approved ARCO byte cap reached; stopping before the request': 'ledger-cap',
            'URLError: <urlopen error [Errno -3] Temporary failure in name resolution>': 'transient',
            'TimeoutError: The read operation timed out': 'transient',
            'SystemExit: Another run holds the lock for this output folder': 'unclassified',
            None: 'unclassified',
        }
        for error, reason in cases.items():
            self.assertEqual(SUP.classify(error), reason, error)

    def test_job_size_keeps_the_disk_floor_and_never_exceeds_the_budget(self):
        needed = [((1, 1), 30, 20), ((1, 2), 10, 20), ((1, 3), 5, 20)]
        per_tile = lambda cells: cells * SUP.BYTES_PER_CELL_ON_DISK
        chunks, projected = SUP.plan_job(needed, 1000, 50e9 + per_tile(30) + per_tile(10), 50e9)
        self.assertEqual((chunks, projected), (40, per_tile(30) + per_tile(10)))
        self.assertEqual(SUP.plan_job(needed, 25, 10 ** 13, 40e9)[0], 25)          # chunk budget binds
        self.assertEqual(SUP.plan_job(needed, 1000, 40e9, 40e9), (0, 0))           # already at the floor

    def test_needed_chunks_skip_sealed_tiles_and_count_retained_chunks(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            sealed = out / 'tiles/arco/t001-001'
            partial = out / 'tiles/arco/t001-002'
            sealed.mkdir(parents=True)
            partial.mkdir(parents=True)
            (sealed / 'status.json').write_text('{}')
            for i in range(7):
                (partial / f'chunk-{i:04d}.json').write_text('{}')
            tiles = {(1, 1): {'a': []}, (1, 2): {'b': [], 'c': []}, (1, 3): {'d': []}}
            self.assertEqual(SUP.chunks_needed(out, tiles), [((1, 2), 2, 13), ((1, 3), 1, 20)])

    def test_restart_verifies_every_sealed_group_before_the_next_fetch(self):
        """An interrupted QA must be replayed (blocking) before any new job starts."""
        events = []

        class Probe(SUP.Campaign):
            def __init__(self, a):
                self.a, self.dir, self.qa_proc = a, a.campaign, None
                self.state = {'jobs': [{'id': 'job-001', 'status': 'bounded', 'ledger': '/nonexistent'}],
                              'qa': [{'job': 'job-001', 'status': 'running', 'output': '/nonexistent'}]}

            def save(self, **fields): self.state.update(fields)
            def log(self, message): pass
            def freeze_or_check(self, *_): pass
            def wait_for_writer(self): events.append('writer-free')
            def backfill_lows(self): events.append('backfill-lows')
            def start_qa(self, label): events.append(('qa-start', label))
            def finish_qa(self): events.append('qa-finish')

            def run_job(self, *args):
                events.append('fetch')
                raise SystemExit('stop after first fetch')

        with tempfile.TemporaryDirectory() as tmp:
            plan = Path(tmp) / 'plan.json'
            plan.write_text('{"rows": []}')
            a = type('A', (), {'plan': plan, 'authority': plan, 'expect_plan_sha256': SUP.RUN.sha256_file(plan),
                               'stage': [], 'campaign': Path(tmp), 'out': Path(tmp)})()
            campaign = Probe(a)
            campaign.run()
        self.assertEqual(campaign.state['qa'][0]['status'], 'interrupted')
        self.assertEqual(events[:4], ['writer-free', 'backfill-lows', ('qa-start', 'catchup-002'), 'qa-finish'])

    def test_transient_retry_settles_previous_qa_before_fetching_again(self):
        """A retry must not fetch while the previous job's QA is unchecked (or failed)."""
        events = []
        outcomes = iter([{'id': 'job-002', 'status': 'failed', 'exitCode': 1, 'error': 'URLError: timed out'},
                         {'id': 'job-003', 'status': 'failed', 'exitCode': 1, 'error': 'URLError: timed out'},
                         {'id': 'job-004', 'status': 'bounded', 'exitCode': 0}])

        class Probe(SUP.Campaign):
            def __init__(self, a):
                self.a, self.dir, self.qa_proc = a, a.campaign, None
                self.state = {'jobs': [], 'qa': []}

            def save(self, **fields): self.state.update(fields)
            def log(self, message): pass
            def freeze_or_check(self, *_): pass
            def wait_for_writer(self): pass
            def backfill_lows(self): pass
            def check_stop_file(self): pass
            def campaign_bytes(self): return 0
            def start_qa(self, label): events.append(('qa-start', label))
            def finish_qa(self): events.append('qa-finish')

            def run_job(self, *args):
                events.append('fetch')
                try:
                    return next(outcomes)
                except StopIteration:
                    raise SystemExit('done') from None

        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(SUP, 'chunks_needed', return_value=[((1, 1), 1, 20)]), \
                mock.patch.object(SUP, 'plan_job', return_value=(20, 1)), \
                mock.patch.object(SUP.time, 'sleep'):
            plan = Path(tmp) / 'plan.json'
            plan.write_text('{"rows": [{"stage": "varied-regions", "group": "1.0,1.0|UTC", "tile": [1, 1]}]}')
            a = type('A', (), {'plan': plan, 'authority': plan, 'expect_plan_sha256': SUP.RUN.sha256_file(plan),
                               'stage': ['varied-regions'], 'campaign': Path(tmp), 'out': Path(tmp),
                               'campaign_max_bytes': 40_000_000_000, 'job_max_bytes': 10_000_000_000,
                               'min_free_gb': 40, 'between_jobs_s': 0})()
            with self.assertRaises(SystemExit):
                Probe(a).run()
        fetches = [i for i, e in enumerate(events) if e == 'fetch']
        self.assertEqual(events[fetches[0] + 1:fetches[1]], ['qa-finish', ('qa-start', 'job-002')])
        self.assertEqual(events[fetches[1] + 1:fetches[2]], ['qa-finish', ('qa-start', 'job-003')])

    def test_missing_lows_stop_before_any_fetch(self):
        events = []

        class Probe(SUP.Campaign):
            def __init__(self, a):
                self.a, self.dir, self.qa_proc = a, a.campaign, None
                self.state = {'jobs': [], 'qa': []}

            def save(self, **fields): self.state.update(fields)
            def log(self, message): pass
            def freeze_or_check(self, *_): pass
            def wait_for_writer(self): pass
            def backfill_lows(self): pass
            def check_stop_file(self): pass
            def start_qa(self, label): pass
            def finish_qa(self): pass
            def run_job(self, *args): events.append('fetch')

        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(SUP, 'chunks_needed', return_value=[((1, 1), 1, 20)]), \
                mock.patch.object(SUP, 'tiles_without_lows', return_value=['t001-001']):
            plan = Path(tmp) / 'plan.json'
            plan.write_text('{"rows": [{"stage": "varied-regions", "group": "1.0,1.0|UTC", "tile": [1, 1]}]}')
            a = type('A', (), {'plan': plan, 'authority': plan, 'expect_plan_sha256': SUP.RUN.sha256_file(plan),
                               'stage': ['varied-regions'], 'campaign': Path(tmp), 'out': Path(tmp)})()
            campaign = Probe(a)
            with self.assertRaises(SystemExit):
                campaign.run()
        self.assertEqual(events, [])
        self.assertEqual(campaign.state['stopReason'], 'low-coverage-absent')

    def test_refreeze_needs_a_stopped_boundary_and_keeps_the_old_freeze(self):
        with tempfile.TemporaryDirectory() as tmp:
            camp = Path(tmp)
            plan = camp / 'plan.json'
            plan.write_text('{}')
            old = {'planSha256': SUP.RUN.sha256_file(plan), 'authoritySha256': SUP.RUN.sha256_file(plan),
                   'code': {p: 'old' for p in SUP.FROZEN_CODE}, 'frozenUTC': 'x'}
            (camp / 'frozen.json').write_text(json.dumps(old))
            a = type('A', (), {'campaign': camp, 'plan': plan, 'authority': plan})()
            with self.assertRaisesRegex(SystemExit, 'STOP'):
                SUP.refreeze(a, 'lows')
            (camp / 'STOP').write_text('x')
            clean = mock.Mock(returncode=0, stdout='')
            with mock.patch.object(SUP.subprocess, 'run', side_effect=[mock.Mock(returncode=0, stdout=' M x'), clean]):
                with self.assertRaisesRegex(SystemExit, 'committed'):
                    SUP.refreeze(a, 'lows')
            with mock.patch.object(SUP.subprocess, 'run', side_effect=[clean, mock.Mock(returncode=0, stdout='abc1234\n')]), \
                    mock.patch('builtins.print'):
                SUP.refreeze(a, 'lows')
            archived = [p for p in camp.glob('frozen-*.json')]
            self.assertEqual(len(archived), 1)
            self.assertEqual(json.loads(archived[0].read_text()), old)
            new = json.loads((camp / 'frozen.json').read_text())
            self.assertEqual((new['commit'], new['reason'], new['previousFreezeSha256']),
                             ('abc1234', 'lows', SUP.RUN.sha256_file(archived[0])))
            self.assertEqual(new['code'], SUP.code_hashes())
            self.assertIn('re-freeze', (camp / 'supervisor.log').read_text())


class TestCoverageGate(unittest.TestCase):
    """Real tile + verifier output: a sealed tile counts only with passing high AND low verdicts."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from test_historical_lows import TestLows
        TestLows.setUpClass()
        cls.fixture = TestLows

    @classmethod
    def tearDownClass(cls):
        cls.fixture.tearDownClass()

    def test_gaps_name_every_missing_or_unverified_extremum(self):
        out = self.fixture.out
        rows = []
        for group in sorted(p.parent for p in (out / 'groups' / 'arco').glob('*/manifest.json')):
            rows += SUP.VERIFY.verify_tile_group_extrema(group, out / 'tiles' / 'arco' / 't001-002', 1)
        with tempfile.TemporaryDirectory() as tmp:
            both, highs = Path(tmp) / 'both.ndjson', Path(tmp) / 'highs.ndjson'
            both.write_text(''.join(json.dumps(r) + '\n' for r in rows))
            highs.write_text(''.join(json.dumps(r) + '\n' for r in rows if r.get('extremum', 'high') == 'high'))
            self.assertEqual(SUP.coverage_gaps(out, ['t001-002'], [str(both)]), [])
            self.assertEqual(len(SUP.coverage_gaps(out, ['t001-002'], [str(highs)])), 2)
            self.assertEqual(SUP.sealed_tiles(out), ['t001-002'])
            copy = Path(tmp) / 'out'
            shutil.copytree(out, copy)
            (copy / 'tiles' / 'arco' / 't001-002' / 'low-status.json').unlink()
            self.assertEqual(SUP.tiles_without_lows(copy), ['t001-002'])
            self.assertIn('t001-002: no low-status.json', SUP.coverage_gaps(copy, ['t001-002'], [str(both)]))

            class Probe(SUP.Campaign):
                def __init__(self, a):
                    self.a, self.dir = a, a.campaign
                    self.qa_proc = mock.Mock(wait=mock.Mock(return_value=0))
                    self.state = {'jobs': [], 'qa': [{'job': 'job-009', 'output': str(highs), 'status': 'running',
                                                      'sealedAtStart': ['t001-002']}]}

                def save(self, **fields): self.state.update(fields)
                def log(self, message): pass
                def account(self, label): self.state['accounted'] = label

            a = type('A', (), {'out': out, 'campaign': Path(tmp), 'verified': []})()
            probe = Probe(a)
            with self.assertRaises(SystemExit):
                probe.finish_qa()  # exit 0 from the verifier, but lows were never verified
            self.assertEqual((probe.state['stopReason'], probe.state['qa'][0]['status']), ('qa-coverage-gap', 'coverage-gap'))
            self.assertNotIn('accounted', probe.state)
            probe.qa_proc = mock.Mock(wait=mock.Mock(return_value=0))
            probe.state['qa'] = [{'job': 'job-010', 'output': str(both), 'status': 'running', 'sealedAtStart': ['t001-002']}]
            probe.finish_qa()
            self.assertEqual((probe.state['qa'][0]['status'], probe.state['qa'][0]['lowGroups'], probe.state['accounted']),
                             ('passed', 2, 'job-010'))

    def test_cli_refuses_caps_above_authorization_and_the_remaining_stage(self):
        for extra in (['--job-max-bytes', '10000000001'], ['--min-free-gb', '39'], ['--pause-seconds', '1'],
                      ['--stage', 'remaining']):
            # --out outside issue57-private: even a broken guard fails before any lock, folder or request.
            result = subprocess.run([sys.executable, str(SCRIPT), '--out', '/nonexistent-out', *extra], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, extra)
            self.assertTrue('10 GB' in result.stderr or 'storage/retention' in result.stderr, result.stderr)


if __name__ == '__main__':
    unittest.main()
