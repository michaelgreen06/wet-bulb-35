import importlib.util
import io
import json
from email.message import Message
import pathlib
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, datetime, timezone
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


status = load("admin_status", "admin_status.py")
cli = load("collect_admin_status", "collect-admin-status.py")

NOW = datetime(2026, 10, 4, 12, 0, tzinfo=timezone.utc)
ORIGIN = "https://www.wetbulb35.com"
CITY = "/wetbulb-temperature/india/tamil-nadu/chennai/"
SECRET = "SECRET-provider-body-or-key"


def html(path):
    return f'<html><head><link rel="canonical" href="{ORIGIN}{path}"></head></html>'.encode()


def snapshot(**overrides):
    payload = {
        "schemaVersion": 1, "generatedAt": "2026-10-04T10:20:00Z", "validFrom": "2026-10-04T11:00:00Z",
        "validTo": "2026-10-05T11:00:00Z", "discovery": {"initialization": "2026-10-04T06:00:00Z", "source": SECRET},
        "counts": {"published": 2, "refined": 345},
        "hotspots": [{"name": "Somewhere", "latitude": 1.2345, "maximumWetBulbC": 33.3}],
    }
    payload.update(overrides)
    return json.dumps(payload).encode()


class FakeFetch:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, url, headers=None):
        self.calls.append(url)
        for prefix, result in self.routes.items():
            if url.startswith(prefix):
                if isinstance(result, BaseException):
                    raise result
                return result
        raise AssertionError(f"unexpected fetch {url}")


def runs(*items):
    return 200, "application/json", json.dumps({"workflow_runs": list(items)}).encode(), 5


class SiteHealthTests(unittest.TestCase):
    def test_provider_free_checks_and_states(self):
        fetch = FakeFetch({
            f"{ORIGIN}/api/": (404, "", b"", 3),
            f"{ORIGIN}{CITY}": (200, "text/html; charset=UTF-8", html(CITY), 20),
            f"{ORIGIN}/": (200, "text/html", html("/"), 10),
        })
        state, data = status.collect_site(ORIGIN, fetch=fetch, now=NOW, city_path=CITY)
        self.assertEqual(state, "ok")
        self.assertEqual([check["outcome"] for check in data["checks"]], ["ok", "ok", "not_published"])
        self.assertTrue(all("/api/weather" not in url and "/api/forecast" not in url for url in fetch.calls))

        fetch.routes[f"{ORIGIN}{CITY}"] = (200, "text/html", b"<html>no canonical</html>", 20)
        self.assertEqual(status.collect_site(ORIGIN, fetch=fetch, now=NOW, city_path=CITY)[0], "degraded")
        fetch.routes[f"{ORIGIN}/"] = TimeoutError(SECRET)
        state, data = status.collect_site(ORIGIN, fetch=fetch, now=NOW, city_path=CITY)
        self.assertEqual(state, "down")
        self.assertEqual(data["checks"][0]["outcome"], "timeout")
        self.assertNotIn(SECRET, json.dumps(data))

    def test_representative_city_comes_from_tier1_rank_one(self):
        self.assertEqual(status.representative_city_path(), CITY)


