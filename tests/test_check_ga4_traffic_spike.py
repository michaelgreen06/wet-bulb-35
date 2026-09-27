import importlib.util
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("spike", ROOT / "scripts" / "check-ga4-traffic-spike.py")
spike = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spike)

class SpikeAlertTests(unittest.TestCase):
    def test_threshold_and_incomplete_days(self):
        baseline = [20] * 28
        self.assertTrue(spike.is_material_spike(150, baseline))
        self.assertFalse(spike.is_material_spike(99, baseline))
        self.assertFalse(spike.is_material_spike(80, [0] * 28))
        self.assertIsNone(spike.evaluate_target({"complete": False, "sessions": 200}, baseline))

    def test_relative_or_robust_threshold_can_independently_trigger(self):
        noisy_baseline = [100, 200] * 14
        self.assertTrue(spike.is_material_spike(300, noisy_baseline))
        robust_baseline = [190, 210] * 14
        self.assertTrue(spike.is_material_spike(301, robust_baseline))

    def test_dedupes_unless_material_revision_or_known_attribution(self):
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory) / "state.sqlite3"
            alert = {"date": "2026-09-20", "sessions": 150, "attribution": "unknown", "body": "a"}
            self.assertTrue(spike.record_if_new(state, alert))
            self.assertFalse(spike.record_if_new(state, alert))
            self.assertTrue(spike.record_if_new(state, {**alert, "sessions": 181}))
            self.assertTrue(spike.record_if_new(state, {**alert, "sessions": 181, "attribution": "google / organic"}))

    def test_persists_every_evaluation_without_raw_source_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory) / "state.sqlite3"
            spike.record_evaluation(state, {"date": "2026-09-20", "sessions": 150, "attribution": "unknown", "sources": [{"name": "(not set)", "sessions": 150}]})
            import sqlite3
            row = sqlite3.connect(state).execute("SELECT date, sessions, attribution, attribution_hash FROM evaluations").fetchone()
            self.assertEqual(row[:3], ("2026-09-20", 150, "unknown"))
            self.assertEqual(len(row[3]), 64)
            self.assertEqual(state.stat().st_mode & 0o777, 0o600)

    def test_missing_baseline_days_count_as_zero(self):
        from datetime import date, timedelta
        from unittest.mock import patch
        target = date(2026, 9, 20)
        by_day = {(target - timedelta(days=n)).strftime("%Y%m%d"): 20 for n in range(1, 29) if n != 5}
        by_day[target.strftime("%Y%m%d")] = 150
        with patch.object(spike, "daily_sessions", return_value=by_day), \
             patch.object(spike, "collect_target", side_effect=lambda _c, d: {"date": d, "sessions": 0, "sources": []}):
            alerts, _ = spike.evaluate_dates(None, target + timedelta(days=1))
        self.assertEqual([alert["date"] for alert in alerts], [target.isoformat()])

    def test_data_quality_and_repeat_heavy_labels(self):
        body = spike.render_alert({"date": "2026-09-20", "sessions": 180, "median": 20, "sources": [{"name": "(not set)", "sessions": 160}], "repeat_heavy": True, "countries": [], "pages": []})
        self.assertIn("data-quality", body)
        self.assertIn("repeat-heavy", body)
        self.assertLessEqual(len(body.splitlines()), 10)

if __name__ == "__main__":
    unittest.main()
