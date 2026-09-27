#!/usr/bin/env python3
from __future__ import annotations
import json, os, pathlib, tempfile

def _pct(now, before): return "n/a" if not before else f"{((now-before)/before)*100:+.1f}%"
def build_weekly_report(data):
    coverage, current, previous = data["coverage"], data["current"], data["previous"]
    lines = [f"# GA4 weekly report: {coverage['start']} to {coverage['end']}", f"Data fresh through: {coverage['fresh_through']}", "", "## Headline", f"- Sessions: {current['sessions']} ({_pct(current['sessions'], previous['sessions'])})", f"- Users: {current['users']} ({_pct(current['users'], previous['users'])})", f"- Views: {current['views']} ({_pct(current['views'], previous['views'])})", f"- Engaged sessions: {current['engaged_sessions']} ({_pct(current['engaged_sessions'], previous['engaged_sessions'])})", "", "## Product events"]
    events = data.get("events", {})
    for name in sorted(events): lines.append(f"- {name}: {events[name]}")
    if events.get("location_search_success", 0): lines.append(f"- Search no-match rate: {events.get('location_search_no_match', 0) / events['location_search_success']:.1%}")
    if data.get("warnings"):
        lines += ["", "## Watch", *[f"- {item}" for item in data["warnings"][:5]]]
    return {"markdown": "\n".join(lines) + "\n", "data": data}
def write_report_artifacts(report, output_root, report_date):
    output_root = pathlib.Path(output_root); output_root.mkdir(parents=True, exist_ok=True)
    result = {}
    for key, content in (("markdown", report["markdown"]), ("json", json.dumps(report["data"], sort_keys=True, indent=2) + "\n")):
        target = output_root / f"{report_date}-weekly.{ 'md' if key == 'markdown' else 'json'}"
        with tempfile.NamedTemporaryFile("w", dir=output_root, delete=False) as handle: handle.write(content); name = handle.name
        os.chmod(name, 0o600); os.replace(name, target); result[key] = target
    return result