class Top50Tests(unittest.TestCase):
    def fetch(self, inhabited, unfiltered, workflow):
        return FakeFetch({
            f"{ORIGIN}/api/inhabited-hotspots": inhabited,
            f"{ORIGIN}/api/global-grid-hotspots": unfiltered,
            "https://api.github.com/": workflow,
        })

    def test_extracts_only_run_and_validity_metadata(self):
        fetch = self.fetch((200, "application/json", snapshot(), 5), (404, "", b"", 5), runs(
            {"created_at": "2026-10-04T10:00:00Z", "status": "completed", "conclusion": "success"},
            {"created_at": "2026-10-03T15:15:00Z", "status": "completed", "conclusion": "failure"}))
        state, data = status.collect_top50(ORIGIN, fetch=fetch, now=NOW, environ={"HOTSPOT_DAILY_LOCATION_LIMIT": "5000"})
        self.assertEqual(state, "ok")
        inhabited = data["products"]["inhabited"]
        self.assertEqual(inhabited["initialization"], "2026-10-04T06:00:00Z")
        self.assertIsNone(inhabited["retrievedAt"])
        self.assertEqual(data["products"]["unfiltered"], {"availability": "not_published"})
        self.assertEqual(data["scheduledBudget"], {"used": 345, "limit": 5000})
        self.assertEqual(data["lastCycle"]["outcome"], "success")
        self.assertEqual(data["latestFailure"], {"at": "2026-10-03T15:15:00Z", "outcome": "failure"})
        encoded = json.dumps(data)
        for leaked in (SECRET, "Somewhere", "1.2345", "33.3"):
            self.assertNotIn(leaked, encoded)

    def test_adaptable_fields_for_issue_50_and_expiry(self):
        payload = json.loads(snapshot(run={"initialization": "2026-10-04T00:00:00Z", "retrievedAt": "2026-10-04T07:00:00+00:00"}))
        del payload["discovery"]  # Legacy fallback when #50's discovery field is absent.
        meta, _ = status.extract_snapshot_meta(payload)
        self.assertEqual(meta["initialization"], "2026-10-04T00:00:00Z")
        self.assertEqual(meta["retrievedAt"], "2026-10-04T07:00:00Z")
        self.assertEqual(status.classify_snapshot(meta, datetime(2026, 10, 5, 11, tzinfo=timezone.utc), 36), "expired")
        self.assertEqual(status.classify_snapshot(meta, datetime(2026, 10, 4, 16, tzinfo=timezone.utc), 15), "behind")
        bad, _ = status.extract_snapshot_meta({"validFrom": "2026-10-05T00:00:00Z", "validTo": "2026-10-04T00:00:00Z"})
        self.assertEqual(bad["availability"], "invalid")
        self.assertEqual(status.extract_snapshot_meta([])[0]["availability"], "invalid")

        expired = self.fetch((200, "application/json", snapshot(validTo="2026-10-04T11:30:00Z"), 5), (404, "", b"", 5), (404, "", b"", 5))
        self.assertEqual(status.collect_top50(ORIGIN, fetch=expired, now=NOW, environ={})[0], "down")
        unpublished = self.fetch((404, "", b"", 5), (404, "", b"", 5), (404, "", b"", 5))
        state, data = status.collect_top50(ORIGIN, fetch=unpublished, now=NOW, environ={})
        self.assertEqual(state, "unknown")
        self.assertEqual(data["scheduledBudget"], {"used": None, "limit": None})

    def test_missing_run_metadata_is_not_current_and_matches_worker(self):
        """Regression (Hermes review of #59): published snapshot without initialization is not current."""
        no_init = snapshot()
        payload = json.loads(no_init)
        del payload["discovery"]
        fetch = self.fetch((200, "application/json", json.dumps(payload).encode(), 5), (404, "", b"", 5), (404, "", b"", 5))
        state, data = status.collect_top50(ORIGIN, fetch=fetch, now=NOW, environ={})
        self.assertIsNone(data["products"]["inhabited"]["initialization"])
        self.assertEqual(status.classify_snapshot(data["products"]["inhabited"], NOW, 36), "run_unknown")
        self.assertEqual(state, "degraded")

        base = {"availability": "published", "initialization": "2026-10-04T06:00:00Z",
                "validFrom": "2026-10-04T11:00:00Z", "validTo": "2026-10-05T11:00:00Z"}
        cases = [
            (base, "2026-10-04T12:00:00Z", 36), (base, "2026-10-04T10:00:00Z", 36), (base, "2026-10-05T11:00:00Z", 36),
            (base, "2026-10-04T21:00:01Z", 15), ({**base, "initialization": None}, "2026-10-04T12:00:00Z", 36),
            ({**base, "initialization": None}, "2026-10-05T12:00:00Z", 36),
            ({**base, "initialization": "2026-10-04T11:30:00Z"}, "2026-10-04T12:00:00Z", 36),
            ({**base, "validFrom": "2026-10-04T13:00:00Z", "initialization": "2026-10-04T12:30:00Z"}, "2026-10-04T12:00:00Z", 36),
            ({**base, "validFrom": base["validTo"]}, "2026-10-04T12:00:00Z", 36), ({**base, "validTo": None}, "2026-10-04T12:00:00Z", 36),
            ({"availability": "invalid"}, "2026-10-04T12:00:00Z", 36), ({"availability": "not_published"}, "2026-10-04T12:00:00Z", 36),
            ({"availability": "unavailable"}, "2026-10-04T12:00:00Z", 36),
        ]
        python_states = [status.classify_snapshot(meta, datetime.fromisoformat(at.replace("Z", "+00:00")), hours) for meta, at, hours in cases]
        self.assertEqual(python_states[:6], ["in_window", "upcoming", "expired", "behind", "run_unknown", "expired"])
        node = shutil.which("node")
        if node:
            script = ("import { classifyTop50Snapshot } from './lib/admin/status-contract.mjs';"
                      "const cases = JSON.parse(process.argv[1]);"
                      "console.log(JSON.stringify(cases.map(([meta, at, hours]) => "
                      "classifyTop50Snapshot(meta, Date.parse(at), { maxInitializationAgeHours: hours }).state)));")
            result = subprocess.run([node, "--input-type=module", "-e", script, json.dumps(cases)], cwd=ROOT,
                                    capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout), python_states)

    def test_issue_50_snapshot_metadata_both_products_and_expired_api(self):
        inhabited = json.loads(snapshot())
        inhabited["discovery"].update(retrievedAt="2026-10-04T09:30:00Z", firstSeenReadyAt="2026-10-04T09:25:00Z")
        unfiltered = {"schemaVersion": 1, "model": {
            "initialization": "2026-10-04T06:00:00Z", "retrievedAt": "2026-10-04T09:35:00Z",
            "firstSeenReadyAt": "2026-10-04T09:25:00Z"},
            "generatedAt": "2026-10-04T09:40:00Z", "validFrom": "2026-10-04T10:00:00Z",
            "validTo": "2026-10-04T11:00:00Z", "counts": {"published": 3}}
        fetch = self.fetch((200, "application/json", json.dumps(inhabited).encode(), 5),
                           (503, "application/json", json.dumps({"status": "expired", "initialization": "2026-10-04T06:00:00Z",
                             "validFrom": "2026-10-04T10:00:00Z", "validTo": "2026-10-04T11:00:00Z", "error": SECRET}).encode(), 5),
                           (404, "", b"", 5))
        state, data = status.collect_top50(ORIGIN, fetch=fetch, now=NOW, environ={"HOTSPOT_RUN_LOCATION_LIMIT": "2000", "ADMIN_TOP50_MAX_INIT_AGE_HOURS": "15"})
        self.assertEqual(state, "down")
        self.assertEqual(data["products"]["inhabited"]["firstSeenReadyAt"], "2026-10-04T09:25:00Z")
        self.assertEqual(data["products"]["inhabited"]["retrievedAt"], "2026-10-04T09:30:00Z")
        self.assertEqual(data["products"]["unfiltered"]["initialization"], "2026-10-04T06:00:00Z")
        self.assertEqual(status.classify_snapshot(data["products"]["unfiltered"], NOW, 15), "expired")
        self.assertEqual(data["scheduledBudget"]["limit"], 2000)
        self.assertNotIn(SECRET, json.dumps(data))
        direct, _ = status.extract_snapshot_meta(unfiltered)
        self.assertEqual(direct["firstSeenReadyAt"], "2026-10-04T09:25:00Z")

        def expired_http_error(request, timeout):
            raise urllib.error.HTTPError(request.full_url, 503, "expired", Message(), io.BytesIO(json.dumps({
                "status": "expired", "validFrom": "2026-10-04T10:00:00Z", "validTo": "2026-10-04T11:00:00Z",
            }).encode()))
        code, _, body, _ = status.http_get(f"{ORIGIN}/api/global-grid-hotspots", opener=expired_http_error)
        self.assertEqual(code, 503)
        self.assertEqual(json.loads(body)["status"], "expired")
        _, _, other_body, _ = status.http_get(f"{ORIGIN}/api/forecast", opener=expired_http_error)
        self.assertEqual(other_body, b"")

    def test_in_progress_cycle_is_reported_as_retrying(self):
        fetch = self.fetch((404, "", b"", 5), (404, "", b"", 5), runs(
            {"created_at": "2026-10-04T11:00:00Z", "status": "in_progress", "conclusion": None}))
        _, data = status.collect_top50(ORIGIN, fetch=fetch, now=NOW, environ={})
        self.assertEqual(data["latestFailure"]["outcome"], "in_progress")


