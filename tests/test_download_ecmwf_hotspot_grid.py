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

    def test_exact_cycle_boundary_uses_hourly_window_and_bracketing_steps(self):
        run = dt.datetime(2026, 9, 22, 0, tzinfo=dt.UTC)
        reference = dt.datetime(2026, 9, 22, 9, tzinfo=dt.UTC)
        start, end = MODULE.hourly_window(reference)
        self.assertEqual((start, end), (
            dt.datetime(2026, 9, 22, 10, tzinfo=dt.UTC),
            dt.datetime(2026, 9, 23, 9, tzinfo=dt.UTC),
        ))
        self.assertEqual(MODULE.covering_steps(run, start, end), [9, 12, 15, 18, 21, 24, 27, 30, 33])

    def test_between_boundaries_brackets_the_complete_next_24_hours(self):
        run = dt.datetime(2026, 9, 21, 12, tzinfo=dt.UTC)
        reference = dt.datetime(2026, 9, 22, 5, 30, tzinfo=dt.UTC)
        start, end = MODULE.hourly_window(reference)
        self.assertEqual((start, end), (
            dt.datetime(2026, 9, 22, 6, tzinfo=dt.UTC),
            dt.datetime(2026, 9, 23, 5, tzinfo=dt.UTC),
        ))
        self.assertEqual(MODULE.covering_steps(run, start, end), [18, 21, 24, 27, 30, 33, 36, 39, 42])

    def test_future_cycle_never_requests_negative_steps(self):
        run = dt.datetime(2026, 9, 22, 12, tzinfo=dt.UTC)
        reference = dt.datetime(2026, 9, 22, 10, tzinfo=dt.UTC)
        start, end = MODULE.hourly_window(reference)
        self.assertEqual(MODULE.covering_steps(run, start, end), [0, 3, 6, 9, 12, 15, 18, 21, 24])

    def test_exact_hour_also_starts_at_the_following_utc_hour(self):
        start, end = MODULE.hourly_window(dt.datetime(2026, 9, 22, 15, tzinfo=dt.UTC))
        self.assertEqual(start, dt.datetime(2026, 9, 22, 16, tzinfo=dt.UTC))
        self.assertEqual(end, dt.datetime(2026, 9, 23, 15, tzinfo=dt.UTC))

    def test_partial_hour_starts_at_next_complete_utc_hour(self):
        start, end = MODULE.hourly_window(dt.datetime(2026, 9, 22, 15, 15, 42, tzinfo=dt.UTC))
        self.assertEqual(start, dt.datetime(2026, 9, 22, 16, tzinfo=dt.UTC))
        self.assertEqual(end, dt.datetime(2026, 9, 23, 15, tzinfo=dt.UTC))
class ReadinessFileTests(unittest.TestCase):
    def _write(self, payload):
        import json
        import tempfile

        directory = tempfile.mkdtemp()
        path = Path(directory) / "readiness.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_ready_cycle_is_loaded(self):
        readiness = MODULE.load_readiness(self._write({
            "ready": True, "initialization": "2026-10-04T06:00:00Z", "date": "2026-10-04", "time": 6,
            "firstSeenReadyAt": "2026-10-04T13:20:00Z",
        }))
        self.assertEqual((readiness["date"], readiness["time"]), ("2026-10-04", 6))

    def test_not_ready_or_inconsistent_files_are_rejected(self):
        with self.assertRaises(ValueError):
            MODULE.load_readiness(self._write({"ready": False}))
        with self.assertRaises(ValueError):
            MODULE.load_readiness(self._write({
                "ready": True, "initialization": "2026-10-04T06:00:00Z", "date": "2026-10-04", "time": 6,
                "firstSeenReadyAt": "2026-10-04T05:00:00Z",
            }))


class BoundedRetryTests(unittest.TestCase):
    def _clock(self, start):
        state = {"now": start, "sleeps": []}

        def clock():
            return state["now"]

        def sleep(seconds):
            state["sleeps"].append(seconds)
            state["now"] += dt.timedelta(seconds=seconds)

        return state, clock, sleep

    def test_transient_failures_retry_within_the_window(self):
        import random

        start = dt.datetime(2026, 10, 4, 13, 20, tzinfo=dt.UTC)
        state, clock, sleep = self._clock(start)
        calls = {"count": 0}

        def attempt():
            calls["count"] += 1
            if calls["count"] < 3:
                raise RuntimeError("index row not yet retrievable")

        self.assertTrue(MODULE.retry_until(attempt, start + dt.timedelta(hours=1), clock=clock, sleep=sleep,
                                           rng=random.Random(1), log=lambda _message: None))
        self.assertEqual(calls["count"], 3)
        self.assertTrue(all(300 <= wait <= 360 for wait in state["sleeps"]))

    def test_persistent_failure_stops_inside_the_bounded_window(self):
        import random

        start = dt.datetime(2026, 10, 4, 13, 20, tzinfo=dt.UTC)
        deadline = start + dt.timedelta(minutes=20)
        state, clock, sleep = self._clock(start)
        logs = []

        def attempt():
            raise ConnectionError("mirror reset")

        self.assertFalse(MODULE.retry_until(attempt, deadline, clock=clock, sleep=sleep, rng=random.Random(1), log=logs.append))
        self.assertLessEqual(state["now"], deadline)
        self.assertIn("bounded window is spent", logs[-1])

    def test_cli_exits_with_warning_status_and_writes_no_metadata_when_retries_are_exhausted(self):
        import json
        import sys
        import tempfile

        class FailingClient:
            def __init__(self, **_kwargs):
                pass

            def retrieve(self, **_kwargs):
                raise RuntimeError("2d is not listed in the step index yet")

        directory = Path(tempfile.mkdtemp())
        readiness = directory / "readiness.json"
        readiness.write_text(json.dumps({
            "ready": True, "initialization": "2026-10-04T06:00:00Z", "date": "2026-10-04", "time": 6,
            "firstSeenReadyAt": "2026-10-04T13:20:00Z",
        }), encoding="utf-8")
        original_client, original_argv = MODULE.Client, sys.argv
        MODULE.Client = FailingClient
        sys.argv = ["download", "--readiness", str(readiness), "--retry-until", "2026-01-01T00:00:00Z",
                    "--forecast-output", str(directory / "f.grib2"), "--land-mask-output", str(directory / "m.grib2"),
                    "--metadata-output", str(directory / "download.json")]
        try:
            self.assertEqual(MODULE.main(), MODULE.RETRY_EXHAUSTED_EXIT)
        finally:
            MODULE.Client, sys.argv = original_client, original_argv
        self.assertFalse((directory / "download.json").exists())
        self.assertFalse((directory / "f.grib2").exists())


if __name__ == "__main__":
    unittest.main()
