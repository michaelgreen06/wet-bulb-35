import datetime as dt
import importlib.util
import json
import random
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "await-ifs-run-readiness.py"
SPEC = importlib.util.spec_from_file_location("await_ifs_run_readiness", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

UTC = dt.UTC


class Clock:
    def __init__(self, start: dt.datetime):
        self.now = start
        self.sleeps: list[float] = []

    def __call__(self) -> dt.datetime:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += dt.timedelta(seconds=seconds)


def metadata(initialization: dt.datetime, available: dt.datetime):
    return 200, {}, {
        "last_run_initialisation_time": int(initialization.timestamp()),
        "last_run_availability_time": int(available.timestamp()),
    }


def index_body(run: dt.datetime, step: int, params) -> str:
    """ECMWF index rows in the live JSON-lines format, including unrelated fields."""
    rows = [{"domain": "g", "date": f"{run:%Y%m%d}", "time": f"{run:%H}00", "expver": "0001", "class": "od", "type": "fc",
             "stream": "oper", "step": str(step), "levtype": "sfc", "param": param, "_offset": index * 1000, "_length": 900}
            for index, param in enumerate(["10u", *params, "tp"])]
    return "\n".join(json.dumps(row) for row in rows) + "\n"


class Mirror:
    """Fake ECMWF mirror serving index files for complete cycles, optionally from a given time."""

    def __init__(self, clock: Clock, ready_from: dict[dt.datetime, dt.datetime], missing_steps=(), absent_fields=None):
        self.clock = clock
        self.ready_from = ready_from
        self.missing_steps = set(missing_steps)
        # {(step): {params}} listed in an index that otherwise exists (HTTP 200).
        self.absent_fields = absent_fields or {}
        self.calls: list[str] = []
        self.status_override: tuple[int, dict[str, str]] | None = None

    def __call__(self, url: str):
        self.calls.append(url)
        if self.status_override:
            status, headers = self.status_override
            self.status_override = None
            return status, headers, ""
        stamp = url.rsplit("/", 1)[1]
        run = dt.datetime.strptime(stamp[:14], "%Y%m%d%H%M%S").replace(tzinfo=UTC)
        step = int(stamp.split("-")[1].rstrip("h"))
        ready_at = self.ready_from.get(run)
        if ready_at is None or self.clock.now < ready_at or step in self.missing_steps:
            return 404, {}, ""
        params = ["2t", "2d", "sp", *(["lsm"] if step == 0 else [])]
        params = [param for param in params if param not in self.absent_fields.get(step, set())]
        return 200, {}, index_body(run, step, params)


def run_poll(clock, mirror, read_metadata, deadline_hours=4, published=None, logs=None):
    return MODULE.poll(
        fetch_index=mirror,
        read_metadata=read_metadata,
        base_url="https://mirror.test/ecmwf",
        deadline=clock.now + dt.timedelta(hours=deadline_hours),
        published_initialization=published,
        clock=clock,
        sleep=clock.sleep,
        rng=random.Random(7),
        log=(logs.append if logs is not None else lambda _message: None),
    )


class ReadinessTests(unittest.TestCase):
    def test_cycles_are_newest_first_and_skip_published_or_older_runs(self):
        now = dt.datetime(2026, 10, 4, 13, 10, tzinfo=UTC)
        cycles = MODULE.candidate_cycles(now, None)
        self.assertEqual(cycles[0], dt.datetime(2026, 10, 4, 6, tzinfo=UTC))
        self.assertTrue(all(left - right == dt.timedelta(hours=6) for left, right in zip(cycles, cycles[1:])))
        self.assertEqual(MODULE.candidate_cycles(now, dt.datetime(2026, 10, 4, 6, tzinfo=UTC)), [])

    def test_index_urls_use_the_oper_stream_for_off_cycles_and_check_the_last_step_first(self):
        run = dt.datetime(2026, 10, 4, 6, tzinfo=UTC)
        urls = MODULE.index_urls("https://mirror.test/ecmwf/", run, [9, 12, 15])
        self.assertEqual(urls[0], "https://mirror.test/ecmwf/20261004/06z/ifs/0p25/oper/20261004060000-15h-oper-fc.index")
        self.assertEqual(urls[-1], "https://mirror.test/ecmwf/20261004/06z/ifs/0p25/oper/20261004060000-0h-oper-fc.index")

    def test_early_arrival_is_recorded_from_the_first_ready_poll_not_the_schedule(self):
        run = dt.datetime(2026, 10, 4, 6, tzinfo=UTC)
        clock = Clock(dt.datetime(2026, 10, 4, 12, 30, tzinfo=UTC))
        mirror = Mirror(clock, {run: dt.datetime(2026, 10, 4, 12, 40, tzinfo=UTC)})
        result = run_poll(clock, mirror, lambda: metadata(run, dt.datetime(2026, 10, 4, 12, 20, tzinfo=UTC)))
        self.assertTrue(result["ready"])
        self.assertEqual(result["initialization"], "2026-10-04T06:00:00Z")
        self.assertGreaterEqual(MODULE.parse_iso(result["firstSeenReadyAt"]), dt.datetime(2026, 10, 4, 12, 40, tzinfo=UTC))
        self.assertLess(MODULE.parse_iso(result["firstSeenReadyAt"]), dt.datetime(2026, 10, 4, 12, 48, tzinfo=UTC))
        self.assertEqual((result["date"], result["time"]), ("2026-10-04", 6))
        self.assertTrue(all(300 <= wait <= 360 for wait in clock.sleeps))

    def test_open_meteo_lag_keeps_polling_until_the_same_run_has_settled(self):
        run = dt.datetime(2026, 10, 4, 6, tzinfo=UTC)
        clock = Clock(dt.datetime(2026, 10, 4, 13, 0, tzinfo=UTC))
        mirror = Mirror(clock, {run: clock.now})
        open_meteo_at = dt.datetime(2026, 10, 4, 13, 20, tzinfo=UTC)

        def read():
            if clock.now < open_meteo_at:
                return metadata(run - dt.timedelta(hours=6), run)
            return metadata(run, open_meteo_at)

        result = run_poll(clock, mirror, read)
        self.assertTrue(result["ready"])
        self.assertEqual(result["ecmwfFirstSeenAt"], "2026-10-04T13:00:00Z")
        # Ten-minute settling margin after Open-Meteo availability.
        self.assertGreaterEqual(MODULE.parse_iso(result["firstSeenReadyAt"]), open_meteo_at + dt.timedelta(minutes=10))
        self.assertEqual(result["openMeteoAvailableAt"], "2026-10-04T13:20:00Z")

    def test_a_newer_open_meteo_run_still_provides_the_pinned_older_run(self):
        run = dt.datetime(2026, 10, 4, 0, tzinfo=UTC)
        ready, _ = MODULE.open_meteo_ready(metadata(run + dt.timedelta(hours=6), dt.datetime(2026, 10, 4, 13, 0, tzinfo=UTC))[2], run, dt.datetime(2026, 10, 4, 14, 0, tzinfo=UTC))
        self.assertTrue(ready)

    def test_missing_late_steps_never_become_ready_and_stop_at_the_bounded_deadline(self):
        run = dt.datetime(2026, 10, 4, 6, tzinfo=UTC)
        clock = Clock(dt.datetime(2026, 10, 4, 13, 0, tzinfo=UTC))
        steps = MODULE.required_steps(run, clock.now)
        mirror = Mirror(clock, {run: clock.now}, missing_steps={steps[-1]})
        result = run_poll(clock, mirror, lambda: metadata(run, run), deadline_hours=1)
        self.assertFalse(result["ready"])
        self.assertLessEqual(clock.now, dt.datetime(2026, 10, 4, 14, 0, tzinfo=UTC))
        self.assertGreaterEqual(result["checks"], 2)

    def test_existing_indexes_missing_a_required_field_are_not_ready(self):
        """Regression: every index returns 200, but one required row is not yet listed."""
        run = dt.datetime(2026, 10, 4, 6, tzinfo=UTC)
        clock = Clock(dt.datetime(2026, 10, 4, 13, 0, tzinfo=UTC))
        steps = MODULE.required_steps(run, clock.now)
        logs: list[str] = []
        mirror = Mirror(clock, {run: clock.now}, absent_fields={steps[3]: {"2d"}})
        result = run_poll(clock, mirror, lambda: metadata(run, run), deadline_hours=0.5, logs=logs)
        self.assertFalse(result["ready"])
        self.assertTrue(all(url.endswith(".index") for url in mirror.calls))
        self.assertTrue(any(f"step {steps[3]}: index lacks 2d" in line for line in logs))

        # The step-0 land-sea mask is required even when step 0 is not a forecast step.
        clock = Clock(dt.datetime(2026, 10, 4, 13, 0, tzinfo=UTC))
        mirror = Mirror(clock, {run: clock.now}, absent_fields={0: {"lsm"}})
        self.assertNotIn(0, steps)
        self.assertFalse(run_poll(clock, mirror, lambda: metadata(run, run), deadline_hours=0.5)["ready"])

    def test_fields_become_ready_once_the_index_lists_every_row(self):
        run = dt.datetime(2026, 10, 4, 6, tzinfo=UTC)
        clock = Clock(dt.datetime(2026, 10, 4, 13, 0, tzinfo=UTC))
        steps = MODULE.required_steps(run, clock.now)
        mirror = Mirror(clock, {run: clock.now}, absent_fields={steps[-1]: {"sp"}})
        original = mirror.__call__

        def fill_later(url):
            if clock.now >= dt.datetime(2026, 10, 4, 13, 20, tzinfo=UTC):
                mirror.absent_fields = {}
            return original(url)

        result = run_poll(clock, fill_later, lambda: metadata(run, run))
        self.assertTrue(result["ready"])
        self.assertGreaterEqual(MODULE.parse_iso(result["firstSeenReadyAt"]), dt.datetime(2026, 10, 4, 13, 20, tzinfo=UTC))

    def test_index_rows_must_match_the_run_step_and_have_bytes(self):
        run = dt.datetime(2026, 10, 4, 6, tzinfo=UTC)
        other_run = index_body(run - dt.timedelta(hours=6), 12, ["2t", "2d", "sp"])
        other_step = index_body(run, 15, ["2t", "2d", "sp"])
        empty = index_body(run, 12, ["2t"]).replace('"_length": 900', '"_length": 0')
        self.assertEqual(MODULE.listed_params(other_run, run, 12), set())
        self.assertEqual(MODULE.listed_params(other_step, run, 12), set())
        self.assertEqual(MODULE.listed_params(empty + "not json\n", run, 12), set())
        self.assertEqual(MODULE.listed_params(index_body(run, 12, ["2t", "2d", "sp"]), run, 12), {"10u", "2t", "2d", "sp", "tp"})

    def test_superseded_runs_prefer_the_newest_complete_cycle(self):
        older = dt.datetime(2026, 10, 4, 0, tzinfo=UTC)
        newer = dt.datetime(2026, 10, 4, 6, tzinfo=UTC)
        clock = Clock(dt.datetime(2026, 10, 4, 14, 0, tzinfo=UTC))
        mirror = Mirror(clock, {older: older, newer: newer})
        result = run_poll(clock, mirror, lambda: metadata(newer, dt.datetime(2026, 10, 4, 13, 0, tzinfo=UTC)))
        self.assertEqual(result["initialization"], "2026-10-04T06:00:00Z")

        # With 06Z already published, the older 00Z cycle is never selected again.
        clock = Clock(dt.datetime(2026, 10, 4, 14, 0, tzinfo=UTC))
        mirror = Mirror(clock, {older: older, newer: newer})
        result = run_poll(clock, mirror, lambda: metadata(newer, newer), deadline_hours=0.2, published=newer)
        self.assertFalse(result["ready"])
        self.assertEqual(mirror.calls, [])

    def test_nine_hour_late_run_is_used_with_a_window_from_actual_retrieval_time(self):
        run = dt.datetime(2026, 10, 4, 6, tzinfo=UTC)
        # 18Z is not yet disseminated; we first look nine hours after 06Z became available.
        clock = Clock(dt.datetime(2026, 10, 4, 22, 15, tzinfo=UTC))
        mirror = Mirror(clock, {run: dt.datetime(2026, 10, 4, 13, 15, tzinfo=UTC)})
        result = run_poll(clock, mirror, lambda: metadata(run, dt.datetime(2026, 10, 4, 13, 16, tzinfo=UTC)), published=run - dt.timedelta(hours=6))
        self.assertTrue(result["ready"])
        self.assertEqual(result["firstSeenReadyAt"], "2026-10-04T22:15:00Z")
        # Window starts 23Z: source steps bracket hours 17..40 from initialization, never the elapsed hours.
        self.assertEqual(result["steps"][0], 15)
        self.assertEqual(result["steps"][-1], 42)

    def test_retry_after_and_exponential_backoff_are_respected(self):
        run = dt.datetime(2026, 10, 4, 6, tzinfo=UTC)
        clock = Clock(dt.datetime(2026, 10, 4, 13, 0, tzinfo=UTC))
        mirror = Mirror(clock, {run: clock.now})
        mirror.status_override = (429, {"Retry-After": "1200"})
        logs: list[str] = []
        result = run_poll(clock, mirror, lambda: metadata(run, run), logs=logs)
        self.assertTrue(result["ready"])
        self.assertGreaterEqual(clock.sleeps[0], 1200)
        self.assertTrue(any("deferred" in line for line in logs))

        attempts = {"count": 0}

        def flaky():
            attempts["count"] += 1
            if attempts["count"] <= 2:
                return 503, {}, None
            return metadata(run, run)

        clock = Clock(dt.datetime(2026, 10, 4, 13, 0, tzinfo=UTC))
        result = run_poll(clock, Mirror(clock, {run: clock.now}), flaky)
        self.assertTrue(result["ready"])
        self.assertGreaterEqual(clock.sleeps[1], 600)

    def test_retry_after_http_date_is_parsed(self):
        now = dt.datetime(2026, 10, 4, 13, 0, tzinfo=UTC)
        self.assertEqual(MODULE.retry_after_seconds({"retry-after": "Sun, 04 Oct 2026 13:05:00 GMT"}, now), 300)
        self.assertIsNone(MODULE.retry_after_seconds({}, now))


if __name__ == "__main__":
    unittest.main()
