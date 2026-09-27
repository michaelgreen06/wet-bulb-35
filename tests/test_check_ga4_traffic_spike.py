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

    def test_dedupes_unless_material_revision_or_known_attribution(self):
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory) / "state.sqlite3"
            alert = {"date": "2026-09-20", "sessions": 150, "attribution": "unknown", "body": "a"}
            self.assertTrue(spike.record_if_new(state, alert))
            self.assertFalse(spike.record_if_new(state, alert))
            self.assertTrue(spike.record_if_new(state, {**alert, "sessions": 181}))
            self.assertTrue(spike.record_if_new(state, {**alert, "sessions": 181, "attribution": "google / organic"}))

    def test_data_quality_and_repeat_heavy_labels(self):
        body = spike.render_alert({"date": "2026-09-20", "sessions": 180, "median": 20, "sources": [{"name": "(not set)", "sessions": 160}], "repeat_heavy": True, "countries": [], "pages": []})
        self.assertIn("data-quality", body)
        self.assertIn("repeat-heavy", body)
        self.assertLessEqual(len(body.splitlines()), 10)

if __name__ == "__main__":
    unittest.main()