class FakeRequest:
    def __init__(self, result):
        self.result = result

    def execute(self):
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


class FakeGsc:
    def __init__(self, rows, inspections):
        self.rows, self.inspections, self.queries, self.inspected = rows, inspections, [], []

    def searchanalytics(self):
        service = self

        class Analytics:
            def query(self, siteUrl, body):
                service.queries.append(body)
                return FakeRequest({"rows": service.rows})
        return Analytics()

    def urlInspection(self):
        service = self

        class Index:
            def inspect(self, body):
                service.inspected.append(body["inspectionUrl"])
                return FakeRequest(service.inspections.get(body["inspectionUrl"], RuntimeError(SECRET)))

        class Inspection:
            def index(self):
                return Index()
        return Inspection()


class HttpError(Exception):
    def __init__(self, status):
        super().__init__(SECRET)
        self.resp = type("Resp", (), {"status": status})()


class SearchTests(unittest.TestCase):
    def test_aggregate_windows_and_bounded_sample(self):
        rows = [{"keys": ["2026-10-01"], "clicks": 7, "impressions": 70}, {"keys": ["2026-09-24"], "clicks": 5, "impressions": 50},
                {"keys": ["2026-09-01"], "clicks": 3, "impressions": 30}]
        indexed = {"inspectionResult": {"indexStatusResult": {"verdict": "PASS", "coverageState": "Submitted and indexed",
                                                               "lastCrawlTime": "2026-09-30T01:02:03Z", "referringUrls": [SECRET]}}}
        service = FakeGsc(rows, {f"{ORIGIN}/": indexed})
        state, data = status.collect_search(service, "sc-domain:wetbulb35.com", date(2026, 10, 4), lambda call: call(),
                                            sample=["/", CITY])
        self.assertEqual(service.queries[0]["dimensions"], ["date"])
        self.assertEqual(data["dataThrough"], "2026-10-01")
        self.assertEqual(data["windows"]["last7"], {"start": "2026-09-25", "end": "2026-10-01", "clicks": 7, "impressions": 70})
        self.assertEqual(data["windows"]["prior7"]["clicks"], 5)
        self.assertEqual(data["windows"]["prior28"]["clicks"], 3)
        self.assertEqual(data["sample"]["requested"], 2)
        self.assertEqual(data["sample"]["inspected"], 1)
        self.assertEqual(data["sample"]["results"][0]["lastCrawlDate"], "2026-09-30")
        self.assertEqual(state, "degraded")
        self.assertNotIn(SECRET, json.dumps(data))
        self.assertEqual(len(status.gsc_sample_paths()), status.GSC_SAMPLE_SIZE)

    def test_sparse_rows_anchor_to_complete_day_not_latest_row(self):
        """Regression (Hermes review of #59): absent zero-impression days must not re-anchor windows."""
        rows = [{"keys": ["2026-09-20"], "clicks": 40, "impressions": 400},
                {"keys": ["2026-09-14"], "clicks": 10, "impressions": 100},
                {"keys": ["2026-10-02"], "clicks": 99, "impressions": 999}]  # incomplete; must be dropped
        service = FakeGsc(rows, {})
        service.rows_metadata = {"firstIncompleteDate": "2026-10-02"}
        original = service.searchanalytics

        def analytics():
            class Analytics:
                def query(self, siteUrl, body):
                    service.queries.append(body)
                    return FakeRequest({"rows": rows, "metadata": service.rows_metadata})
            return Analytics()
        service.searchanalytics = analytics
        state, data = status.collect_search(service, "sc-domain:wetbulb35.com", date(2026, 10, 4), lambda call: call(), sample=[])
        self.assertEqual(service.queries[0]["dataState"], "all")
        self.assertEqual((data["dataThrough"], data["completeThroughBasis"], data["latestDataDate"]), ("2026-10-01", "api_metadata", "2026-09-20"))
        self.assertEqual(data["windows"]["last7"], {"start": "2026-09-25", "end": "2026-10-01", "clicks": 0, "impressions": 0})
        self.assertEqual(data["windows"]["prior7"], {"start": "2026-09-18", "end": "2026-09-24", "clicks": 40, "impressions": 400})
        self.assertEqual(data["windows"]["last28"]["clicks"], 50)
        self.assertEqual(state, "degraded", "a collapse to zero on recent complete days is not ok")

        service.rows_metadata = None
        _, fallback = status.collect_search(service, "sc-domain:wetbulb35.com", date(2026, 10, 4), lambda call: call(), sample=[])
        self.assertEqual((fallback["dataThrough"], fallback["completeThroughBasis"]), ("2026-10-01", "fixed_lag"))
        service.rows_metadata = {"firstIncompleteDate": "2026-12-01"}
        _, implausible = status.collect_search(service, "sc-domain:wetbulb35.com", date(2026, 10, 4), lambda call: call(), sample=[])
        self.assertEqual((implausible["dataThrough"], implausible["completeThroughBasis"]), ("2026-10-01", "fixed_lag"))
        service.searchanalytics = original

    def test_no_rows_reports_zero_windows_not_unknown(self):
        state, data = status.collect_search(FakeGsc([], {}), "sc-domain:wetbulb35.com", date(2026, 10, 4), lambda call: call(), sample=[])
        self.assertEqual(state, "degraded")
        self.assertIsNone(data["latestDataDate"])
        self.assertEqual(data["windows"]["last28"], {"start": "2026-09-04", "end": "2026-10-01", "clicks": 0, "impressions": 0})

    def test_permission_failure_aborts_with_reason_code(self):
        service = FakeGsc([], {})
        service.searchanalytics = lambda: type("A", (), {"query": lambda self, siteUrl, body: FakeRequest(HttpError(403))})()
        doc = status.run_panel("search", lambda: status.collect_search(service, "sc-domain:wetbulb35.com", date(2026, 10, 4), lambda call: call()), None, NOW)
        self.assertEqual((doc["status"], doc["reason"], doc["collectedAt"]), ("unknown", "permission_denied", None))
        self.assertNotIn(SECRET, json.dumps(doc))

    def test_missing_gsc_credentials_is_a_gate_not_a_guess(self):
        with self.assertRaises(status.CollectorError) as caught:
            status.gsc_from_environment({})
        self.assertEqual(caught.exception.reason, "credential_not_configured")


