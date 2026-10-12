import subprocess
import sys
import tempfile
import unittest
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

    def test_cli_refuses_caps_above_authorization_and_the_remaining_stage(self):
        for extra in (['--job-max-bytes', '10000000001'], ['--min-free-gb', '39'], ['--pause-seconds', '1'],
                      ['--stage', 'remaining']):
            # --out outside issue57-private: even a broken guard fails before any lock, folder or request.
            result = subprocess.run([sys.executable, str(SCRIPT), '--out', '/nonexistent-out', *extra], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, extra)
            self.assertTrue('10 GB' in result.stderr or 'storage/retention' in result.stderr, result.stderr)


if __name__ == '__main__':
    unittest.main()
