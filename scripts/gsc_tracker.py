#!/usr/bin/env python3
"""Credential-safe, read-only Google Search Console cohort tracker."""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
from typing import Any, Callable


MAX_INSPECTIONS_PER_RUN = 400
MAX_INSPECTIONS_PER_DAY = 2000
MAX_INSPECTIONS_PER_MINUTE = 600
MAX_ATTEMPTS = 3
MIN_REQUEST_INTERVAL_SECONDS = 0.11
READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
DEFAULT_BASE_URL = "https://www.wetbulb35.com"
SCHEMA_VERSION = 2


class QuotaError(RuntimeError):
    pass


class ApiError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def validate_path(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value.startswith("/")
        or not value.endswith("/")
        or "://" in value
        or ".." in value
        or any(character in value for character in "\r\n\t?#")
    ):
        raise ValueError(f"invalid canonical path: {value!r}")
    return value


def validate_site_url(value: str) -> str:
    if value in {"sc-domain:wetbulb35.com", "https://www.wetbulb35.com/"}:
        return value
    raise ValueError("GSC_SITE_URL must cover the canonical cohort: sc-domain:wetbulb35.com or https://www.wetbulb35.com/")


def private_output_path(value: Path) -> Path:
    private_root = (Path.cwd() / ".private").resolve()
    resolved = value.resolve()
    if resolved != private_root and private_root not in resolved.parents:
        raise ValueError("GSC database and CSV outputs must stay under .private/")
    return resolved


def load_controls(path: Path) -> list[str]:
    data = json.loads(path.read_text())
    controls = data.get("controls")
    if (
        set(data) != {"schemaVersion", "selection", "controls"}
        or data.get("schemaVersion") != 1
        or data.get("selection") != "sha256(route) ascending outside tier1 top-200"
        or not isinstance(controls, list)
        or len(controls) != 200
    ):
        raise ValueError("invalid deterministic control manifest")
    controls = [validate_path(item) for item in controls]
    if len(set(controls)) != len(controls):
        raise ValueError("control manifest contains duplicate paths")
    return controls


def tags_for_city(city: dict[str, Any]) -> list[str]:
    rank = city["rank"]
    tags = ["top-200"]
    if rank <= 100:
        tags.append("top-100")
    if rank <= 50:
        tags.append("top-50")
    if city.get("popular") is True:
        tags.append("popular-40")
    return tags


def build_cohort(
    tier_manifest: Path,
    controls_manifest: Path,
    base_url: str = DEFAULT_BASE_URL,
) -> list[dict[str, Any]]:
    if base_url != DEFAULT_BASE_URL:
        raise ValueError(f"base URL must be {DEFAULT_BASE_URL}")
    manifest = json.loads(tier_manifest.read_text())
    cities = manifest.get("cities", [])
    ranked = sorted(cities, key=lambda city: city.get("rank", 0))
    if manifest.get("schemaVersion") != 1 or [city.get("rank") for city in ranked] != list(range(1, 201)):
        raise ValueError("tier manifest must have schemaVersion 1 and unique ranks 1 through 200")
    if sum(city.get("popular") is True for city in ranked) != 40:
        raise ValueError("tier manifest must have exactly 40 popular cities")

    cohort: list[dict[str, Any]] = []
    tier_paths: set[str] = set()
    for city in ranked:
        path = validate_path(city["path"])
        if path in tier_paths:
            raise ValueError("tier manifest contains duplicate paths")
        tier_paths.add(path)
        cohort.append(
            {
                "url": f"{base_url}{path}",
                "rank": city["rank"],
                "tags": tags_for_city(city),
            }
        )

    controls = load_controls(controls_manifest)
    if tier_paths.intersection(controls):
        raise ValueError("control paths overlap the Top 200")
    cohort.extend({"url": f"{base_url}{path}", "rank": None, "tags": ["control"]} for path in controls)
    if len(cohort) != 400 or len({item["url"] for item in cohort}) != 400:
        raise ValueError("cohort must contain exactly 400 unique URLs")
    return cohort


