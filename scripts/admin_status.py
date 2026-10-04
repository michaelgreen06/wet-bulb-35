"""Read-only collectors for the private admin dashboard (issue #53).

Each collector produces one sanitized panel document matching lib/admin/status-contract.mjs.
Documents contain aggregates, fixed reason codes and canonical paths only: never credentials,
raw Google/provider payloads, search queries, visitor-level rows or provider error text.
"""
from __future__ import annotations

import json
import os
import pathlib
import socket
import sqlite3
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

SCRIPTS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

SCHEMA_VERSION = 1
HOST_PANELS = ("site", "top50", "search", "ga4")  # "budgets" is collected by the admin Worker cron.
REASON_CODES = frozenset((
    "credential_not_configured", "permission_denied", "quota_limited", "upstream_unavailable",
    "timeout", "invalid_response", "not_published", "not_configured", "exception",
))
DEFAULT_ORIGIN = "https://www.wetbulb35.com"
DEFAULT_OUTPUT_DIR = pathlib.Path("/home/laclaw/.local/share/wetbulb35-admin/panels")
DEFAULT_GA4_STATE = pathlib.Path("/home/laclaw/.local/share/wetbulb35-ga4/state/spike-alert.sqlite3")
DEFAULT_GA4_REPORTS = pathlib.Path("/home/laclaw/.local/share/wetbulb35-ga4/reports")
DEFAULT_GITHUB_REPO = "michaelgreen06/wet-bulb-35"
DEFAULT_TOP50_WORKFLOW = "global-inhabited-hotspots.yml"
USER_AGENT = "WetBulb35-AdminHealth/1.0 (private synthetic monitor bot)"
GSC_SAMPLE_SIZE = 10
MAX_BODY_BYTES = 2_000_000

# Provider-free, read-only snapshot routes from PR #29.
TOP50_SOURCES = {"inhabited": "/api/inhabited-hotspots", "unfiltered": "/api/global-grid-hotspots"}
# Integration seam for issue #50: the first present path wins. Add #50's final run/readiness
# field locations here; missing fields are reported as unknown rather than inferred.
TOP50_FIELD_PATHS = {
    "schemaVersion": ("schemaVersion",),
    "initialization": ("initialization", "run.initialization", "source.initialization", "discovery.initialization"),
    "retrievedAt": ("retrievedAt", "run.retrievedAt", "source.retrievedAt", "discovery.retrievedAt"),
    "generatedAt": ("generatedAt",),
    "validFrom": ("validFrom",),
    "validTo": ("validTo",),
    "published": ("counts.published",),
    "refined": ("counts.refined",),
}


