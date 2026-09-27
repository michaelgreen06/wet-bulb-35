import importlib.util
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("weekly", ROOT / "scripts" / "generate-ga4-weekly-report.py")
weekly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(weekly)

class WeeklyReportTests(unittest.TestCase):
    def test_deterministic_decision_report_and_private_atomic_output(self):
        report = weekly.build_weekly_report({
            "coverage": {"start": "2026-09-14", "end": "2026-09-20", "fresh_through": "2026-09-21"},
            "current": {"sessions": 120, "users": 80, "views": 170, "engaged_sessions": 90},
            "previous": {"sessions": 100, "users": 70, "views": 130, "engaged_sessions": 80},
            "channels": [{"name": "Organic Search", "sessions": 90}],
            "sources": [{"name": "google / organic", "sessions": 80}],
            "pages": [{"path": "/", "users": 30, "engaged_sessions": 25, "page_type": "homepage"}],
            "events": {"location_search_success": 10, "location_search_no_match": 2, "weather_load_success": 8, "weather_load_failure": 2},
            "not_set_landing_sessions": 7,
            "warnings": ["(not set) attribution observed"],
        })
        self.assertIn("2026-09-14 to 2026-09-20", report["markdown"])
        self.assertIn("Sessions: 120 (+20.0%)", report["markdown"])
        self.assertIn("Product events", report["markdown"])
        self.assertIn("Search no-match rate: 16.7%", report["markdown"])
        self.assertIn("Weather-load failure rate: 20.0%", report["markdown"])
        self.assertIn("(not set) landing-page sessions: 7", report["markdown"])
        with tempfile.TemporaryDirectory() as directory:
            paths = weekly.write_report_artifacts(report, pathlib.Path(directory), "2026-09-21")
            self.assertEqual(oct(paths["markdown"].stat().st_mode & 0o777), "0o600")
            self.assertTrue(paths["json"].exists())

if __name__ == "__main__":
    unittest.main()
