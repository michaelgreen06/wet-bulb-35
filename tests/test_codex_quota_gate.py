"""Focused contract tests for the local Codex quota launch gate."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "codex-quota-gate.py"
WRAPPER_PATH = MODULE_PATH.with_suffix("")
SPEC = importlib.util.spec_from_file_location("codex_quota_gate", MODULE_PATH)
assert SPEC and SPEC.loader
quota_gate = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = quota_gate
SPEC.loader.exec_module(quota_gate)


@dataclass(frozen=True)
class Window:
    label: str
    used_percent: float
    reset_at: datetime


@dataclass(frozen=True)
class Snapshot:
    provider: str = "openai-codex"
    plan: str | None = "Plus"
    fetched_at: datetime = datetime(2026, 9, 7, 12, tzinfo=timezone.utc)
    windows: tuple[Window, ...] = ()
    details: tuple[str, ...] = ()
    unavailable_reason: str | None = None


def snapshot(session_used: float, weekly_used: float, *, details=(), unavailable_reason=None):
    return Snapshot(
        windows=(
            Window("Session", session_used, datetime(2026, 9, 8, 10, 5, 56, tzinfo=timezone.utc)),
            Window("Weekly", weekly_used, datetime(2026, 9, 15, 5, 5, 56, tzinfo=timezone.utc)),
        ),
        details=tuple(details),
        unavailable_reason=unavailable_reason,
    )


class PolicyTests(unittest.TestCase):
    def test_threshold_boundaries_allow(self):
        cases = {
            "trivial": snapshot(98, 95),
            "resumable": snapshot(85, 90),
            "sensitive": snapshot(50, 75),
        }
        for risk_class, usage in cases.items():
            with self.subTest(risk_class=risk_class):
                result = quota_gate.evaluate_snapshot(usage, risk_class)
                self.assertEqual("ALLOW", result.decision)
                self.assertEqual(0, result.exit_code)

    def test_dual_window_failure_uses_later_reset_as_limiter(self):
        result = quota_gate.evaluate_snapshot(snapshot(90, 95), "sensitive")
        self.assertEqual("DEFER_QUOTA", result.decision)
        self.assertEqual("Weekly", result.limiting_window)
        self.assertEqual("2026-09-15T05:05:56Z", result.next_eligible_at)
        self.assertEqual(10, result.exit_code)

    def test_critical_is_never_delegable(self):
        result = quota_gate.evaluate_snapshot(snapshot(0, 0), "critical")
        self.assertEqual("BLOCK", result.decision)
        self.assertEqual(11, result.exit_code)
        self.assertIsNone(result.next_eligible_at)

    def test_critical_blocks_without_a_valid_snapshot(self):
        for usage in (None, snapshot(float("nan"), 0)):
            with self.subTest(usage=usage):
                result = quota_gate.evaluate_snapshot(usage, "critical")
                self.assertEqual(("BLOCK", 11), (result.decision, result.exit_code))

    def test_unavailable_and_malformed_snapshots_fail_closed(self):
        unavailable = quota_gate.evaluate_snapshot(None, "trivial")
        malformed = quota_gate.evaluate_snapshot(snapshot(float("nan"), 0), "trivial")
        self.assertEqual(("UNAVAILABLE", 12), (unavailable.decision, unavailable.exit_code))
        self.assertEqual(("UNAVAILABLE", 12), (malformed.decision, malformed.exit_code))

    def test_json_shape_for_injected_snapshot(self):
        payload, exit_code = quota_gate.run("resumable", lambda: snapshot(0, 0, details=("You have 3 resets banked",)))
        self.assertEqual(0, exit_code)
        self.assertEqual("ALLOW", payload["decision"])
        self.assertEqual("openai-codex", payload["provider"])
        self.assertEqual(3, payload["banked_reset_count"])
        self.assertEqual(
            {"fetched_at", "provider", "plan", "windows", "banked_reset_count", "risk_class", "decision", "reason", "limiting_window", "next_eligible_at"},
            set(payload),
        )
        self.assertEqual({"Session", "Weekly"}, set(payload["windows"]))
        self.assertEqual({"used_percent", "remaining_percent", "reset_at"}, set(payload["windows"]["Session"]))


class WrapperTests(unittest.TestCase):
    def _fake_python(self, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\"\n")
        path.chmod(0o755)
        return path

    def test_wrapper_uses_hermes_home_default(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "hermes"
            self._fake_python(home / "hermes-agent" / "venv" / "bin" / "python")
            completed = subprocess.run(
                [str(WRAPPER_PATH), "trivial"],
                check=False,
                capture_output=True,
                env={**os.environ, "HOME": "/unused", "HERMES_HOME": str(home)},
                text=True,
            )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertEqual([str(MODULE_PATH), "trivial"], completed.stdout.splitlines())

    def test_wrapper_honors_python_override(self):
        with tempfile.TemporaryDirectory() as directory:
            interpreter = self._fake_python(Path(directory) / "python")
            completed = subprocess.run(
                [str(WRAPPER_PATH), "critical"],
                check=False,
                capture_output=True,
                env={**os.environ, "HERMES_PYTHON": str(interpreter)},
                text=True,
            )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertEqual([str(MODULE_PATH), "critical"], completed.stdout.splitlines())

    def test_wrapper_reports_a_missing_interpreter(self):
        completed = subprocess.run(
            [str(WRAPPER_PATH), "trivial"],
            check=False,
            capture_output=True,
            env={**os.environ, "HERMES_PYTHON": "/not/a/python"},
            text=True,
        )
        self.assertEqual(127, completed.returncode)
        self.assertIn("Hermes Python interpreter is not executable: /not/a/python", completed.stderr)


if __name__ == "__main__":
    unittest.main()
