import pathlib
import json
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "scripts" / "capture-cloudflare-cutover-readiness.py").read_text()
EVIDENCE = ROOT / "docs" / "phase1" / "evidence" / "cloudflare-cutover-readiness.json"


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

    def test_active_status_is_separate_from_deduplicated_retained_history(self):
        self.assertIn('["deployments", "status", "--config", str(CONFIG), "--json"]', SOURCE)
        self.assertIn('["deployments", "list", "--config", str(CONFIG), "--json"]', SOURCE)
        self.assertIn('retained_version_ids: set[str] = set()', SOURCE)
        self.assertIn('"active_deployment_id": active_deployment_id', SOURCE)
        self.assertIn('"active_versions": active_versions', SOURCE)
        self.assertNotIn('staging_status.get("author_email")', SOURCE)
        self.assertNotIn('staging_status.get("annotations")', SOURCE)

    def test_committed_staging_evidence_has_an_explicit_safe_schema(self):
        value = json.loads(EVIDENCE.read_text())
        self.assertEqual(2, value["schema"])
        worker = value["staging_worker"]
        self.assertEqual(
            {
                "name", "deployment_status_access", "active_deployment_id", "active_versions",
                "retained_deployments_access", "retained_version_ids", "secret_list_access", "secret_names",
            },
            set(worker),
        )
        for version in worker["active_versions"]:
            self.assertEqual({"version_id", "percentage"}, set(version))
            self.assertIsInstance(version["version_id"], str)
            self.assertIsInstance(version["percentage"], (int, float))
        self.assertEqual(sorted(set(worker["retained_version_ids"])), worker["retained_version_ids"])
        serialized = json.dumps(worker).lower()
        self.assertNotIn("author_email", serialized)
        self.assertNotIn("annotations", serialized)


if __name__ == "__main__":
    unittest.main()
