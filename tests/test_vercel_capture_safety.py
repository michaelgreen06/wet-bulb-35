"""Safety contracts for the read-only Vercel recovery capture."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts" / "capture-vercel-recovery-baseline.sh"
CAPTURES = ROOT / "docs" / "phase1" / "captures" / "vercel"


class CaptureScriptSafetyTests(unittest.TestCase):
    def test_uses_installed_vercel_or_explicit_executable_override(self):
        source = SCRIPT.read_text()
        self.assertIn('VERCEL_BIN="${VERCEL_BIN:-vercel}"', source)
        self.assertIn('command -v "$VERCEL_BIN"', source)
        self.assertIn('"$VERCEL_BIN" --version', source)
        self.assertNotIn("VERCEL" + "_CLI_VERSION", source)

    def test_has_no_package_runner_or_install_path(self):
        source = SCRIPT.read_text().lower()
        for forbidden in ("npx", "npm install", "npm i ", "npm ci", "pnpm add", "yarn add"):
            self.assertNotIn(forbidden, source)

    def test_vercel_subcommands_are_read_only_allowlisted(self):
        source = SCRIPT.read_text()
        import re

        calls = set(re.findall(r"^\s*(?:if\s+)?run\s+([a-z]+(?:\s+[a-z]+)?)", source, re.MULTILINE))
        self.assertEqual(
            {"teams ls", "project inspect", "list", "env list", "domains list", "inspect", "env pull", "usage"},
            calls,
        )

    def test_missing_override_fails_before_remote_capture(self):
        completed = subprocess.run(
            [str(SCRIPT)],
            cwd=ROOT,
            env={**os.environ, "VERCEL_BIN": "/definitely/missing/vercel"},
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(1, completed.returncode)
        self.assertIn("Vercel executable is not executable", completed.stderr)
        self.assertNotIn("Captured sanitized", completed.stdout)

    def test_explicit_override_is_used_without_a_package_runner(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            executable = directory / "vercel"
            invocation_log = directory / "invocations"
            executable.write_text(
                "#!/bin/sh\n"
                "printf '%s\\n' \"$@\" >> \"$VERCEL_TEST_LOG\"\n"
                "if [ \"$1\" = \"--version\" ]; then echo 'Vercel CLI 1.2.3'; exit 0; fi\n"
                "exit 99\n"
            )
            executable.chmod(0o755)
            completed = subprocess.run(
                [str(SCRIPT)],
                cwd=ROOT,
                env={
                    **os.environ,
                    "VERCEL_BIN": str(executable),
                    "VERCEL_TEST_LOG": str(invocation_log),
                    "VERCEL_CAPTURE_DIR": str(directory / "captures"),
                    "VERCEL_BACKUP_DIR": str(directory / "backups"),
                },
                capture_output=True,
                text=True,
                check=False,
            )
            invocations = invocation_log.read_text().splitlines()
        self.assertEqual(99, completed.returncode)
        self.assertEqual(["--version", "teams", "ls", "--json", "--scope"], invocations[:5])


class CommittedEvidenceAllowlistTests(unittest.TestCase):
    def load(self, name: str):
        return json.loads((CAPTURES / name).read_text())

    def assert_keys(self, value, keys):
        self.assertEqual(set(keys), set(value), value)

    def test_environment_metadata_has_no_values(self):
        value = self.load("environment-metadata.json")
        self.assert_keys(value, {"value_policy", "variables"})
        for item in value["variables"]:
            self.assert_keys(item, {"key", "type", "target", "configurationId", "createdAt", "updatedAt"})
            self.assertNotIn("value", item)

    def test_manifest_contains_only_metadata_and_cli_version(self):
        value = self.load("recovery-manifest.json")
        self.assert_keys(value, {"schema_version", "captured_at_utc", "read_only", "scope_slug", "project", "detected_cli_version", "current_production", "files", "private_production_environment_backup"})
        self.assert_keys(value["current_production"], {"id", "url", "source_sha"})
        self.assert_keys(value["private_production_environment_backup"], {"path", "sha256", "bytes", "mode", "values_committed", "sensitive_placeholder_count", "complete", "gap"})

    def test_remaining_evidence_uses_explicit_safe_field_sets(self):
        project = self.load("project.json")
        self.assert_keys(project, {"id", "name", "scope_slug"})

        scope = self.load("scope.json")
        self.assert_keys(scope, {"scope_slug", "teams"})
        for team in scope["teams"]:
            self.assert_keys(team, {"id", "slug", "name", "current"})

        domains = self.load("domains.json")
        self.assert_keys(domains, {"domains", "dns_boundary"})
        for domain in domains["domains"]:
            self.assert_keys(domain, {"name", "registrar", "nameservers", "createdAt"})

        production = self.load("current-production.json")
        self.assert_keys(production, {"id", "url", "readyState", "target", "createdAt", "aliases", "source", "builds"})
        self.assert_keys(production["source"], {"sha", "ref", "repository"})
        for build in production["builds"]:
            self.assert_keys(build, {"id", "entrypoint", "use", "createdIn", "config", "outputs"})
            self.assert_keys(build["config"], {"buildCommand", "installCommand", "nodeVersion", "projectCreatedAt", "vercelConfig"})
            self.assert_keys(build["config"]["vercelConfig"], {"buildCommand", "ignoreCommand", "installCommand"})
            for output in build["outputs"]:
                self.assert_keys(output, {"path", "type", "size", "runtime", "memorySize", "timeout", "deployedTo"})

        inventory = self.load("deployment-inventory.json")
        self.assert_keys(inventory, {"count", "retention_note", "deployments"})
        for deployment in inventory["deployments"]:
            self.assert_keys(deployment, {"id", "url", "state", "target", "createdAt", "readyAt", "source", "aliases", "inspect_error"})
            self.assert_keys(deployment["source"], {"sha", "ref", "repository", "pr"})

        reachability = self.load("production-reachability.json")
        self.assert_keys(reachability, {"url", "head_status", "headers"})

        usage = self.load("observability-usage.json")
        self.assert_keys(usage, {"status", "capture", "analytics_note"})


if __name__ == "__main__":
    unittest.main()
