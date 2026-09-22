import datetime as dt
import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "download-ecmwf-hotspot-grid.py"
SPEC = importlib.util.spec_from_file_location("download_ecmwf_hotspot_grid", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CoveringStepsTests(unittest.TestCase):
    def test_candidate_runs_include_all_six_hour_cycles(self):
        class Client:
            @staticmethod
            def latest():
                return dt.datetime(2026, 9, 22, 12)

        runs = MODULE.candidate_runs(Client(), None, None)
        self.assertEqual([run.hour for run in runs[:5]], [12, 6, 0, 18, 12])
        self.assertTrue(all((runs[index] - runs[index + 1]) == dt.timedelta(hours=6) for index in range(len(runs) - 1)))

    def test_requested_six_hour_cycle_is_preserved(self):
        runs = MODULE.candidate_runs(object(), "2026-09-22", 6)
        self.assertEqual(runs, [dt.datetime(2026, 9, 22, 6, tzinfo=dt.UTC)])

    def test_exact_cycle_boundary_uses_nine_three_hourly_steps(self):
        run = dt.datetime(2026, 9, 22, 0, tzinfo=dt.UTC)
        reference = dt.datetime(2026, 9, 22, 9, tzinfo=dt.UTC)
        self.assertEqual(MODULE.covering_steps(run, reference), [9, 12, 15, 18, 21, 24, 27, 30, 33])

    def test_between_boundaries_brackets_the_complete_next_24_hours(self):
        run = dt.datetime(2026, 9, 21, 12, tzinfo=dt.UTC)
        reference = dt.datetime(2026, 9, 22, 5, 30, tzinfo=dt.UTC)
        self.assertEqual(MODULE.covering_steps(run, reference), [15, 18, 21, 24, 27, 30, 33, 36, 39, 42])

    def test_future_cycle_never_requests_negative_steps(self):
        run = dt.datetime(2026, 9, 22, 12, tzinfo=dt.UTC)
        reference = dt.datetime(2026, 9, 22, 10, tzinfo=dt.UTC)
        self.assertEqual(MODULE.covering_steps(run, reference), [0, 3, 6, 9, 12, 15, 18, 21, 24])
if __name__ == "__main__":
    unittest.main()