class FakeGa4:
    PRODUCT_EVENTS = frozenset(("forecast_view", "weather_load_success"))

    def __init__(self, sessions):
        self.sessions = sessions

    def daily_sessions(self, client, start, end):
        return self.sessions

    def query_report(self, client, start, end, dimensions=(), metrics=()):
        return [{"eventName": "forecast_view", "eventCount": "4"}, {"eventName": "page_view", "eventCount": "999"},
                {"eventName": "weather_load_success", "eventCount": "1"}]


class Ga4Tests(unittest.TestCase):
    def test_trend_partial_labels_zero_days_and_existing_monitor_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            db = sqlite3.connect(root / "spike.sqlite3")
            db.execute("CREATE TABLE evaluations (date TEXT PRIMARY KEY, sessions INTEGER, attribution TEXT, attribution_hash TEXT, evaluated_at TEXT)")
            db.execute("INSERT INTO evaluations VALUES ('2026-10-03', 1, 'x', 'y', 'z')")
            db.commit()
            db.close()
            (root / "reports").mkdir()
            (root / "reports" / "2026-09-28-weekly.json").write_text("{}")
            sessions = {"20261003": 3, "20261001": 10, "20260926": 8, "20260919": 6}
            state, data = status.collect_ga4(object(), date(2026, 10, 4), FakeGa4(sessions), root / "spike.sqlite3", root / "reports")
        self.assertEqual(state, "ok")
        self.assertEqual(data["latestDataDate"], "2026-10-03")
        self.assertEqual(data["completeThrough"], "2026-10-02")
        self.assertIn({"date": "2026-10-02", "sessions": 0}, data["dailySessions"])
        self.assertEqual(data["dailySessions"][-1], {"date": "2026-10-03", "sessions": 3})
        self.assertEqual(data["last7Sessions"], 18)
        self.assertEqual(data["prior7Sessions"], 6)
        self.assertEqual(data["productEventsLast7"], 5)
        self.assertEqual(data["spikeMonitor"]["lastEvaluatedDate"], "2026-10-03")
        self.assertEqual(data["weeklyReport"]["lastReportDate"], "2026-09-28")

    def test_no_recent_rows_is_degraded_and_missing_credentials_unknown(self):
        state, data = status.collect_ga4(object(), date(2026, 10, 4), FakeGa4({}), pathlib.Path("/nonexistent"), pathlib.Path("/nonexistent"))
        self.assertEqual((state, data["latestDataDate"], data["dailySessions"]), ("degraded", None, []))
        with self.assertRaises(status.CollectorError) as caught:
            status.ga4_from_environment({"GOOGLE_APPLICATION_CREDENTIALS": "/nonexistent/ga4.json"})
        self.assertEqual(caught.exception.reason, "credential_not_configured")


