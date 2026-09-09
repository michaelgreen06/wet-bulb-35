import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "scripts" / "capture-cloudflare-cutover-readiness.py").read_text()


class CloudflareCutoverCaptureSafetyTest(unittest.TestCase):
    def test_capture_is_allowlisted_and_read_only(self):
        self.assertIn('TOKEN_NAME = "WETBULB35_CLOUDFLARE_API_TOKEN"', SOURCE)
        self.assertIn('request = urllib.request.Request(url, headers=', SOURCE)
        self.assertNotIn('method="POST"', SOURCE)
        self.assertNotIn('method="PUT"', SOURCE)
        self.assertNotIn('method="PATCH"', SOURCE)
        self.assertNotIn('method="DELETE"', SOURCE)
        self.assertNotIn("npx", SOURCE)
        self.assertIn('HTTP error bodies and all provider payload fields outside explicit allowlists are discarded.', SOURCE)

    def test_capture_never_uses_live_tail_or_weather_http(self):
        self.assertNotIn("live-tail", SOURCE)
        self.assertNotIn("/api/weather", SOURCE)
        self.assertIn('"secret_names": secret_names', SOURCE)
        self.assertNotIn('"secret_values"', SOURCE)


if __name__ == "__main__":
    unittest.main()
