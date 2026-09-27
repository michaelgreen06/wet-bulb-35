"""Privacy-safe, read-only GA4 reporting primitives."""
from __future__ import annotations
import json, os
from collections import defaultdict
from urllib.parse import urlsplit

PROPERTY_ID = os.getenv("GA4_PROPERTY_ID", "543514683")
PRODUCTION_HOST = "www.wetbulb35.com"

def normalize_path(value: str) -> str:
    path = urlsplit(str(value or "/")).path or "/"
    return path if path == "/" else path.rstrip("/") + "/"

def classify_page(path: str) -> str:
    parts = [p for p in normalize_path(path).split("/") if p]
    if not parts: return "homepage"
    if parts[0] != "wetbulb-temperature": return "other"
    return {1:"directory", 2:"country", 3:"region"}.get(len(parts), "city" if len(parts) >= 4 else "other")

def _number(row, key):
    try: return int(float(row.get(key, 0) or 0))
    except (TypeError, ValueError): return 0

def aggregate_pages(rows):
    pages, repeats = [], []
    for row in rows:
        if row.get("hostName") != PRODUCTION_HOST: continue
        item = {"path": normalize_path(row.get("pagePathPlusQueryString")), "sessions": _number(row,"sessions"), "users": _number(row,"totalUsers"), "engaged_sessions": _number(row,"engagedSessions")}
        item["page_type"] = classify_page(item["path"]); pages.append(item)
        if item["users"] and item["sessions"] / item["users"] >= 5: repeats.append(item["path"])
    pages.sort(key=lambda item: (-item["users"], item["path"]))
    return {"totals": {"sessions": sum(x["sessions"] for x in pages), "users": sum(x["users"] for x in pages), "engaged_sessions": sum(x["engaged_sessions"] for x in pages)}, "pages": pages, "anomalies": {"repeat_heavy_pages": repeats}}

def aggregate_dimension_rows(rows, dimension):
    values = defaultdict(int)
    for row in rows: values[str(row.get(dimension, "(not set)"))] += _number(row, "sessions")
    ordered = [{"name": key, "sessions": value} for key, value in sorted(values.items(), key=lambda item: (-item[1], item[0]))]
    return {"rows": ordered, "not_set_sessions": values["(not set)"]}

def stable_json(value): return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"

def ga4_client():
    from google.analytics.data_v1beta import BetaAnalyticsDataClient
    return BetaAnalyticsDataClient()