class DocumentTests(unittest.TestCase):
    def test_failures_preserve_previous_result_and_sanitize_reasons(self):
        fresh = status.run_panel("site", lambda: ("ok", {"checks": []}), None, NOW)
        later = datetime(2026, 10, 4, 13, tzinfo=timezone.utc)

        def boom():
            raise RuntimeError(SECRET)
        failed = status.run_panel("site", boom, fresh, later)
        self.assertEqual(failed["collectedAt"], fresh["collectedAt"])
        self.assertEqual(failed["lastAttempt"], {"at": "2026-10-04T13:00:00Z", "outcome": "failed", "reason": "exception"})
        self.assertNotIn(SECRET, json.dumps(failed))
        for error, reason in ((HttpError(429), "quota_limited"), (HttpError(503), "upstream_unavailable"),
                              (urllib.error.URLError(SECRET), "upstream_unavailable"), (TimeoutError(), "timeout"),
                              (ValueError(SECRET), "invalid_response"), (status.CollectorError("bogus"), "exception")):
            self.assertEqual(status.reason_for(error), reason)
        unavailable = status.run_panel("ga4", lambda: (_ for _ in ()).throw(TimeoutError()), None, NOW)
        self.assertEqual((unavailable["status"], unavailable["collectedAt"]), ("unavailable", None))

    def test_alerts_are_material_and_deduplicated(self):
        ok = status.run_panel("site", lambda: ("ok", {"checks": []}), None, NOW)
        down = status.run_panel("site", lambda: ("down", {"checks": []}), ok, NOW)
        self.assertIsNone(status.alert_line(ok, None))
        self.assertEqual(status.alert_line(down, ok), "WetBulb35 admin status: site is down")
        self.assertIsNone(status.alert_line(down, down))
        self.assertIn("recovered", status.alert_line(ok, down))
        failed = status.run_panel("site", lambda: (_ for _ in ()).throw(HttpError(403)), ok, NOW)
        self.assertIn("collector failed (permission_denied)", status.alert_line(failed, ok))

    def test_private_write_permissions_and_kv_publish_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            target = status.write_private(pathlib.Path(directory) / "panels", "site", {"panel": "site"})
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(target.parent.stat().st_mode), 0o700)
        with self.assertRaises(status.CollectorError):
            status.publish_kv({"site": {}}, {})
        sent = []

        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): return False

        def opener(request, timeout):
            sent.append((request.full_url, request.get_method(), request.headers))
            return Response()
        status.publish_kv({"site": {"panel": "site"}}, {"ADMIN_STATUS_KV_ACCOUNT_ID": "acct", "ADMIN_STATUS_KV_NAMESPACE_ID": "ns",
                                                         "ADMIN_STATUS_KV_API_TOKEN": "tok"}, opener=opener)
        self.assertEqual(sent[0][0], "https://api.cloudflare.com/client/v4/accounts/acct/storage/kv/namespaces/ns/values/status%2Fv1%2Fpanel%2Fsite")
        self.assertEqual(sent[0][1], "PUT")