class CollectorError(Exception):
    """Carries only a fixed reason code."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason if reason in REASON_CODES else "exception"


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_iso_or_none(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return iso(parsed)


def _status_code(error: BaseException) -> int | None:
    for candidate in (getattr(error, "status", None), getattr(error, "code", None),
                      getattr(getattr(error, "resp", None), "status", None)):
        try:
            if candidate is not None and 100 <= int(candidate) <= 599:
                return int(candidate)
        except (TypeError, ValueError):
            continue
    return None


def reason_for(error: BaseException) -> str:
    """Maps any failure to a fixed reason code; the exception text is discarded."""
    if isinstance(error, CollectorError):
        return error.reason
    name = type(error).__name__
    if isinstance(error, (TimeoutError, socket.timeout)) or name in {"DeadlineExceeded", "Timeout"}:
        return "timeout"
    if name in {"DefaultCredentialsError", "RefreshError"}:
        return "credential_not_configured"
    if name in {"PermissionDenied", "Unauthenticated", "Forbidden", "Unauthorized"}:
        return "permission_denied"
    if name in {"ResourceExhausted", "TooManyRequests"}:
        return "quota_limited"
    status = _status_code(error)
    if status in (401, 403):
        return "permission_denied"
    if status == 429:
        return "quota_limited"
    if status is not None and status >= 500 or name in {"ServiceUnavailable", "InternalServerError"}:
        return "upstream_unavailable"
    if isinstance(error, urllib.error.URLError) and not isinstance(error, urllib.error.HTTPError):
        return "upstream_unavailable"
    if isinstance(error, (ValueError, KeyError, TypeError)):
        return "invalid_response"
    if isinstance(error, ImportError):
        return "not_configured"
    return "exception"


def http_get(url: str, timeout: float = 15.0, opener: Callable[..., Any] = urllib.request.urlopen,
             headers: dict[str, str] | None = None) -> tuple[int, str, bytes, int]:
    """GET with a bounded body. HTTP error statuses are returned, not raised."""
    request = urllib.request.Request(url, headers={"user-agent": USER_AGENT, **(headers or {})})
    started = time.monotonic()
    try:
        response = opener(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        return error.code, "", b"", int((time.monotonic() - started) * 1000)
    with response:
        body = response.read(MAX_BODY_BYTES + 1)
        if len(body) > MAX_BODY_BYTES:
            raise CollectorError("invalid_response")
        content_type = response.headers.get("content-type", "") if getattr(response, "headers", None) else ""
        return response.status, content_type, body, int((time.monotonic() - started) * 1000)


def representative_city_path(manifest: pathlib.Path = SCRIPTS / "tier1-city-manifest.json") -> str:
    cities = json.loads(manifest.read_text())["cities"]
    return min(cities, key=lambda city: city["rank"])["path"]


# ---------------------------------------------------------------- site health

def _check(check_id: str, path: str, origin: str, fetch, now: datetime, validate) -> dict[str, Any]:
    result = {"id": check_id, "path": path, "outcome": "exception", "httpStatus": None, "latencyMs": None, "checkedAt": iso(now)}
    try:
        status, content_type, body, latency = fetch(origin + path)
        result.update(httpStatus=status, latencyMs=latency)
        result["outcome"] = validate(status, content_type, body)
    except Exception as error:  # noqa: BLE001 - reduced to a fixed outcome
        result["outcome"] = "timeout" if reason_for(error) == "timeout" else "exception"
    return result


def _html_validator(path: str, origin: str):
    canonical = f'<link rel="canonical" href="{origin}{path}"'.encode()

    def validate(status, content_type, body):
        if status != 200:
            return "http_error"
        return "ok" if "text/html" in content_type and canonical in body else "content_mismatch"
    return validate


def _snapshot_validator(status, content_type, body):
    if status == 404:
        return "not_published"
    if status != 200:
        return "http_error"
    try:
        return "ok" if isinstance(json.loads(body).get("validTo"), str) else "content_mismatch"
    except (ValueError, AttributeError):
        return "content_mismatch"


def collect_site(origin: str = DEFAULT_ORIGIN, fetch=http_get, now: datetime | None = None,
                 city_path: str | None = None) -> tuple[str, dict[str, Any]]:
    """Provider-free checks: no route here can trigger a weather or forecast provider call."""
    now = now or datetime.now(timezone.utc)
    city_path = city_path or representative_city_path()
    checks = [
        _check("homepage", "/", origin, fetch, now, _html_validator("/", origin)),
        _check("city", city_path, origin, fetch, now, _html_validator(city_path, origin)),
        _check("snapshot", TOP50_SOURCES["inhabited"], origin, fetch, now, _snapshot_validator),
    ]
    outcomes = {check["id"]: check["outcome"] for check in checks}
    if outcomes["homepage"] != "ok" or all(outcome not in ("ok", "not_published") for outcome in outcomes.values()):
        status = "down"
    elif any(outcome not in ("ok", "not_published") for outcome in outcomes.values()):
        status = "degraded"
    else:
        status = "ok"
    return status, {"checks": checks}


# ---------------------------------------------------------------- Top-50

def _lookup(payload: Any, dotted: str) -> Any:
    value = payload
    for part in dotted.split("."):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def extract_snapshot_meta(payload: Any) -> tuple[dict[str, Any], int | None]:
    """Keeps only run/validity metadata; rankings, places and values are discarded."""
    if not isinstance(payload, dict):
        return {"availability": "invalid"}, None

    def first(field):
        return next((value for value in (_lookup(payload, path) for path in TOP50_FIELD_PATHS[field]) if value is not None), None)

    def count(value):
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None

    meta = {
        "availability": "published",
        "schemaVersion": count(first("schemaVersion")),
        **{field: utc_iso_or_none(first(field)) for field in ("initialization", "retrievedAt", "generatedAt", "validFrom", "validTo")},
        "published": count(first("published")) if first("published") is not None else
        (len(payload["hotspots"]) if isinstance(payload.get("hotspots"), list) else None),
    }
    if not meta["validFrom"] or not meta["validTo"] or meta["validFrom"] >= meta["validTo"]:
        meta["availability"] = "invalid"
    return meta, count(first("refined"))


def classify_snapshot(meta: dict[str, Any], now: datetime, max_init_age_hours: float) -> str:
    """Python mirror of classifyTop50Snapshot, used only for collector alerts."""
    if meta.get("availability") != "published":
        return meta.get("availability", "unavailable")
    valid_from = datetime.fromisoformat(meta["validFrom"].replace("Z", "+00:00"))
    valid_to = datetime.fromisoformat(meta["validTo"].replace("Z", "+00:00"))
    if now >= valid_to:
        return "expired"
    if meta.get("initialization"):
        initialization = datetime.fromisoformat(meta["initialization"].replace("Z", "+00:00"))
        if now - initialization > timedelta(hours=max_init_age_hours):
            return "behind"
    return "upcoming" if now < valid_from else "in_window"


RUN_IN_PROGRESS = {"queued", "in_progress", "waiting", "requested", "pending"}


def _cycle(run: dict[str, Any]) -> dict[str, str] | None:
    at = utc_iso_or_none(run.get("created_at"))
    if not at:
        return None
    if run.get("status") in RUN_IN_PROGRESS:
        outcome = "in_progress"
    else:
        outcome = {"success": "success", "failure": "failure", "timed_out": "failure", "startup_failure": "failure",
                   "cancelled": "cancelled"}.get(run.get("conclusion"), "unknown")
    return {"at": at, "outcome": outcome}


def workflow_cycles(fetch, repo: str, workflow: str, token: str | None = None) -> tuple[dict | None, dict | None]:
    """Latest scheduled-cycle outcome and latest failed/retrying cycle from public run metadata."""
    url = f"https://api.github.com/repos/{repo}/actions/workflows/{workflow}/runs?per_page=20"
    headers = {"accept": "application/vnd.github+json", **({"authorization": f"Bearer {token}"} if token else {})}
    status, _, body, _ = fetch(url, headers=headers)
    if status == 404:
        return None, None
    if status != 200:
        raise CollectorError("upstream_unavailable")
    cycles = [cycle for cycle in (_cycle(run) for run in json.loads(body).get("workflow_runs", [])) if cycle]
    cycles.sort(key=lambda cycle: cycle["at"], reverse=True)
    latest_failure = next((cycle for cycle in cycles if cycle["outcome"] in ("failure", "in_progress")), None)
    return (cycles[0] if cycles else None), latest_failure


def collect_top50(origin: str = DEFAULT_ORIGIN, fetch=http_get, now: datetime | None = None,
                  environ: dict[str, str] | None = None) -> tuple[str, dict[str, Any]]:
    now = now or datetime.now(timezone.utc)
    environ = os.environ if environ is None else environ
    products, refined = {}, None
    for product, path in TOP50_SOURCES.items():
        status, _, body, _ = fetch(origin + path)
        if status == 404:
            products[product] = {"availability": "not_published"}
        elif status != 200:
            products[product] = {"availability": "unavailable"}
        else:
            try:
                meta, product_refined = extract_snapshot_meta(json.loads(body))
            except ValueError:
                meta, product_refined = {"availability": "invalid"}, None
            products[product] = meta
            refined = product_refined if product == "inhabited" else refined
    try:
        last_cycle, latest_failure = workflow_cycles(fetch, environ.get("ADMIN_GITHUB_REPO", DEFAULT_GITHUB_REPO),
                                                     environ.get("ADMIN_TOP50_WORKFLOW", DEFAULT_TOP50_WORKFLOW),
                                                     environ.get("ADMIN_GITHUB_READ_TOKEN"))
    except Exception:  # noqa: BLE001 - cycle history is supplementary
        last_cycle, latest_failure = None, None
    limit = environ.get("HOTSPOT_DAILY_LOCATION_LIMIT", "")
    max_age = float(environ.get("ADMIN_TOP50_MAX_INIT_AGE_HOURS") or 36)
    states = [classify_snapshot(meta, now, max_age) for meta in products.values()]
    if any(state in ("expired", "invalid") for state in states):
        status = "down"
    elif any(state in ("behind", "unavailable") for state in states) or (latest_failure and latest_failure["outcome"] == "failure"
                                                                      and (not last_cycle or last_cycle["outcome"] != "success")):
        status = "degraded"
    elif all(state == "not_published" for state in states):
        status = "unknown"
    else:
        status = "ok"
    return status, {
        "products": products,
        "scheduledBudget": {"used": refined, "limit": int(limit) if limit.isdigit() and int(limit) > 0 else None},
        "lastCycle": last_cycle,
        "latestFailure": latest_failure,
    }


# ---------------------------------------------------------------- Search Console

def gsc_sample_paths(size: int = GSC_SAMPLE_SIZE, manifest: pathlib.Path = SCRIPTS / "tier1-city-manifest.json") -> list[str]:
    """Stable sample: homepage plus the highest-ranked tier-1 city pages."""
    cities = sorted(json.loads(manifest.read_text())["cities"], key=lambda city: city["rank"])
    return ["/"] + [city["path"] for city in cities[: size - 1]]


def _window(by_date: dict[str, tuple[int, int]], end: date, days: int) -> dict[str, Any]:
    start = end - timedelta(days=days - 1)
    selected = [by_date.get((start + timedelta(days=offset)).isoformat(), (0, 0)) for offset in range(days)]
    return {"start": start.isoformat(), "end": end.isoformat(),
            "clicks": sum(item[0] for item in selected), "impressions": sum(item[1] for item in selected)}


def search_windows(rows: list[dict[str, Any]]) -> tuple[str | None, dict[str, Any] | None]:
    """Days absent from a final-data date report have no impressions and count as zero."""
    by_date = {}
    for row in rows:
        day = date.fromisoformat(row["keys"][0]).isoformat()
        by_date[day] = (int(row.get("clicks", 0)), int(row.get("impressions", 0)))
    if not by_date:
        return None, None
    through = date.fromisoformat(max(by_date))
    return through.isoformat(), {
        "last7": _window(by_date, through, 7),
        "prior7": _window(by_date, through - timedelta(days=7), 7),
        "last28": _window(by_date, through, 28),
        "prior28": _window(by_date, through - timedelta(days=28), 28),
    }


def collect_search(service, site_url: str, today: date, call: Callable[[Callable[[], Any]], Any],
                   origin: str = DEFAULT_ORIGIN, sample: list[str] | None = None) -> tuple[str, dict[str, Any]]:
    """Read-only Search Analytics (date dimension only, no queries) plus a bounded inspection sample."""
    sample = (sample or gsc_sample_paths())[:GSC_SAMPLE_SIZE]
    response = call(lambda: service.searchanalytics().query(siteUrl=site_url, body={
        "startDate": (today - timedelta(days=70)).isoformat(), "endDate": (today - timedelta(days=1)).isoformat(),
        "dimensions": ["date"], "dataState": "final", "rowLimit": 100,
    }).execute())
    data_through, windows = search_windows(response.get("rows", []))
    results = []
    for path in sample:
        item = {"path": path, "outcome": "failed", "verdict": None, "coverageState": None, "lastCrawlDate": None}
        try:
            result = call(lambda: service.urlInspection().index().inspect(body={
                "inspectionUrl": origin + path, "siteUrl": site_url, "languageCode": "en-US"}).execute())
            status = result.get("inspectionResult", {}).get("indexStatusResult", {})
            coverage = status.get("coverageState")
            crawl = utc_iso_or_none(status.get("lastCrawlTime"))
            item.update(outcome="ok", verdict=status.get("verdict"),
                        coverageState=coverage if isinstance(coverage, str) and len(coverage) <= 80 else None,
                        lastCrawlDate=crawl[:10] if crawl else None)
        except Exception as error:  # noqa: BLE001
            if reason_for(error) in ("permission_denied", "quota_limited"):
                raise
        results.append(item)
    inspected = sum(item["outcome"] == "ok" for item in results)
    if windows is None:
        status = "unknown"
    elif inspected < len(results) or any(item["verdict"] == "FAIL" for item in results):
        status = "degraded"
    else:
        status = "ok"
    return status, {"dataThrough": data_through, "windows": windows or {},
                    "sample": {"requested": len(sample), "inspected": inspected, "results": results}}


def gsc_from_environment(environ: dict[str, str]):
    import gsc_tracker

    raw = environ.get("GSC_SERVICE_ACCOUNT_JSON")
    path = environ.get("GSC_SERVICE_ACCOUNT_FILE")
    if not raw and path and pathlib.Path(path).is_file():
        raw = pathlib.Path(path).read_text()
    site_url = environ.get("GSC_SITE_URL", "")
    if not raw or not site_url:
        raise CollectorError("credential_not_configured")
    try:
        site_url = gsc_tracker.validate_site_url(site_url)
        service = gsc_tracker.create_google_service(raw)
    except (ValueError, RuntimeError) as error:
        raise CollectorError("not_configured") from error
    return service, site_url, gsc_tracker._call


# ---------------------------------------------------------------- GA4

def _latest_spike_evaluation(path: pathlib.Path) -> str | None:
    if not path.is_file():
        return None
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        row = db.execute("SELECT max(date) FROM evaluations").fetchone()
        return row[0] if row and isinstance(row[0], str) else None
    except sqlite3.Error:
        return None
    finally:
        db.close()


def _latest_weekly_report(root: pathlib.Path) -> str | None:
    if not root.is_dir():
        return None
    dates = []
    for item in root.glob("*-weekly.json"):
        try:
            dates.append(date.fromisoformat(item.name[:10]).isoformat())
        except ValueError:
            continue
    return max(dates) if dates else None


def collect_ga4(client, today: date, ga4_module=None, state_path: pathlib.Path = DEFAULT_GA4_STATE,
                reports_root: pathlib.Path = DEFAULT_GA4_REPORTS) -> tuple[str, dict[str, Any]]:
    """Aggregate session trend and product-event presence. GA4 processing can lag 24-48 h."""
    if ga4_module is None:
        import wetbulb_ga4 as ga4_module
    complete_through = today - timedelta(days=2)
    start, end = complete_through - timedelta(days=13), today - timedelta(days=1)
    raw = ga4_module.daily_sessions(client, start.isoformat(), end.isoformat())
    by_day = {datetime.strptime(key, "%Y%m%d").date(): int(value) for key, value in raw.items()}
    latest = max(by_day) if by_day else None
    daily = []
    day = end - timedelta(days=13)
    while day <= end and latest and day <= latest:
        daily.append({"date": day.isoformat(), "sessions": by_day.get(day, 0)})
        day += timedelta(days=1)

    def total(first: date, last: date) -> int:
        return sum(value for key, value in by_day.items() if first <= key <= last)

    last7_start = complete_through - timedelta(days=6)
    events = ga4_module.query_report(client, last7_start.isoformat(), complete_through.isoformat(),
                                     dimensions=("eventName",), metrics=("eventCount",))
    product_events = sum(int(float(row.get("eventCount", 0) or 0)) for row in events
                         if row.get("eventName") in ga4_module.PRODUCT_EVENTS)
    status = "ok" if latest and latest >= today - timedelta(days=3) else "degraded"
    return status, {
        "latestDataDate": latest.isoformat() if latest else None,
        "completeThrough": complete_through.isoformat(),
        "dailySessions": daily,
        "last7Sessions": total(last7_start, complete_through),
        "prior7Sessions": total(last7_start - timedelta(days=7), complete_through - timedelta(days=7)),
        "productEventsLast7": product_events,
        "spikeMonitor": {"lastEvaluatedDate": _latest_spike_evaluation(state_path)},
        "weeklyReport": {"lastReportDate": _latest_weekly_report(reports_root)},
    }


def ga4_from_environment(environ: dict[str, str]):
    path = environ.get("GOOGLE_APPLICATION_CREDENTIALS", "")
    if not path or not pathlib.Path(path).is_file():
        raise CollectorError("credential_not_configured")
    import wetbulb_ga4

    return wetbulb_ga4.ga4_client()


# ---------------------------------------------------------------- documents

def run_panel(panel: str, collect: Callable[[], tuple[str, dict[str, Any]]], previous: dict | None,
              now: datetime) -> dict[str, Any]:
    """On failure the previous successful result is preserved; the failed attempt marks it stale."""
    at = iso(now)
    try:
        status, data = collect()
        return {"schemaVersion": SCHEMA_VERSION, "panel": panel, "status": status, "reason": None,
                "collectedAt": at, "lastAttempt": {"at": at, "outcome": "success", "reason": None}, "data": data}
    except Exception as error:  # noqa: BLE001 - reduced to a fixed reason code
        reason = reason_for(error)
        attempt = {"at": at, "outcome": "failed", "reason": reason}
        if previous and previous.get("collectedAt"):
            return {**previous, "lastAttempt": attempt}
        return {"schemaVersion": SCHEMA_VERSION, "panel": panel,
                "status": "unavailable" if reason in ("upstream_unavailable", "timeout") else "unknown",
                "reason": reason, "collectedAt": None, "lastAttempt": attempt, "data": {}}


def alert_key(doc: dict | None) -> tuple:
    if not doc:
        return ()
    attempt = doc.get("lastAttempt") or {}
    return (doc.get("status"), attempt.get("outcome"), attempt.get("reason"))


def alert_line(doc: dict[str, Any], previous: dict | None) -> str | None:
    """Material, de-duplicated alert text; contains only panel ids, states and reason codes."""
    key = alert_key(doc)
    if key == alert_key(previous):
        return None
    status, outcome, reason = key
    if outcome == "failed":
        return f"WetBulb35 admin status: {doc['panel']} collector failed ({reason}); last result kept and labeled stale"
    if status in ("down", "degraded"):
        return f"WetBulb35 admin status: {doc['panel']} is {status}"
    if previous and alert_key(previous)[0] in ("down", "degraded") or (previous and alert_key(previous)[1] == "failed"):
        return f"WetBulb35 admin status: {doc['panel']} recovered ({status})"
    return None


def read_previous(output_dir: pathlib.Path, panel: str) -> dict | None:
    try:
        doc = json.loads((output_dir / f"{panel}.json").read_text())
        return doc if doc.get("schemaVersion") == SCHEMA_VERSION and doc.get("panel") == panel else None
    except (OSError, ValueError, AttributeError):
        return None


def write_private(output_dir: pathlib.Path, panel: str, doc: dict[str, Any]) -> pathlib.Path:
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = output_dir / f"{panel}.json"
    with tempfile.NamedTemporaryFile("w", dir=output_dir, delete=False, encoding="utf-8") as handle:
        json.dump(doc, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        temporary = pathlib.Path(handle.name)
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)
    return target


def publish_kv(docs: dict[str, dict], environ: dict[str, str], opener=urllib.request.urlopen) -> None:
    """Uploads sanitized panels to the approved private KV namespace. Gated on explicit configuration."""
    account = environ.get("ADMIN_STATUS_KV_ACCOUNT_ID", "")
    namespace = environ.get("ADMIN_STATUS_KV_NAMESPACE_ID", "")
    token = environ.get("ADMIN_STATUS_KV_API_TOKEN", "")
    if not (account and namespace and token):
        raise CollectorError("not_configured")
    for panel, doc in docs.items():
        url = (f"https://api.cloudflare.com/client/v4/accounts/{account}/storage/kv/namespaces/{namespace}"
               f"/values/status%2Fv1%2Fpanel%2F{panel}")
        request = urllib.request.Request(url, data=json.dumps(doc, separators=(",", ":")).encode(), method="PUT",
                                         headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
        with opener(request, timeout=15) as response:
            if response.status != 200:
                raise CollectorError("upstream_unavailable")
