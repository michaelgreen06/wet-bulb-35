#!/usr/bin/env python3
"""Generate a private, read-only GA4 weekly decision report."""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import tempfile
from datetime import date, timedelta

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from wetbulb_ga4 import ga4_client, report_bundle

DEFAULT_OUTPUT_ROOT = pathlib.Path("/home/laclaw/.local/share/wetbulb35-ga4/reports")


def _pct(now, before):
    return "n/a" if not before else f"{((now - before) / before) * 100:+.1f}%"


def complete_week(as_of):
    """The immediately preceding Monday-Sunday week."""
    as_of = date.fromisoformat(str(as_of)) if not isinstance(as_of, date) else as_of
    end = as_of - timedelta(days=as_of.weekday() + 1)
    return end - timedelta(days=6), end


def _list(rows, metric="sessions", count=5):
    return ", ".join(f"{row['name']} ({row.get(metric, 0)})" for row in rows[:count]) or "none"


def _page_list(pages, count=5):
    return ", ".join(f"{row['path']} ({row['users']} users; {row['engaged_sessions']} engaged)" for row in pages[:count]) or "none"


def _failure_rate(events, success, failure):
    total = events.get(success, 0) + events.get(failure, 0)
    return None if not total else events.get(failure, 0) / total


def build_weekly_report(data):
    coverage, current, previous = data["coverage"], data["current"], data["previous"]
    events = data.get("events", {})
    lines = [
        f"# GA4 weekly report: {coverage['start']} to {coverage['end']}",
        f"Data fresh through: {coverage['fresh_through']}", "", "## Headline",
        f"- Sessions: {current['sessions']} ({_pct(current['sessions'], previous['sessions'])})",
        f"- Users: {current['users']} ({_pct(current['users'], previous['users'])})",
        f"- Views: {current['views']} ({_pct(current['views'], previous['views'])})",
        f"- Engaged sessions: {current['engaged_sessions']} ({_pct(current['engaged_sessions'], previous['engaged_sessions'])})",
        "", "## Acquisition",
        f"- Channels: {_list(data.get('channels', []))}",
        f"- Source / medium: {_list(data.get('sources', []))}",
        "", "## Audience and landing pages",
        f"- Landing pages: {_page_list(data.get('pages', []))}",
        f"- Countries: {_list(data.get('countries', []))}",
        f"- Regions: {_list(data.get('regions', []))}",
        f"- Devices: {_list(data.get('devices', []))}",
        "", "## Product events",
    ]
    lines.extend(f"- {name}: {events[name]}" for name in sorted(events))
    if not events:
        lines.append("- No product events recorded yet.")
    search_outcomes = events.get("location_search_success", 0) + events.get("location_search_no_match", 0)
    if search_outcomes:
        lines.append(f"- Search no-match rate: {events.get('location_search_no_match', 0) / search_outcomes:.1%}")
    for label, success, failure in (
        ("Current-location failure rate", "current_location_success", "current_location_failure"),
        ("Weather-load failure rate", "weather_load_success", "weather_load_failure"),
        ("Forecast-load failure rate", "forecast_view", "forecast_load_failure"),
    ):
        rate = _failure_rate(events, success, failure)
        if rate is not None:
            lines.append(f"- {label}: {rate:.1%}")
    warnings = list(data.get("warnings", []))
    if data.get("repeat_heavy_pages"):
        warnings.append("repeat-heavy pages: " + ", ".join(data["repeat_heavy_pages"][:3]))
    if data.get("not_set_sessions"):
        warnings.append(f"(not set) source sessions: {data['not_set_sessions']}")
    if data.get("not_set_landing_sessions"):
        warnings.append(f"(not set) landing-page sessions: {data['not_set_landing_sessions']}")
    if data.get("non_production_hosts"):
        warnings.append("non-production host rows observed: " + ", ".join(data["non_production_hosts"][:3]))
    if warnings:
        lines += ["", "## Watch", *[f"- {item}" for item in warnings[:5]]]
    return {"markdown": "\n".join(lines) + "\n", "data": data}


def write_report_artifacts(report, output_root, report_date):
    output_root = pathlib.Path(output_root)
    output_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    result = {}
    contents = {
        "markdown": report["markdown"],
        "json": json.dumps(report["data"], sort_keys=True, indent=2) + "\n",
    }
    for key, content in contents.items():
        target = output_root / f"{report_date}-weekly.{ 'md' if key == 'markdown' else 'json'}"
        with tempfile.NamedTemporaryFile("w", dir=output_root, delete=False, encoding="utf-8") as handle:
            handle.write(content)
            temporary = pathlib.Path(handle.name)
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
        os.chmod(target, 0o600)
        result[key] = target
    return result


def _period_data(client, start, end):
    bundle = report_bundle(client, start.isoformat(), end.isoformat())
    headline = bundle.pop("headline")
    return {
        "sessions": headline["sessions"], "users": headline["totalUsers"],
        "views": headline["screenPageViews"], "engaged_sessions": headline["engagedSessions"], **bundle,
    }


def collect_weekly_data(client, as_of):
    start, end = complete_week(as_of)
    prior_start, prior_end = start - timedelta(days=7), end - timedelta(days=7)
    current = _period_data(client, start, end)
    previous = _period_data(client, prior_start, prior_end)
    sources = current.get("sources", [])
    hostname_rows = current.pop("hostnames", [])
    non_production = [row.get("hostName", "(not set)") for row in hostname_rows
                      if row.get("hostName") != os.getenv("GA4_PRODUCTION_HOST", "www.wetbulb35.com")]
    return {
        "coverage": {"start": start.isoformat(), "end": end.isoformat(), "fresh_through": end.isoformat()},
        "current": {key: current[key] for key in ("sessions", "users", "views", "engaged_sessions")},
        "previous": {key: previous[key] for key in ("sessions", "users", "views", "engaged_sessions")},
        **{key: current.get(key, []) for key in ("channels", "sources", "pages", "countries", "regions", "cities", "devices")},
        "events": current.get("events", {}), "repeat_heavy_pages": current.get("repeat_heavy_pages", []),
        "not_set_sessions": next((row["sessions"] for row in sources if row["name"] == "(not set)"), 0),
        "not_set_landing_sessions": current.get("not_set_landing_sessions", 0),
        "non_production_hosts": sorted(set(non_production)),
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", default=date.today().isoformat())
    parser.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT))
    args = parser.parse_args(argv)
    as_of = date.fromisoformat(args.as_of)
    report = build_weekly_report(collect_weekly_data(ga4_client(), as_of))
    write_report_artifacts(report, args.output_root, as_of.isoformat())
    print(report["markdown"], end="")


if __name__ == "__main__":
    main()
