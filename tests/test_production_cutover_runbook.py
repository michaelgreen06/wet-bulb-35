import json
import re
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNBOOK = ROOT / "docs/phase1/production-cutover-runbook.md"
CHECKLIST = ROOT / "docs/phase1/production-cutover-checklist.json"
ROUTE_FREE_EVIDENCE = ROOT / "docs/phase1/evidence/route-free-production-worker.json"
ROUTE_FREE = ROOT / "wrangler.weather-production.toml"
ROUTE_BEARING = ROOT / "wrangler.weather-production-route.toml"


class ProductionCutoverRunbookTests(unittest.TestCase):
    def setUp(self):
        self.text = RUNBOOK.read_text(encoding="utf-8")
        self.checklist = json.loads(CHECKLIST.read_text(encoding="utf-8"))
        self.route_free_evidence = json.loads(ROUTE_FREE_EVIDENCE.read_text(encoding="utf-8"))

    def test_required_gates_and_evidence_are_present(self):
        for required in (
            "Merge and retarget the stack",
            "Provision a production-named Worker with no route",
            "Install the encrypted secret by name",
            "Dry/live canary",
            "Attach exactly one route",
            "HTML/SEO/assets/404/weather budget",
            "email obfuscation and managed robots",
            "Rollback: delete the exact route",
            "Owner and window approvals",
            "Apex is separately verified",
            "[SENSITIVE]",
            "retained Vercel deployment",
        ):
            self.assertIn(required, self.text)
        self.assertEqual(self.checklist["schema"], 1)
        self.assertTrue(self.checklist["sanitized"])
        self.assertEqual(self.checklist["scope"]["route"], "www.wetbulb35.com/*")
        self.assertEqual(self.checklist["scope"]["apex"], "wetbulb35.com")

    def test_production_mutations_are_not_authorized_and_secrets_absent(self):
        self.assertNotIn("npx", self.text.lower())
        self.assertNotIn("OPENWEATHER_API_KEY=", self.text)
        self.assertNotIn("WETBULB35_CLOUDFLARE_API_TOKEN=", self.text)
        mutation_lines = [
            line for line in self.text.splitlines()
            if re.search(r"(?:\./node_modules/\.bin/wrangler (?:deploy|secret put)|gh pr (?:merge|edit))", line)
        ]
        self.assertGreaterEqual(len(mutation_lines), 9)
        for line in mutation_lines:
            self.assertIn("NOT AUTHORIZED", line)

    def test_production_configs_are_route_free_twins_except_for_exact_route(self):
        route_free_text = ROUTE_FREE.read_text(encoding="utf-8")
        route_text = ROUTE_BEARING.read_text(encoding="utf-8")
        route_free = tomllib.loads(route_free_text)
        route_bearing = tomllib.loads(route_text)
        self.assertNotIn("routes", route_free)
        self.assertNotIn("route", route_free)
        self.assertNotIn("custom_domain", route_free)
        self.assertFalse(route_free["workers_dev"])
        self.assertFalse(route_free["preview_urls"])
        self.assertEqual(route_free["name"], "wetbulb35-weather-production")
        self.assertEqual(route_bearing.pop("routes"), [{"pattern": "www.wetbulb35.com/*", "zone_name": "wetbulb35.com"}])
        self.assertEqual(route_bearing, route_free)
        for text in (route_free_text, route_text):
            self.assertNotIn("OPENWEATHER_API_KEY", text)
            self.assertNotIn("api_token", text.lower())

    def test_checklist_encodes_stop_conditions_without_provider_values(self):
        encoded = json.dumps(self.checklist, sort_keys=True)
        self.assertNotIn("[SENSITIVE]", encoded)
        self.assertNotIn("OPENWEATHER_API_KEY=", encoded)
        self.assertIn("abort_conditions", self.checklist)
        self.assertIn("approvals", self.checklist)
        self.assertEqual(self.checklist["recommendation"]["control_plane"], "route")

    def test_route_free_production_evidence_has_no_public_target(self):
        evidence = self.route_free_evidence
        self.assertTrue(evidence["sanitized"])
        self.assertEqual(evidence["worker"], "wetbulb35-weather-production")
        self.assertFalse(evidence["configuration"]["workers_dev"])
        self.assertFalse(evidence["configuration"]["preview_urls"])
        self.assertEqual(evidence["configuration"]["route_keys"], [])
        self.assertEqual(evidence["deployment"]["targets_deployed"], 0)
        self.assertEqual(evidence["secret_names"], ["OPENWEATHER_API_KEY"])
        self.assertEqual(evidence["postconditions"]["production_zone_worker_routes"], 0)
        self.assertEqual(evidence["postconditions"]["account_custom_domains"], 0)
        self.assertFalse(evidence["postconditions"]["production_traffic_changed"])
        self.assertEqual(evidence["postconditions"]["weather_requests_made"], 0)


if __name__ == "__main__":
    unittest.main()