class CliTests(unittest.TestCase):
    def test_cli_without_credentials_reports_gates_and_matches_worker_contract(self):
        site = lambda origin, now: ("ok", {"checks": [{"id": "homepage", "path": "/", "outcome": "ok", "httpStatus": 200, "latencyMs": 1, "checkedAt": "2026-10-04T12:00:00Z"}]})
        _, top50_data = status.collect_top50(ORIGIN, fetch=Top50Tests().fetch((200, "application/json", snapshot(), 5), (404, "", b"", 5), (404, "", b"", 5)), now=NOW, environ={})
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(cli.status, "collect_site", site), \
                patch.object(cli.status, "collect_top50", lambda origin, now, environ: ("ok", top50_data)), \
                patch("urllib.request.urlopen", side_effect=AssertionError("no network in tests")):
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(cli.main(["--output-dir", directory], environ={}), 0)
            lines = output.getvalue().splitlines()
            self.assertIn("WetBulb35 admin status: search collector failed (credential_not_configured); last result kept and labeled stale", lines)
            self.assertIn("WetBulb35 admin status: ga4 collector failed (credential_not_configured); last result kept and labeled stale", lines)
            search = json.loads((pathlib.Path(directory) / "search.json").read_text())
            self.assertEqual((search["status"], search["collectedAt"]), ("unknown", None))
            output = io.StringIO()
            with redirect_stdout(output):
                cli.main(["--output-dir", directory], environ={})
            self.assertEqual(output.getvalue(), "", "repeated identical states must not re-alert")
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(cli.main(["--output-dir", directory, "--panels", "site", "--publish-kv"], environ={}), 2)
            self.assertEqual(errors.getvalue(), "WetBulb35 admin status: publish skipped (not_configured)\n")

            node = shutil.which("node")
            if node:
                result = subprocess.run([node, str(ROOT / "scripts" / "validate-admin-status.mjs"), directory],
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("checked 4 panel document(s); 0 problem(s)", result.stdout)


if __name__ == "__main__":
    unittest.main()
