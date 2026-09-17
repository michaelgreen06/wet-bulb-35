"""Contract tests for the credential-safe GSC cohort tracker."""
from __future__ import annotations

import csv
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
MODULE_PATH = ROOT / "scripts" / "gsc_tracker.py"
SPEC = importlib.util.spec_from_file_location("gsc_tracker", MODULE_PATH)
assert SPEC and SPEC.loader
tracker = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = tracker
SPEC.loader.exec_module(tracker)


def inspection(verdict="PASS"):
    return {
        "verdict": verdict,
        "coverageState": "Submitted and indexed",
        "lastCrawlTime": "2026-01-01T00:00:00Z",
        "googleCanonical": "https://www.wetbulb35.com/a/",
        "userCanonical": "https://www.wetbulb35.com/a/",
        "pageFetchState": "SUCCESSFUL",
        "indexingState": "INDEXING_ALLOWED",
        "robotsTxtState": "ALLOWED",
        "crawledAs": "MOBILE",
        "sitemap": ["https://www.wetbulb35.com/sitemap.xml"],
        "referringUrls": ["https://www.wetbulb35.com/"],
    }


class FakeExecute:
    def __init__(self, value):
        self.value = value

    def execute(self):
        return self.value


class FakeSearchAnalytics:
    def __init__(self, service):
        self.service = service

    def query(self, **kwargs):
        self.service.analytics_calls.append(kwargs)
        return FakeExecute({"rows": self.service.analytics_rows})


class FakeInspectionIndex:
    def __init__(self, service):
        self.service = service

    def inspect(self, **kwargs):
        self.service.inspection_calls.append(kwargs)
        return FakeExecute({"inspectionResult": {"indexStatusResult": inspection()}})


class FakeInspection:
    def __init__(self, service):
        self.service = service

    def index(self):
        return FakeInspectionIndex(self.service)


class FakeService:
    def __init__(self, analytics_rows=None):
        self.analytics_rows = analytics_rows or []
        self.analytics_calls = []
        self.inspection_calls = []

    def searchanalytics(self):
        return FakeSearchAnalytics(self)

    def urlInspection(self):
        return FakeInspection(self)


class CohortTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        self.tier = self.path / "tier.json"
        self.controls = self.path / "controls.json"
        cities = [
            {"rank": rank, "tier": "1A" if rank <= 50 else "1B", "path": f"/wetbulb-temperature/x/s/c{rank}/", "popular": rank <= 40}
            for rank in range(1, 201)
        ]
        self.tier.write_text(json.dumps({"schemaVersion": 1, "cities": cities}))
        self.controls.write_text(json.dumps({
            "schemaVersion": 1,
            "selection": "sha256(route) ascending outside tier1 top-200",
            "controls": [f"/wetbulb-temperature/y/s/k{i}/" for i in range(200)],
        }))

    def tearDown(self):
        self.temp.cleanup()

    def test_nested_tags_and_controls_make_exact_deduplicated_cohort(self):
        cohort = tracker.build_cohort(self.tier, self.controls)
        self.assertEqual(400, len(cohort))
        self.assertEqual(40, sum("popular-40" in item["tags"] for item in cohort))
        self.assertEqual(50, sum("top-50" in item["tags"] for item in cohort))
        self.assertEqual(100, sum("top-100" in item["tags"] for item in cohort))
        self.assertEqual(200, sum("top-200" in item["tags"] for item in cohort))
        self.assertEqual(200, sum(item["tags"] == ["control"] for item in cohort))
        self.assertEqual(400, len({item["url"] for item in cohort}))
        self.assertEqual(["top-200", "top-100", "top-50", "popular-40"], cohort[0]["tags"])

    def test_committed_controls_are_stable_sanitized_and_outside_top_200(self):
        controls = tracker.load_controls(ROOT / "scripts/gsc-control-manifest.json")
        tier = json.loads((ROOT / "scripts/tier1-city-manifest.json").read_text())
        tier_paths = {city["path"] for city in tier["cities"]}
        self.assertEqual(200, len(controls))
        self.assertFalse(tier_paths.intersection(controls))
        result = subprocess.run(
            ["node", "scripts/generate-gsc-controls.mjs", "--check"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(0, result.returncode, result.stderr)


class StorageAndSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "history.sqlite3"
        self.store = tracker.Store(self.db)
        self.store.migrate()
        self.item = {"url": "https://www.wetbulb35.com/a/", "rank": 1, "tags": ["top-200", "top-100", "top-50", "popular-40"]}

    def tearDown(self):
        self.temp.cleanup()

    def save(self, stamp="2026-01-01T00:00:00Z", clicks=1):
        self.store.save_snapshot(stamp, self.item, inspection(), {"clicks": clicks, "impressions": 5}, "2025-12-01", "2025-12-28")

    def test_schema_migration_and_idempotent_upsert_preserve_history(self):
        self.save(clicks=1)
        self.save(clicks=2)
        self.save("2026-01-02T00:00:00Z", clicks=3)
        rows = self.store.rows()
        self.assertEqual(2, len(rows))
        self.assertEqual(2, rows[0]["clicks"])
        self.assertEqual('["top-200","top-100","top-50","popular-40"]', rows[0]["cohort_tags"])
        with sqlite3.connect(self.db) as db:
            self.assertEqual([1, 2, 3], [row[0] for row in db.execute("SELECT version FROM schema_migrations ORDER BY version")])
            columns = {row[1] for row in db.execute("PRAGMA table_info(snapshots)")}
        self.assertNotIn("raw_payload", columns)
        self.assertIn("google_canonical", columns)
        self.assertEqual(0o600, self.db.stat().st_mode & 0o777)

    def test_quota_refuses_before_requests_and_reserves_actual_attempts(self):
        service = FakeService()
        oversized = [{"url": f"https://www.wetbulb35.com/{index}/", "rank": index, "tags": ["top-200"]} for index in range(401)]
        with self.assertRaises(tracker.QuotaError):
            tracker.collect(service, "sc-domain:wetbulb35.com", oversized, "2026-01-01T00:00:00Z", self.store)
        self.assertEqual([], service.inspection_calls)
        with self.store.connect() as db:
            db.execute("INSERT INTO request_reservations VALUES (?,?)", ("2026-01-01T00:00:00Z", 801))
        fixed_now = lambda: datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
        with self.assertRaisesRegex(tracker.QuotaError, "bounded retries"):
            tracker.collect(service, "sc-domain:wetbulb35.com", [self.item] * 400, "2026-01-01T12:00:00Z", self.store, now=fixed_now)
        self.assertEqual([], service.inspection_calls)

        minute_db = Path(self.temp.name) / "minute.sqlite3"
        minute_store = tracker.Store(minute_db)
        minute_store.migrate()
        with minute_store.connect() as db:
            db.executemany("INSERT INTO request_attempts VALUES (?)", [("2026-01-01T11:59:30Z",)] * 600)
        with self.assertRaisesRegex(tracker.QuotaError, "per-minute"):
            tracker.collect(service, "sc-domain:wetbulb35.com", [self.item], "2026-01-01T12:00:00Z", minute_store, now=fixed_now)
        self.assertEqual([], service.analytics_calls)

    def test_collection_extracts_fields_without_raw_payload(self):
        service = FakeService([{
            "keys": [self.item["url"]], "clicks": 3, "impressions": 7, "ctr": 3 / 7, "position": 2.5,
        }])
        moments = iter([
            datetime(2026, 2, 1, 12, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 2, 1, 12, 0, 1, tzinfo=timezone.utc),
        ])
        tracker.collect(
            service,
            "sc-domain:wetbulb35.com",
            [self.item],
            "2026-02-01T12:00:00Z",
            self.store,
            now=lambda: next(moments),
            sleep=lambda _: None,
        )
        row = self.store.rows()[0]
        self.assertEqual("PASS", row["inspection_status"])
        self.assertEqual("Submitted and indexed", row["coverage_state"])
        self.assertEqual(3, row["clicks"])
        self.assertEqual('["https://www.wetbulb35.com/"]', row["referring_urls"])
        self.assertEqual("2026-01-02", row["analytics_start"])
        self.assertEqual("2026-01-29", row["analytics_end"])
        self.assertEqual(1, len(service.inspection_calls))
        self.assertEqual(1, len(service.analytics_calls))

    def test_csv_roundtrip_contains_derived_fields_only(self):
        self.save(clicks=3)
        output = Path(self.temp.name) / "report.csv"
        tracker.export_csv(self.store.rows(), output)
        with output.open(newline="") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual("3", rows[0]["clicks"])
        self.assertEqual("SUCCESSFUL", rows[0]["page_fetch_state"])
        self.assertNotIn("raw_payload", rows[0])
        self.assertEqual(0o600, output.stat().st_mode & 0o777)

    def test_no_credentials_dry_run_never_imports_or_networks(self):
        with patch.object(tracker, "create_google_service", side_effect=AssertionError("must not import client")):
            result = tracker.run([
                "--dry-run",
                "--tier-manifest", str(ROOT / "scripts/tier1-city-manifest.json"),
                "--controls-manifest", str(ROOT / "scripts/gsc-control-manifest.json"),
            ], environ={})
        self.assertEqual(400, result["cohort_size"])

    def test_secret_hygiene_and_smoke_workflow_are_output_free(self):
        source = MODULE_PATH.read_text()
        workflow = (ROOT / ".github/workflows/gsc-credential-smoke-test.yml").read_text()
        recipient = (ROOT / "scripts/gsc-snapshot-artifact-recipient.pem").read_text()
        ignored = (ROOT / ".gitignore").read_text()
        self.assertIn(".private/", ignored)
        self.assertNotIn("print(secret", source)
        self.assertNotIn("print(site_url", source)
        self.assertIn("workflow_dispatch", workflow)
        self.assertNotIn("schedule:", workflow)
        self.assertIn("--smoke-test", workflow)
        self.assertIn("openssl cms -encrypt", workflow)
        self.assertIn("path: gsc-snapshot.cms", workflow)
        self.assertNotIn("path: .private", workflow)
        self.assertIn("retention-days: 7", workflow)
        self.assertIn("Refuse a second encrypted snapshot", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertIn("BEGIN CERTIFICATE", recipient)
        self.assertNotIn("PRIVATE KEY", recipient)

    def test_fixed_retries_only_for_transient_statuses(self):
        calls = []

        def flaky():
            calls.append(1)
            if len(calls) < 3:
                raise tracker.ApiError(503, "temporary")
            return "ok"

        with patch.object(tracker.time, "sleep") as sleep:
            self.assertEqual("ok", tracker.with_fixed_retries(flaky))
            self.assertEqual(2, sleep.call_count)
        with self.assertRaises(tracker.ApiError):
            tracker.with_fixed_retries(lambda: (_ for _ in ()).throw(tracker.ApiError(400, "bad")))

    def test_site_property_validation(self):
        self.assertEqual("sc-domain:wetbulb35.com", tracker.validate_site_url("sc-domain:wetbulb35.com"))
        self.assertEqual("https://www.wetbulb35.com/", tracker.validate_site_url("https://www.wetbulb35.com/"))
        for bad in ("http://www.wetbulb35.com/", "https://www.wetbulb35.com", "sc-domain:WetBulb35.com"):
            with self.assertRaises(ValueError):
                tracker.validate_site_url(bad)
        with self.assertRaisesRegex(ValueError, "under .private"):
            tracker.private_output_path(Path("gsc-report.csv"))


if __name__ == "__main__":
    unittest.main()
