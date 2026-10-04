import email.message
import hashlib
import importlib.util
import json
import tempfile
import unittest
import urllib.error
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GENERATOR = load("climate_generator_test", "generate-climate-context.py")
FETCHER = load("climate_fetcher_test", "fetch-nasa-power-cells.py")
D = Decimal


class Band:
    """Minimal 2D raster stand-in supporting the slicing the generator uses."""

    def __init__(self, rows):
        self.rows = rows

    def __getitem__(self, key):
        rows, cols = key
        if isinstance(rows, int):
            return self.rows[rows][cols]
        return Band([row[cols] for row in self.rows[rows]])

    def ravel(self):
        return [value for row in self.rows for value in row]


def response(monthly, version="v2.10.0", **header):
    values = dict(zip(GENERATOR.MONTHS, monthly))
    head = {"api": {"version": version}, "sources": ["MERRA2", "POWER"], "fill_value": -999.0,
            "time_standard": "LST", "range": GENERATOR.POWER_RANGE, **header}
    return json.dumps({"properties": {"parameter": {"T2MWET": values}}, "header": head,
                       "parameters": {"T2MWET": {"units": "C"}}}).encode()


class Clock:
    def __init__(self):
        self.now, self.sleeps = 0.0, []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def http_error(code, retry_after=None):
    headers = email.message.Message()
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return urllib.error.HTTPError("https://power.larc.nasa.gov/x", code, "error", headers, None)


class GridTests(unittest.TestCase):
    def test_nearest_cell_matches_probed_power_behaviour(self):
        # Probed 2026-10-03: 22.749 -> 22.5 row, 22.751 -> 23.0 row, 88.437 -> 88.125, 88.438 -> 88.75.
        self.assertEqual(GENERATOR.merra2_cell(D("22.74900"), D("88.12500")), (225, 429))
        self.assertEqual(GENERATOR.merra2_cell(D("22.75100"), D("88.12500")), (226, 429))
        self.assertEqual(GENERATOR.merra2_cell(D("22.50000"), D("88.43700")), (225, 429))
        self.assertEqual(GENERATOR.merra2_cell(D("22.50000"), D("88.43800")), (225, 430))
        self.assertEqual(GENERATOR.cell_center((225, 429)), (D("22.5"), D("88.125")))

    def test_exact_edges_are_excluded_and_longitude_wraps(self):
        self.assertIsNone(GENERATOR.merra2_cell(D("22.75000"), D("10.00000")))
        self.assertIsNone(GENERATOR.merra2_cell(D("10.00000"), D("88.43750")))
        self.assertEqual(GENERATOR.merra2_cell(D("0.00000"), D("180.00000")), (180, 0))
        self.assertEqual(GENERATOR.merra2_cell(D("-33.80000"), D("-70.70000"))[1], round((D("-70.7") + 180) / D("0.625")))

    def test_power_url_matches_pilot_request_contract(self):
        url = GENERATOR.power_url(D("22.5"), D("88.125"))
        self.assertEqual(url, "https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=T2MWET&community=RE&longitude=88.12500&latitude=22.50000&format=JSON&start=1991&end=2020")
        GENERATOR.check_locked_url(url, D("22.5"), D("88.125"))
        with self.assertRaises(ValueError):
            GENERATOR.check_locked_url(url.replace("1991", "2001"), D("22.5"), D("88.125"))


class KoppenTests(unittest.TestCase):
    def test_pilot_rule(self):
        self.assertEqual(GENERATOR.classify_koppen([14] * 9, 14), (14, None))
        self.assertEqual(GENERATOR.classify_koppen([14] * 7 + [15] * 2, 14), (14, None))
        # 6/9 = 0.667 is below the pilot's 0.67 threshold.
        self.assertEqual(GENERATOR.classify_koppen([14] * 6 + [15] * 3, 14), (None, "lowModalShare"))
        self.assertEqual(GENERATOR.classify_koppen([14] * 5 + [15] * 4, 14), (None, "lowModalShare"))
        self.assertEqual(GENERATOR.classify_koppen([15] * 5 + [14] * 4, 14), (None, "centerNotModal"))
        self.assertEqual(GENERATOR.classify_koppen([0] * 8 + [14], 0), (None, "centerNoData"))
        # NoData (ocean) neighbours are ignored, matching the pilot.
        self.assertEqual(GENERATOR.classify_koppen([0] * 6 + [14] * 3, 14), (14, None))