class Store:
    def __init__(self, path: Path):
        self.path = path

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def migrate(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.path.parent, 0o700)
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)")
            if not db.execute("SELECT 1 FROM schema_migrations WHERE version=1").fetchone():
                db.execute(
                    """CREATE TABLE snapshots (
                    snapshot_at TEXT NOT NULL, url TEXT NOT NULL, cohort TEXT NOT NULL,
                    inspection_status TEXT, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL,
                    PRIMARY KEY (snapshot_at, url))"""
                )
                db.execute(
                    "CREATE TABLE request_reservations (requested_at TEXT NOT NULL, request_count INTEGER NOT NULL CHECK(request_count > 0))"
                )
                db.execute("INSERT INTO schema_migrations(version) VALUES (1)")
            if not db.execute("SELECT 1 FROM schema_migrations WHERE version=2").fetchone():
                additions = [
                    ("cohort_tags", "TEXT NOT NULL DEFAULT '[]'"),
                    ("rank", "INTEGER"),
                    ("coverage_state", "TEXT"),
                    ("last_crawl_time", "TEXT"),
                    ("google_canonical", "TEXT"),
                    ("user_canonical", "TEXT"),
                    ("page_fetch_state", "TEXT"),
                    ("indexing_state", "TEXT"),
                    ("robots_txt_state", "TEXT"),
                    ("crawled_as", "TEXT"),
                    ("sitemaps", "TEXT NOT NULL DEFAULT '[]'"),
                    ("referring_urls", "TEXT NOT NULL DEFAULT '[]'"),
                    ("analytics_start", "TEXT"),
                    ("analytics_end", "TEXT"),
                ]
                existing = {row[1] for row in db.execute("PRAGMA table_info(snapshots)")}
                for column, definition in additions:
                    if column not in existing:
                        db.execute(f"ALTER TABLE snapshots ADD COLUMN {column} {definition}")
                db.execute("UPDATE snapshots SET cohort_tags=json_array(cohort) WHERE cohort_tags='[]'")
                db.execute("INSERT INTO schema_migrations(version) VALUES (2)")
            if not db.execute("SELECT 1 FROM schema_migrations WHERE version=3").fetchone():
                db.execute("CREATE TABLE IF NOT EXISTS request_attempts (requested_at TEXT NOT NULL)")
                db.execute("INSERT INTO schema_migrations(version) VALUES (3)")
        os.chmod(self.path, 0o600)

    def quota_usage(self, now: datetime) -> tuple[int, int]:
        if now.tzinfo is None:
            raise ValueError("quota timestamps must be timezone-aware")
        day = now.astimezone(timezone.utc).date().isoformat()
        minute_start = (now.astimezone(timezone.utc) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
        with self.connect() as db:
            daily = db.execute(
                "SELECT COALESCE(SUM(request_count),0) FROM request_reservations WHERE substr(requested_at,1,10)=?",
                (day,),
            ).fetchone()[0]
            recent = db.execute(
                "SELECT COUNT(*) FROM request_attempts WHERE requested_at>=?",
                (minute_start,),
            ).fetchone()[0]
        return int(daily), int(recent)

    def reserve_plan(self, planned_inspections: int, now: datetime) -> None:
        if planned_inspections < 1 or planned_inspections > MAX_INSPECTIONS_PER_RUN:
            raise QuotaError("refusing more than 400 URL inspections")
        worst_case = planned_inspections * MAX_ATTEMPTS
        stamp = now.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            daily = db.execute(
                "SELECT COALESCE(SUM(request_count),0) FROM request_reservations WHERE substr(requested_at,1,10)=?",
                (stamp[:10],),
            ).fetchone()[0]
            minute_start = (now.astimezone(timezone.utc) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
            recent = db.execute(
                "SELECT COUNT(*) FROM request_attempts WHERE requested_at>=?",
                (minute_start,),
            ).fetchone()[0]
            if daily + worst_case > MAX_INSPECTIONS_PER_DAY:
                raise QuotaError("refusing before requests: daily URL Inspection quota cannot cover bounded retries")
            if recent + planned_inspections > MAX_INSPECTIONS_PER_MINUTE:
                raise QuotaError("refusing before requests: per-minute URL Inspection quota lacks initial capacity")
            db.execute("INSERT INTO request_reservations VALUES (?,?)", (stamp, worst_case))

    def reserve_inspection(self, now: datetime) -> None:
        stamp = now.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            minute_start = (now.astimezone(timezone.utc) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
            recent = db.execute(
                "SELECT COUNT(*) FROM request_attempts WHERE requested_at>=?",
                (minute_start,),
            ).fetchone()[0]
            if recent >= MAX_INSPECTIONS_PER_MINUTE:
                raise QuotaError("per-minute URL Inspection quota exhausted")
            db.execute("INSERT INTO request_attempts VALUES (?)", (stamp,))

    def save_snapshot(
        self,
        snapshot_at: str,
        item: dict[str, Any],
        inspection: dict[str, Any],
        metrics: dict[str, Any],
        analytics_start: str,
        analytics_end: str,
    ) -> None:
        tags = json.dumps(item["tags"], separators=(",", ":"))
        cohort = "control" if item["tags"] == ["control"] else "tier1"
        values = (
            snapshot_at,
            item["url"],
            cohort,
            inspection.get("verdict"),
            metrics.get("clicks"),
            metrics.get("impressions"),
            metrics.get("ctr"),
            metrics.get("position"),
            tags,
            item["rank"],
            inspection.get("coverageState"),
            inspection.get("lastCrawlTime"),
            inspection.get("googleCanonical"),
            inspection.get("userCanonical"),
            inspection.get("pageFetchState"),
            inspection.get("indexingState"),
            inspection.get("robotsTxtState"),
            inspection.get("crawledAs"),
            json.dumps(inspection.get("sitemap", []), separators=(",", ":")),
            json.dumps(inspection.get("referringUrls", []), separators=(",", ":")),
            analytics_start,
            analytics_end,
        )
        with self.connect() as db:
            db.execute(
                """INSERT INTO snapshots (
                    snapshot_at,url,cohort,inspection_status,clicks,impressions,ctr,position,
                    cohort_tags,rank,coverage_state,last_crawl_time,google_canonical,user_canonical,
                    page_fetch_state,indexing_state,robots_txt_state,crawled_as,sitemaps,referring_urls,
                    analytics_start,analytics_end
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(snapshot_at,url) DO UPDATE SET
                    cohort=excluded.cohort,inspection_status=excluded.inspection_status,
                    clicks=excluded.clicks,impressions=excluded.impressions,ctr=excluded.ctr,position=excluded.position,
                    cohort_tags=excluded.cohort_tags,rank=excluded.rank,coverage_state=excluded.coverage_state,
                    last_crawl_time=excluded.last_crawl_time,google_canonical=excluded.google_canonical,
                    user_canonical=excluded.user_canonical,page_fetch_state=excluded.page_fetch_state,
                    indexing_state=excluded.indexing_state,robots_txt_state=excluded.robots_txt_state,
                    crawled_as=excluded.crawled_as,sitemaps=excluded.sitemaps,referring_urls=excluded.referring_urls,
                    analytics_start=excluded.analytics_start,analytics_end=excluded.analytics_end""",
                values,
            )

    def rows(self) -> list[sqlite3.Row]:
        with self.connect() as db:
            return db.execute(
                """SELECT snapshot_at,url,cohort_tags,rank,inspection_status,coverage_state,last_crawl_time,
                google_canonical,user_canonical,page_fetch_state,indexing_state,robots_txt_state,crawled_as,
                sitemaps,referring_urls,analytics_start,analytics_end,clicks,impressions,ctr,position
                FROM snapshots ORDER BY snapshot_at,url"""
            ).fetchall()


def export_csv(rows: list[sqlite3.Row], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output.parent, 0o700)
    fields = list(rows[0].keys()) if rows else [
        "snapshot_at", "url", "cohort_tags", "rank", "inspection_status", "coverage_state",
        "last_crawl_time", "google_canonical", "user_canonical", "page_fetch_state", "indexing_state",
        "robots_txt_state", "crawled_as", "sitemaps", "referring_urls", "analytics_start",
        "analytics_end", "clicks", "impressions", "ctr", "position",
    ]
    with output.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fields)
        writer.writeheader()
        writer.writerows(dict(row) for row in rows)
    os.chmod(output, 0o600)


def with_fixed_retries(operation: Callable[[], Any], attempts: int = MAX_ATTEMPTS) -> Any:
    for attempt in range(attempts):
        try:
            return operation()
        except ApiError as error:
            if error.status not in (429, 500, 502, 503, 504) or attempt == attempts - 1:
                raise
            time.sleep(2**attempt)
    raise AssertionError("unreachable")


def create_google_service(service_account_json: str):
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError as error:
        raise RuntimeError("install requirements-gsc.txt before running with credentials") from error
    try:
        info = json.loads(service_account_json)
    except json.JSONDecodeError as error:
        raise RuntimeError("GSC_SERVICE_ACCOUNT_JSON is not valid JSON") from error
    if info.get("type") != "service_account":
        raise RuntimeError("GSC_SERVICE_ACCOUNT_JSON is not a service-account credential")
    credentials = service_account.Credentials.from_service_account_info(info, scopes=[READONLY_SCOPE])
    return build("searchconsole", "v1", credentials=credentials, cache_discovery=False)


def _call(call: Callable[[], Any]) -> Any:
    def normalized() -> Any:
        try:
            return call()
        except ApiError:
            raise
        except Exception as error:
            status = getattr(getattr(error, "resp", None), "status", None)
            if status is not None:
                raise ApiError(int(status), "Google Search Console request failed") from error
            raise RuntimeError("Google Search Console request failed") from error

    return with_fixed_retries(normalized)


def collect(
    service: Any,
    site_url: str,
    cohort: list[dict[str, Any]],
    snapshot_at: str,
    store: Store,
    analytics_days: int = 28,
    analytics_lag_days: int = 3,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    site_url = validate_site_url(site_url)
    started = now()
    # Reserve the entire bounded retry plan transactionally before any Google request.
    # Reservations remain after partial or failed runs, preventing concurrent overuse.
    store.reserve_plan(len(cohort), started)
    analytics_end_date = started.date() - timedelta(days=analytics_lag_days)
    analytics_start_date = analytics_end_date - timedelta(days=analytics_days - 1)
    analytics_start = analytics_start_date.isoformat()
    analytics_end = analytics_end_date.isoformat()
    analytics = _call(
        lambda: service.searchanalytics().query(
            siteUrl=site_url,
            body={
                "startDate": analytics_start,
                "endDate": analytics_end,
                "dataState": "final",
                "dimensions": ["page"],
                "rowLimit": 25000,
            },
        ).execute()
    )
    metrics = {
        row.get("keys", [None])[0]: {key: row.get(key) for key in ("clicks", "impressions", "ctr", "position")}
        for row in analytics.get("rows", [])
        if row.get("keys")
    }

    last_attempt_at: datetime | None = None
    for item in cohort:
        def inspect() -> Any:
            nonlocal last_attempt_at
            current = now()
            if last_attempt_at is not None:
                elapsed = (current - last_attempt_at).total_seconds()
                if elapsed < MIN_REQUEST_INTERVAL_SECONDS:
                    sleep(MIN_REQUEST_INTERVAL_SECONDS - elapsed)
                    current = now()
            store.reserve_inspection(current)
            last_attempt_at = current
            return service.urlInspection().index().inspect(
                body={"inspectionUrl": item["url"], "siteUrl": site_url, "languageCode": "en-US"}
            ).execute()

        result = _call(inspect)
        inspection = result.get("inspectionResult", {}).get("indexStatusResult", {})
        store.save_snapshot(
            snapshot_at,
            item,
            inspection,
            metrics.get(item["url"], {}),
            analytics_start,
            analytics_end,
        )


def run(argv: list[str] | None = None, environ: dict[str, str] | None = None) -> dict[str, Any]:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier-manifest", type=Path, default=Path("scripts/tier1-city-manifest.json"))
    parser.add_argument("--controls-manifest", type=Path, default=Path("scripts/gsc-control-manifest.json"))
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--database", type=Path, default=Path(".private/gsc-history.sqlite3"))
    parser.add_argument("--csv", type=Path)
    parser.add_argument("--analytics-days", type=int, default=28)
    parser.add_argument("--analytics-lag-days", type=int, default=3)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--smoke-test", action="store_true")
    args = parser.parse_args(argv)
    env = os.environ if environ is None else environ
    if not 1 <= args.analytics_days <= 90 or not 0 <= args.analytics_lag_days <= 10:
        raise ValueError("invalid Search Analytics date window")
    cohort = build_cohort(args.tier_manifest, args.controls_manifest, args.base_url)
    if args.dry_run:
        return {"cohort_size": len(cohort), "network": False}

    secret = env.get("GSC_SERVICE_ACCOUNT_JSON")
    site_url = validate_site_url(env.get("GSC_SITE_URL", ""))
    if not secret:
        raise RuntimeError("GSC_SERVICE_ACCOUNT_JSON is required outside dry-run")
    service = create_google_service(secret)
    if args.smoke_test:
        permission = _call(lambda: service.sites().get(siteUrl=site_url).execute()).get("permissionLevel")
        if permission not in {"siteFullUser", "siteOwner"}:
            raise RuntimeError("configured service account lacks Full User Search Console access")
        _call(
            lambda: service.urlInspection().index().inspect(
                body={"inspectionUrl": f"{DEFAULT_BASE_URL}/", "siteUrl": site_url, "languageCode": "en-US"}
            ).execute()
        )
        return {"smoke_test": "passed"}

    args.database = private_output_path(args.database)
    if args.csv:
        args.csv = private_output_path(args.csv)
    store = Store(args.database)
    store.migrate()
    snapshot_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    collect(service, site_url, cohort, snapshot_at, store, args.analytics_days, args.analytics_lag_days)
    if args.csv:
        export_csv(store.rows(), args.csv)
    return {"cohort_size": len(cohort), "database": str(args.database)}


if __name__ == "__main__":
    try:
        result = run()
        print("GSC dry run passed." if result.get("network") is False else "GSC operation completed.")
    except Exception as error:
        print(f"GSC tracker failed: {error}", file=sys.stderr)
        raise SystemExit(1)
