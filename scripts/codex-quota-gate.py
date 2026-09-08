#!/usr/bin/env python3
"""Fail-closed Codex quota gate for local subagent-launch orchestration."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import re
import sys
from typing import Any, Callable, Optional


PROVIDER = "openai-codex"
EXIT_ALLOW = 0
EXIT_DEFER_QUOTA = 10
EXIT_BLOCK_CRITICAL = 11
EXIT_UNAVAILABLE = 12
REQUIRED_REMAINING = {
    "trivial": {"Session": 2.0, "Weekly": 5.0},
    "resumable": {"Session": 15.0, "Weekly": 10.0},
    "sensitive": {"Session": 50.0, "Weekly": 25.0},
}
WINDOW_ORDER = ("Session", "Weekly")
BANKED_RESETS = re.compile(r"\b(\d+)\s+resets?\s+banked\b", re.IGNORECASE)


@dataclass(frozen=True)
class GateResult:
    decision: str
    reason: str
    limiting_window: Optional[str]
    next_eligible_at: Optional[str]
    exit_code: int


def utc_timestamp(value: datetime) -> str:
    """Render an aware datetime as a canonical UTC ISO-8601 string."""
    if value.tzinfo is None:
        raise ValueError("timestamp must include a timezone")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _finite_percentage(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) and 0.0 <= number <= 100.0 else None


def normalized_windows(snapshot: Any) -> Optional[dict[str, dict[str, Any]]]:
    """Validate and normalize the two Codex limit windows from a Hermes snapshot."""
    if snapshot is None or getattr(snapshot, "unavailable_reason", None):
        return None
    try:
        raw_windows = tuple(snapshot.windows)
    except (AttributeError, TypeError):
        return None

    result: dict[str, dict[str, Any]] = {}
    for window in raw_windows:
        label = getattr(window, "label", None)
        if label not in WINDOW_ORDER or label in result:
            continue
        used = _finite_percentage(getattr(window, "used_percent", None))
        reset_at = getattr(window, "reset_at", None)
        if used is None or not isinstance(reset_at, datetime) or reset_at.tzinfo is None:
            return None
        result[label] = {
            "used_percent": used,
            "remaining_percent": 100.0 - used,
            "reset_at": utc_timestamp(reset_at),
        }
    return result if set(result) == set(WINDOW_ORDER) else None


def evaluate_snapshot(snapshot: Any, risk_class: str) -> GateResult:
    """Apply the launch policy without network access; suitable for dependency-injected tests."""
    if risk_class == "critical":
        return GateResult(
            "BLOCK",
            "Critical work must not be delegated; redesign it or execute it in the parent.",
            None,
            None,
            EXIT_BLOCK_CRITICAL,
        )
    windows = normalized_windows(snapshot)
    if windows is None:
        return GateResult("UNAVAILABLE", "Codex quota data is unavailable or malformed.", None, None, EXIT_UNAVAILABLE)

    failed = [
        label for label in WINDOW_ORDER
        if windows[label]["remaining_percent"] < REQUIRED_REMAINING[risk_class][label]
    ]
    if not failed:
        return GateResult("ALLOW", f"Quota satisfies {risk_class} requirements.", None, None, EXIT_ALLOW)

    # The latest failed reset controls the first moment all failed windows qualify.
    limiting_window = max(failed, key=lambda label: (windows[label]["reset_at"], label))
    reason = "; ".join(
        f"{label} remaining {windows[label]['remaining_percent']:.2f}% is below required "
        f"{REQUIRED_REMAINING[risk_class][label]:.2f}%"
        for label in failed
    )
    return GateResult(
        "DEFER_QUOTA", reason, limiting_window, windows[limiting_window]["reset_at"], EXIT_DEFER_QUOTA
    )


def banked_reset_count(snapshot: Any) -> Optional[int]:
    """Extract the optional count Hermes exposes in its structured snapshot details."""
    try:
        details = tuple(snapshot.details)
    except (AttributeError, TypeError):
        return None
    for detail in details:
        match = BANKED_RESETS.search(str(detail))
        if match:
            return int(match.group(1))
    return None


def _fetched_at(snapshot: Any) -> str:
    value = getattr(snapshot, "fetched_at", None)
    if isinstance(value, datetime) and value.tzinfo is not None:
        return utc_timestamp(value)
    return utc_timestamp(datetime.now(timezone.utc))


def run(risk_class: str, fetcher: Callable[[], Any]) -> tuple[dict[str, Any], int]:
    """Fetch one snapshot and return the JSON-safe payload plus its process exit code."""
    try:
        snapshot = fetcher()
    except Exception:
        snapshot = None
    windows = normalized_windows(snapshot)
    result = evaluate_snapshot(snapshot, risk_class)
    payload: dict[str, Any] = {
        "fetched_at": _fetched_at(snapshot),
        "provider": getattr(snapshot, "provider", PROVIDER) if snapshot is not None else PROVIDER,
        "plan": getattr(snapshot, "plan", None) if snapshot is not None else None,
        "windows": windows or {},
        "risk_class": risk_class,
        "decision": result.decision,
        "reason": result.reason,
        "limiting_window": result.limiting_window,
        "next_eligible_at": result.next_eligible_at,
    }
    resets = banked_reset_count(snapshot)
    if resets is not None:
        payload["banked_reset_count"] = resets
    return payload, result.exit_code


def fetch_codex_usage() -> Any:
    """Import Hermes only at the network boundary so policy tests stay dependency-free."""
    from agent.account_usage import fetch_account_usage

    return fetch_account_usage(PROVIDER)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("risk_class", choices=("trivial", "resumable", "sensitive", "critical"))
    args = parser.parse_args(argv)
    payload, exit_code = run(args.risk_class, fetch_codex_usage)
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