class GenerateTests(unittest.TestCase):
    def setUp(self):
        self.band = Band([[14, 14, 14, 0], [14, 14, 14, 0], [14, 14, 15, 0], [15, 15, 15, 0]])
        self.index = lambda lon, lat: (int(lat), int(lon))
        self.routes = {"/wetbulb-temperature/a/b/one/": (D("1.00000"), D("1.00000")),
                       "/wetbulb-temperature/a/b/two/": (D("2.00000"), D("1.00000")),
                       "/wetbulb-temperature/a/b/edge/": (D("0.25000"), D("3.00000"))}

    def test_compact_cell_rounds_half_up_and_keeps_tied_peaks_from_unrounded_values(self):
        cell = GENERATOR.compact_cell([20.05, 27.04, 27.04, -0.05, 1, 2, 3, 4, 5, 6, 7, 26.96])
        self.assertEqual(cell[:4], [201, 270, 270, -1])
        self.assertEqual(cell[12], 0b110)

    def test_generates_counts_exclusions_and_cell_dedup(self):
        nasa = ({GENERATOR.merra2_cell(D("1.00000"), D("1.00000")): [20.0] * 11 + [25.0],
                 GENERATOR.merra2_cell(D("2.00000"), D("1.00000")): None}, {"accessedDate": "2026-10-03"})
        artifact = GENERATOR.generate(self.routes, self.band, self.index, 4, 4, {"beck": True}, nasa)
        self.assertEqual(artifact["byPath"]["/wetbulb-temperature/a/b/one/"], [14, 0])
        self.assertEqual(artifact["byPath"]["/wetbulb-temperature/a/b/two/"], [None, None])
        self.assertEqual(artifact["byPath"]["/wetbulb-temperature/a/b/edge/"], [None, None])
        self.assertEqual(artifact["exclusions"]["koppen"], {"centerNoData": ["/wetbulb-temperature/a/b/edge/"], "lowModalShare": ["/wetbulb-temperature/a/b/two/"]})
        self.assertEqual(artifact["exclusions"]["nasaPower"], {"cellEdgeTie": ["/wetbulb-temperature/a/b/edge/"], "fillOrInvalidValue": ["/wetbulb-temperature/a/b/two/"]})
        self.assertEqual(artifact["cells"], [[200] * 11 + [250, 2048]])
        self.assertEqual(artifact["counts"]["koppen"], 1)
        self.assertEqual(artifact["inventory"]["routes"], 3)

    def test_missing_locked_cell_fails_closed(self):
        with self.assertRaises(ValueError):
            GENERATOR.generate(self.routes, self.band, self.index, 4, 4, {}, ({}, {"accessedDate": "x"}))

    def test_without_nasa_marks_pending(self):
        artifact = GENERATOR.generate(self.routes, self.band, self.index, 4, 4, {})
        self.assertIsNone(artifact["sources"]["nasaPower"])
        self.assertEqual(artifact["counts"]["nasaPowerPending"], 2)
        self.assertEqual(artifact["cells"], [])

    def test_inventory_rejects_more_than_five_decimals(self):
        with self.assertRaises(ValueError):
            GENERATOR.coordinate(1.123456)


class FetcherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / "nasa"
        self.clock = Clock()
        self.jobs = [("cells", "225_429", (D("22.5"), D("88.125"))), ("cells", "226_429", (D("23.0"), D("88.125"))),
                     ("validation", "/wetbulb-temperature/india/west-bengal/kolkata/", (D("22.56300"), D("88.36300")))]

    def fetcher(self, get, **kwargs):
        return FETCHER.Fetcher(self.out, 2.0, 10, get=get, sleep=self.clock.sleep, clock=self.clock, log=lambda *a, **k: None,
                               wall=lambda: 1_790_000_000 + self.clock(), **kwargs)

    def test_retry_after_accepts_seconds_and_http_dates(self):
        self.assertEqual(FETCHER.retry_after_seconds("120", 0), 120.0)
        self.assertEqual(FETCHER.retry_after_seconds("Wed, 21 Oct 2015 07:28:00 GMT", 1445412480 - 600), 600.0)
        self.assertEqual(FETCHER.retry_after_seconds("Wed, 21 Oct 2015 07:28:00 GMT", 1445412480 + 60), 0.0)
        self.assertIsNone(FETCHER.retry_after_seconds("soon", 0))
        self.assertIsNone(FETCHER.retry_after_seconds(None, 0))

    def test_http_date_retry_after_wins_when_later_than_backoff(self):
        calls = []
        later = email.utils.format_datetime(__import__("datetime").datetime.fromtimestamp(1_790_000_000 + 7200, __import__("datetime").timezone.utc), usegmt=True)

        def get(url, timeout):
            calls.append(self.clock())
            if len(calls) == 1:
                raise http_error(429, retry_after=later)
            return 200, response([20.0] * 12)

        FETCHER.run(self.jobs[:1], self.out, self.fetcher(get), "Michael", log=lambda *a, **k: None)
        self.assertGreaterEqual(calls[1] - calls[0], 7200 - 1)

    def test_backoff_wins_when_retry_after_is_shorter(self):
        calls = []

        def get(url, timeout):
            calls.append(self.clock())
            if len(calls) == 1:
                raise http_error(429, retry_after=5)
            return 200, response([20.0] * 12)

        FETCHER.run(self.jobs[:1], self.out, self.fetcher(get), "Michael", log=lambda *a, **k: None)
        self.assertGreaterEqual(calls[1] - calls[0], 120)

    def test_single_flight_spacing_never_exceeds_one_start_per_two_seconds(self):
        starts = []

        def get(url, timeout):
            starts.append(self.clock())
            self.clock.now += 0.3
            return 200, response([20.0] * 12)

        self.last_fetcher = self.fetcher(get)
        FETCHER.run(self.jobs, self.out, self.last_fetcher, "Michael", log=lambda *a, **k: None)
        self.assertEqual(len(starts), 3)
        self.assertTrue(all(b - a >= 2.0 for a, b in zip(starts, starts[1:])))
        self.assertLessEqual(FETCHER.Fetcher.stats(self.last_fetcher, 0)["effectivePerSecond"], 0.5)

    def test_429_honours_retry_after_and_sustained_throttling_stops(self):
        calls = []

        def get(url, timeout):
            calls.append(self.clock())
            if len(calls) == 1:
                raise http_error(429, retry_after=900)
            return 200, response([20.0] * 12)

        FETCHER.run(self.jobs[:1], self.out, self.fetcher(get), "Michael", log=lambda *a, **k: None)
        self.assertGreaterEqual(calls[1] - calls[0], 900)

        def always_429(url, timeout):
            raise http_error(429)

        with self.assertRaises(FETCHER.Stop) as stopped:
            FETCHER.run(self.jobs[1:], self.out, self.fetcher(always_429, max_throttles_per_hour=3), "Michael", log=lambda *a, **k: None)
        self.assertEqual(stopped.exception.code, FETCHER.EXIT_THROTTLED)

    def test_5xx_backs_off_then_unexpected_4xx_and_contract_changes_stop(self):
        attempts = []

        def flaky(url, timeout):
            attempts.append(self.clock())
            if len(attempts) < 3:
                raise http_error(503)
            return 200, response([20.0] * 12)

        FETCHER.run(self.jobs[:1], self.out, self.fetcher(flaky), "Michael", log=lambda *a, **k: None)
        self.assertGreaterEqual(attempts[1] - attempts[0], 30)
        self.assertGreaterEqual(attempts[2] - attempts[1], 60)
        with self.assertRaises(FETCHER.Stop) as bad_request:
            FETCHER.run(self.jobs[1:2], self.out, self.fetcher(lambda u, t: (_ for _ in ()).throw(http_error(422))), "Michael", log=lambda *a, **k: None)
        self.assertEqual(bad_request.exception.code, FETCHER.EXIT_CONTRACT)
        with self.assertRaises(FETCHER.Stop) as changed:
            FETCHER.run(self.jobs[1:2], self.out, self.fetcher(lambda u, t: (200, response([20.0] * 12, time_standard="UTC"))), "Michael", log=lambda *a, **k: None)
        self.assertEqual(changed.exception.code, FETCHER.EXIT_CONTRACT)
        self.assertFalse((self.out / "cells" / "226_429.json").exists())

    def test_restart_resumes_verifies_hashes_and_tolerates_torn_last_line(self):
        calls = []

        def get(url, timeout):
            calls.append(url)
            if len(calls) == 2:
                raise KeyboardInterrupt  # simulated crash mid-run
            return 200, response([20.0] * 12)

        with self.assertRaises(KeyboardInterrupt):
            FETCHER.run(self.jobs, self.out, self.fetcher(get), "Michael", log=lambda *a, **k: None)
        with open(self.out / "journal.jsonl", "ab") as journal:
            journal.write(b'{"kind": "cells", "key": "226_4')
        with self.assertRaises(FETCHER.Stop):
            FETCHER.read_journal(self.out)  # read-only callers refuse a torn journal
        calls.clear()
        done = FETCHER.run(self.jobs, self.out, self.fetcher(lambda u, t: (calls.append(u), (200, response([20.0] * 12)))[1]), "Michael", log=lambda *a, **k: None)
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(done), 3)
        lines = (self.out / "journal.jsonl").read_bytes().split(b"\n")
        self.assertEqual(lines[-1], b"")
        self.assertEqual([json.loads(line)["key"] for line in lines[:-1]], ["225_429", "226_429", "/wetbulb-temperature/india/west-bengal/kolkata/"])
        self.assertEqual(FETCHER.read_journal(self.out).keys(), done.keys())
        (self.out / "cells" / "225_429.json").write_bytes(b"tampered")
        with self.assertRaises(FETCHER.Stop) as tampered:
            FETCHER.read_journal(self.out)
        self.assertEqual(tampered.exception.code, FETCHER.EXIT_INTEGRITY)

    def test_finalized_lock_is_accepted_by_generator(self):
        FETCHER.run(self.jobs, self.out, self.fetcher(lambda u, t: (200, response([20.0] * 11 + [25.0]))), "Michael", log=lambda *a, **k: None)
        FETCHER.finalize(self.out, self.jobs, "2026-10-03")
        routes = {"/wetbulb-temperature/india/west-bengal/kolkata/": (D("22.56300"), D("88.36300"))}
        original = GENERATOR.MIN_VALIDATION_SAMPLES
        GENERATOR.MIN_VALIDATION_SAMPLES = 1
        try:
            cells, provenance = GENERATOR.load_nasa(self.out, routes)
        finally:
            GENERATOR.MIN_VALIDATION_SAMPLES = original
        self.assertEqual(cells[(225, 429)][11], 25.0)
        self.assertEqual(provenance["validationSamples"], 1)
        self.assertEqual(provenance["apiVersion"], "v2.10.0")

    def test_validation_response_must_equal_its_cell(self):
        responses = iter([response([20.0] * 12), response([20.0] * 12), response([21.0] * 12)])
        FETCHER.run(self.jobs, self.out, self.fetcher(lambda u, t: (200, next(responses))), "Michael", log=lambda *a, **k: None)
        FETCHER.finalize(self.out, self.jobs, "2026-10-03")
        routes = {"/wetbulb-temperature/india/west-bengal/kolkata/": (D("22.56300"), D("88.36300"))}
        with self.assertRaisesRegex(ValueError, "differs from its MERRA-2 cell"):
            GENERATOR.load_nasa(self.out, routes)

    def test_plan_dedupes_cells_and_includes_popular_validation(self):
        routes = {f"/wetbulb-temperature/a/b/{n}/": (D("22.5") + D(n) / 1000, D("88.125")) for n in range(10)}
        cells, validation = FETCHER.plan(routes, {"/wetbulb-temperature/a/b/3/"}, 4, 1)
        self.assertEqual(cells, [(225, 429)])
        self.assertEqual(len(validation), 4)
        self.assertIn("/wetbulb-temperature/a/b/3/", validation)

    def test_max_requests_bounds_a_probe(self):
        calls = []
        FETCHER.run(self.jobs, self.out, self.fetcher(lambda u, t: (calls.append(u), (200, response([20.0] * 12)))[1]), "Michael", log=lambda *a, **k: None, max_requests=2)
        self.assertEqual(len(calls), 2)

    def test_finalize_requires_every_job(self):
        with self.assertRaises(FETCHER.Stop):
            FETCHER.finalize(self.out, self.jobs, "2026-10-03")


if __name__ == "__main__":
    unittest.main()
