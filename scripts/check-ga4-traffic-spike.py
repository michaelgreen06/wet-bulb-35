#!/usr/bin/env python3
"""Detect and deduplicate material GA4 traffic spikes without retaining raw rows."""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sqlite3
import statistics
import sys
from datetime import date, timedelta

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from wetbulb_ga4 import daily_sessions, ga4_client, report_bundle

DEFAULT_STATE = pathlib.Path("/home/laclaw/.local/share/wetbulb35-ga4/state/spike-alert.sqlite3")


def is_material_spike(sessions, baseline):
    if len(baseline) != 28:
        return False
    median = statistics.median(baseline)
    mad = statistics.median(abs(value - median) for value in baseline)
    relative_spike = sessions >= 2 * median
    robust_spike = sessions > median + 4 * mad
    return sessions >= 100 and sessions - median >= 100 and (relative_spike or robust_spike)


def evaluate_target(target, baseline):
    if not target.get("complete") or len(baseline) != 28:
        return None
    sessions = int(target.get("sessions", 0))
    if not is_material_spike(sessions, baseline):
        return None
    return {**target, "median": statistics.median(baseline),
            "mad": statistics.median(abs(value - statistics.median(baseline)) for value in baseline)}


def _connect(path):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(path)
    path.chmod(0o600)
    db.execute("CREATE TABLE IF NOT EXISTS alerts (date TEXT PRIMARY KEY, sessions INTEGER NOT NULL, attribution TEXT NOT NULL, content_hash TEXT NOT NULL, alerted_at TEXT DEFAULT CURRENT_TIMESTAMP)")
    db.execute("CREATE TABLE IF NOT EXISTS evaluations (date TEXT PRIMARY KEY, sessions INTEGER NOT NULL, attribution TEXT NOT NULL, attribution_hash TEXT NOT NULL, evaluated_at TEXT DEFAULT CURRENT_TIMESTAMP)")
    return db


def record_evaluation(path, target):
    attribution = target.get("attribution", "unknown")
    attribution_hash = hashlib.sha256(json.dumps(target.get("sources", []), sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    db = _connect(path)
    try:
        db.execute("INSERT OR REPLACE INTO evaluations(date, sessions, attribution, attribution_hash) VALUES (?, ?, ?, ?)",
                   (target["date"], int(target.get("sessions", 0)), attribution, attribution_hash))
        db.commit()
    finally:
        db.close()


def record_if_new(path, alert):
    digest = hashlib.sha256(json.dumps(alert, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    db = _connect(path)
    try:
        prior = db.execute("SELECT sessions, attribution FROM alerts WHERE date=?", (alert["date"],)).fetchone()
        allowed = (not prior or abs(alert["sessions"] - prior[0]) / max(prior[0], 1) >= 0.2
                   or (prior[1] == "unknown" and alert["attribution"] != "unknown"))
        if allowed:
            db.execute("INSERT OR REPLACE INTO alerts(date, sessions, attribution, content_hash) VALUES (?, ?, ?, ?)",
                       (alert["date"], alert["sessions"], alert["attribution"], digest))
            db.commit()
        return allowed
    finally:
        db.close()


def _named(rows, count=3):
    return [f"{row['name']} ({row.get('sessions', 0)})" for row in rows[:count]]


def render_alert(alert):
    sources = alert.get("sources", [])
    warnings = []
    attribution = alert.get("attribution", "unknown")
    if sources and sources[0]["name"] == "(not set)":
        warnings.append("data-quality: (not set) source dominates; no source claim")
    if alert.get("repeat_heavy"):
        warnings.append("repeat-heavy traffic: do not call this broad demand")
    if alert.get("not_set_landing_sessions"):
        warnings.append(f"data-quality: {alert['not_set_landing_sessions']} sessions have no landing page")
    lines = [f"GA4 spike {alert['date']}: {alert['sessions']} sessions vs median {alert['median']}"]
    lines += [f"- {warning}" for warning in warnings]
    if attribution != "unknown":
        lines.append("- Sources: " + "; ".join(_named(sources)))
    lines.extend([
        "- Countries: " + "; ".join(_named(alert.get("countries", []))),
        "- Regions: " + "; ".join(_named(alert.get("regions", []))),
        "- Landing pages: " + "; ".join(
            f"{row['path']} ({row['users']} users; {row['engaged_sessions']} engaged)" for row in alert.get("pages", [])[:3]),
    ])
    return "\n".join(line for line in lines if not line.endswith(": "))[:4000]


def collect_target(client, target_date):
    bundle = report_bundle(client, target_date, target_date)
    headline = bundle["headline"]
    sources = bundle["sources"]
    attribution = "unknown" if not sources or sources[0]["name"] == "(not set)" else sources[0]["name"]
    return {
        "date": target_date, "sessions": headline["sessions"], "complete": True,
        "sources": sources, "countries": bundle["countries"], "regions": bundle["regions"],
        "pages": bundle["pages"], "repeat_heavy": bool(bundle["repeat_heavy_pages"]),
        "not_set_landing_sessions": bundle["not_set_landing_sessions"], "attribution": attribution,
    }


def evaluate_dates(client, as_of):
    as_of = date.fromisoformat(str(as_of)) if not isinstance(as_of, date) else as_of
    targets = [as_of - timedelta(days=1), as_of - timedelta(days=2)]
    earliest = targets[-1] - timedelta(days=28)
    sessions_by_day = daily_sessions(client, earliest.isoformat(), targets[0].isoformat())
    alerts, evaluated = [], []
    for target in targets:
        baseline_days = [target - timedelta(days=offset) for offset in range(1, 29)]
        # GA4 omits zero-session days; treat missing baseline days as 0 so one quiet day cannot mute alerts.
        baseline = [sessions_by_day.get(day.strftime("%Y%m%d"), 0) for day in baseline_days]
        target_key = target.strftime("%Y%m%d")
        target_data = collect_target(client, target.isoformat())
        target_data["complete"] = target_key in sessions_by_day
        target_data["sessions"] = sessions_by_day.get(target_key, target_data["sessions"])
        evaluated.append(target_data)
        alert = evaluate_target(target_data, baseline)
        if alert:
            alerts.append(alert)
    return alerts, evaluated


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", default=date.today().isoformat())
    parser.add_argument("--state", default=str(DEFAULT_STATE))
    args = parser.parse_args(argv)
    emitted = False
    alerts, evaluated = evaluate_dates(ga4_client(), args.as_of)
    for target in evaluated:
        record_evaluation(args.state, target)
    for alert in alerts:
        alert["body"] = render_alert(alert)
        if record_if_new(args.state, alert):
            print(alert["body"])
            emitted = True
    return 0 if emitted else 0


if __name__ == "__main__":
    raise SystemExit(main())
