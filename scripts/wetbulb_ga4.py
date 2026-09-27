"""Privacy-safe, read-only GA4 Data API reporting helpers.

This module persists no API responses. Callers receive normalized aggregate rows only.
"""
from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import date
from urllib.parse import urlsplit

PROPERTY_ID = os.getenv("GA4_PROPERTY_ID", "543514683")
PRODUCTION_HOST = os.getenv("GA4_PRODUCTION_HOST", "www.wetbulb35.com")
PAGE_SIZE = 10_000
HEADLINE_METRICS = ("sessions", "totalUsers", "screenPageViews", "engagedSessions")
PRODUCT_EVENTS = frozenset((
    "location_search_success", "location_search_no_match", "current_location_success",
    "current_location_failure", "weather_load_success", "weather_load_failure",
    "forecast_view", "forecast_load_failure", "map_view", "map_interaction",
    "hotspot_city_click",
))


def normalize_path(value: str) -> str:
    path = urlsplit(str(value or "/")).path or "/"
    return path if path == "/" else path.rstrip("/") + "/"


def classify_page(path: str) -> str:
    parts = [part for part in normalize_path(path).split("/") if part]
    if not parts:
        return "homepage"
    if parts[0] != "wetbulb-temperature":
        return "other"
    return {1: "directory", 2: "country", 3: "region"}.get(len(parts), "city" if len(parts) >= 4 else "other")


def _number(row, key):
    try:
        return int(float(row.get(key, 0) or 0))
    except (TypeError, ValueError):
        return 0


def production_rows(rows):
    """Filter normalized rows to the production hostname when it is present."""
    return [row for row in rows if row.get("hostName", PRODUCTION_HOST) == PRODUCTION_HOST]


def aggregate_pages(rows):
    by_path = defaultdict(lambda: {"sessions": 0, "users": 0, "engaged_sessions": 0})
    not_set_sessions = 0
    for row in production_rows(rows):
        raw_path = row.get("landingPagePlusQueryString") or row.get("pagePathPlusQueryString")
        if not raw_path or raw_path == "(not set)":
            not_set_sessions += _number(row, "sessions")
            continue
        path = normalize_path(raw_path)
        item = by_path[path]
        item["sessions"] += _number(row, "sessions")
        item["users"] += _number(row, "totalUsers")
        item["engaged_sessions"] += _number(row, "engagedSessions")
    pages, repeats = [], []
    for path, metrics in by_path.items():
        item = {"path": path, "page_type": classify_page(path), **metrics}
        pages.append(item)
        if item["users"] and item["sessions"] / item["users"] >= 5:
            repeats.append(path)
    pages.sort(key=lambda item: (-item["users"], -item["engaged_sessions"], item["path"]))
    return {
        "totals": {
            "sessions": sum(item["sessions"] for item in pages),
            "users": sum(item["users"] for item in pages),
            "engaged_sessions": sum(item["engaged_sessions"] for item in pages),
        },
        "pages": pages,
        "anomalies": {"repeat_heavy_pages": sorted(set(repeats)), "not_set_landing_sessions": not_set_sessions},
    }


def aggregate_dimension_rows(rows, dimension, metric="sessions"):
    values = defaultdict(int)
    for row in production_rows(rows):
        values[str(row.get(dimension, "(not set)"))] += _number(row, metric)
    ordered = [{"name": key, metric: value} for key, value in sorted(values.items(), key=lambda item: (-item[1], item[0]))]
    return {"rows": ordered, "not_set_sessions": values["(not set)"] if metric == "sessions" else 0}


def stable_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"


def ga4_client():
    from google.analytics.data_v1beta import BetaAnalyticsDataClient
    return BetaAnalyticsDataClient()


def _api_types():
    from google.analytics.data_v1beta import (DateRange, Dimension, Filter,
        FilterExpression, Metric, RunReportRequest)
    return DateRange, Dimension, Filter, FilterExpression, Metric, RunReportRequest


def _row_to_dict(row, dimensions, metrics):
    result = {}
    result.update({name: value.value for name, value in zip(dimensions, row.dimension_values)})
    result.update({name: value.value for name, value in zip(metrics, row.metric_values)})
    return result


def query_report(client, start_date, end_date, dimensions=(), metrics=HEADLINE_METRICS,
                 production_only=True, page_size=PAGE_SIZE):
    """Run a fully paginated Data API report and return only normalized scalar rows."""
    DateRange, Dimension, Filter, FilterExpression, Metric, RunReportRequest = _api_types()
    offset = 0
    rows = []
    while True:
        request_args = {
            "property": f"properties/{PROPERTY_ID}",
            "date_ranges": [DateRange(start_date=str(start_date), end_date=str(end_date))],
            "dimensions": [Dimension(name=name) for name in dimensions],
            "metrics": [Metric(name=name) for name in metrics],
            "limit": page_size,
            "offset": offset,
        }
        if production_only:
            request_args["dimension_filter"] = FilterExpression(filter=Filter(
                field_name="hostName", string_filter=Filter.StringFilter(
                    match_type=Filter.StringFilter.MatchType.EXACT, value=PRODUCTION_HOST)))
        response = client.run_report(RunReportRequest(**request_args))
        batch = [_row_to_dict(row, dimensions, metrics) for row in response.rows]
        rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += len(batch)
    return rows


def headline_totals(client, start_date, end_date):
    rows = query_report(client, start_date, end_date, metrics=HEADLINE_METRICS)
    return {metric: _number(rows[0], metric) if rows else 0 for metric in HEADLINE_METRICS}


def report_bundle(client, start_date, end_date):
    """Collect the standard private aggregate breakdowns for a period."""
    pages = aggregate_pages(query_report(client, start_date, end_date,
        dimensions=("hostName", "landingPagePlusQueryString")))
    dimensions = {
        "channels": ("sessionDefaultChannelGroup",),
        "sources": ("sessionSourceMedium",),
        "countries": ("country",),
        "regions": ("region",),
        "cities": ("city",),
        "devices": ("deviceCategory",),
    }
    result = {"headline": headline_totals(client, start_date, end_date), "pages": pages["pages"],
              "repeat_heavy_pages": pages["anomalies"]["repeat_heavy_pages"],
              "not_set_landing_sessions": pages["anomalies"]["not_set_landing_sessions"]}
    for key, names in dimensions.items():
        rows = query_report(client, start_date, end_date, dimensions=names)
        result[key] = aggregate_dimension_rows(rows, names[0])["rows"]
    event_rows = query_report(client, start_date, end_date, dimensions=("eventName",), metrics=("eventCount",))
    result["events"] = {row["eventName"]: _number(row, "eventCount") for row in event_rows
                        if row["eventName"] in PRODUCT_EVENTS}
    result["hostnames"] = query_report(client, start_date, end_date, dimensions=("hostName",), production_only=False)
    return result


def daily_sessions(client, start_date, end_date):
    rows = query_report(client, start_date, end_date, dimensions=("date",), metrics=("sessions",))
    return {row["date"]: _number(row, "sessions") for row in rows}


def iso_day(value):
    return value.isoformat() if isinstance(value, date) else str(value)
