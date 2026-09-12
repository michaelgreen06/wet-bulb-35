#!/usr/bin/env python3
"""Read-only, sanitized Cloudflare cutover-readiness capture.

Requires an already-installed repository Wrangler and WETBULB35_CLOUDFLARE_API_TOKEN.
Uses GET requests only. It never prints or stores provider payloads, credentials,
request URLs/query strings, IP addresses, or TLS metadata.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/phase1/evidence/cloudflare-cutover-readiness.json"
ZONE_NAME = "wetbulb35.com"
CONFIG = ROOT / "wrangler.weather-staging.toml"
WRANGLER = ROOT / "node_modules/.bin/wrangler"
TOKEN_NAME = "WETBULB35_CLOUDFLARE_API_TOKEN"


def fail(message: str) -> None:
    print(f"capture failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def api_get(token: str, path: str, query: dict[str, str] | None = None) -> tuple[int, object | None]:
    # The path is fixed in this program; do not log URLs or error bodies.
    url = "https://api.cloudflare.com/client/v4" + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, None
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        return 0, None


def result(payload: object | None) -> object:
    return payload.get("result") if isinstance(payload, dict) else None


def state(status: int) -> str:
    return "available" if 200 <= status < 300 else f"unavailable_http_{status}" if status else "unavailable_network_or_schema"


def run_wrangler(args: list[str]) -> tuple[str, object | None]:
    try:
        completed = subprocess.run([str(WRANGLER), *args], cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=90, check=False, env=os.environ.copy())
    except (OSError, subprocess.TimeoutExpired):
        return "unavailable", None
    if completed.returncode != 0:
        return f"unavailable_exit_{completed.returncode}", None
    try:
        return "available", json.loads(completed.stdout)
    except json.JSONDecodeError:
        return "unavailable_schema", None


def name_from_toml(path: pathlib.Path) -> str:
    match = re.search(r'^name\s*=\s*"([^"]+)"\s*$', path.read_text(), re.M)
    if not match:
        fail("staging Wrangler config has no name")
    return match.group(1)


def main() -> None:
    if not WRANGLER.is_file() or not os.access(WRANGLER, os.X_OK):
        fail("repository Wrangler is not installed; run npm ci outside this capture")
    token = os.environ.get(TOKEN_NAME)
    if not token:
        fail(f"{TOKEN_NAME} is not set")
    # Wrangler only recognizes CLOUDFLARE_API_TOKEN. Keep the protected source
    # name external to the command line and never serialize either value.
    os.environ["CLOUDFLARE_API_TOKEN"] = token
    script_name = name_from_toml(CONFIG)
    version = subprocess.run([str(WRANGLER), "--version"], cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False).stdout.strip()

    zone_status, zone_payload = api_get(token, "/zones", {"name": ZONE_NAME, "per_page": "1"})
    zones = result(zone_payload)
    zone = zones[0] if isinstance(zones, list) and zones else None
    if not isinstance(zone, dict) or not zone.get("id") or not isinstance(zone.get("account"), dict) or not zone["account"].get("id"):
        fail(f"zone lookup {state(zone_status)}")
    zone_id, account_id = zone["id"], zone["account"]["id"]

    routes_status, routes_payload = api_get(token, f"/zones/{zone_id}/workers/routes")
    routes = result(routes_payload)
    route_scripts = sorted({x.get("script") for x in routes if isinstance(x, dict) and x.get("script")}) if isinstance(routes, list) else []

    settings: dict[str, object] = {}
    for setting_id in ("security_header", "email_obfuscation", "browser_cache_ttl", "cache_level", "edge_cache_ttl"):
        status_code, payload = api_get(token, f"/zones/{zone_id}/settings/{setting_id}")
        entry = result(payload)
        settings[setting_id] = {
            "access": state(status_code),
            "value": entry.get("value") if isinstance(entry, dict) else None,
        }

    rulesets_status, rulesets_payload = api_get(token, f"/zones/{zone_id}/rulesets")
    rulesets = result(rulesets_payload)
    response_header_rulesets = []
    if isinstance(rulesets, list):
        for item in rulesets:
            if not isinstance(item, dict):
                continue
            phase = item.get("phase")
            if phase in {"http_response_headers_transform", "http_request_cache_settings", "http_request_late_transform"}:
                response_header_rulesets.append({"phase": phase, "enabled": item.get("enabled") is not False})

    policies_status, policies_payload = api_get(token, f"/accounts/{account_id}/alerting/v3/policies")
    policies = result(policies_payload)
    alert_types = sorted({x.get("alert_type") for x in policies if isinstance(x, dict) and x.get("alert_type")}) if isinstance(policies, list) else []
    types_status, types_payload = api_get(token, f"/accounts/{account_id}/alerting/v3/available_alerts")
    available_alerts = result(types_payload)
    available_alert_categories = sorted(available_alerts) if isinstance(available_alerts, dict) else []
    workers_observability_alert_types = sorted(
        item.get("type") for item in available_alerts.get("Workers Observability", [])
        if isinstance(item, dict) and isinstance(item.get("type"), str)
    ) if isinstance(available_alerts, dict) else []

    telemetry_status, _ = api_get(token, f"/accounts/{account_id}/workers/observability/queries")

    namespaces_status, namespaces_payload = api_get(token, f"/accounts/{account_id}/workers/durable_objects/namespaces")
    namespaces = result(namespaces_payload)
    custom_domains_status, custom_domains_payload = api_get(token, f"/accounts/{account_id}/workers/domains")
    custom_domains = result(custom_domains_payload)

    # `deployments list` is a retained-history inventory; it does not identify
    # the active traffic allocation. Read that separately from status, and copy
    # only the deployment ID plus version IDs and percentages from its payload.
    staging_status_access, staging_status = run_wrangler(["deployments", "status", "--config", str(CONFIG), "--json"])
    staging_deploy_status, staging_deploy = run_wrangler(["deployments", "list", "--config", str(CONFIG), "--json"])
    staging_secrets_status, staging_secrets = run_wrangler(["secret", "list", "--config", str(CONFIG), "--format", "json"])
    active_deployment_id: str | None = None
    active_versions: list[dict[str, str | int | float]] = []
    if isinstance(staging_status, dict):
        deployment_id = staging_status.get("id")
        if isinstance(deployment_id, str):
            active_deployment_id = deployment_id
        for version_item in staging_status.get("versions", []):
            if not isinstance(version_item, dict):
                continue
            version_id, percentage = version_item.get("version_id"), version_item.get("percentage")
            if isinstance(version_id, str) and isinstance(percentage, (int, float)) and not isinstance(percentage, bool):
                active_versions.append({"version_id": version_id, "percentage": percentage})
    retained_version_ids: set[str] = set()
    if isinstance(staging_deploy, list):
        for deployment in staging_deploy:
            if not isinstance(deployment, dict):
                continue
            for version_item in deployment.get("versions", []):
                if isinstance(version_item, dict) and isinstance(version_item.get("version_id"), str):
                    retained_version_ids.add(version_item["version_id"])
    secret_names = sorted(x.get("name") for x in staging_secrets if isinstance(x, dict) and isinstance(x.get("name"), str)) if isinstance(staging_secrets, list) else []

    capture = {
        "schema": 2,
        "captured_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "read_only": True,
        "token_name": TOKEN_NAME,
        "wrangler_version": version,
        "zone": {"name": ZONE_NAME, "access": state(zone_status)},
        "production_worker_routes": {"access": state(routes_status), "count": len(routes) if isinstance(routes, list) else None, "script_names": route_scripts},
        "zone_settings": settings,
        "zone_ruleset_inventory": {"access": state(rulesets_status), "relevant_rulesets": response_header_rulesets},
        "notification_policies": {"access": state(policies_status), "count": len(policies) if isinstance(policies, list) else None, "alert_types": alert_types, "available_types_access": state(types_status), "available_alert_categories": available_alert_categories, "workers_observability_alert_types": workers_observability_alert_types},
        "workers_observability_query_list": {"access": state(telemetry_status)},
        "durable_objects": {"namespace_list_access": state(namespaces_status), "namespace_count": len(namespaces) if isinstance(namespaces, list) else None},
        "custom_domains": {"list_access": state(custom_domains_status), "count": len(custom_domains) if isinstance(custom_domains, list) else None},
        "staging_worker": {
            "name": script_name,
            "deployment_status_access": staging_status_access,
            "active_deployment_id": active_deployment_id,
            "active_versions": active_versions,
            "retained_deployments_access": staging_deploy_status,
            "retained_version_ids": sorted(retained_version_ids),
            "secret_list_access": staging_secrets_status,
            "secret_names": secret_names,
        },
        "notes": ["No Cloudflare configuration was created, edited, deployed, or deleted.", "No live tail, weather API, production page, Logpush, telemetry query, alert, DNS, route, or custom-domain request was made beyond fixed control-plane GET inventory calls.", "HTTP error bodies and all provider payload fields outside explicit allowlists are discarded."],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(capture, indent=2, sort_keys=True) + "\n")
    print(f"captured sanitized Cloudflare readiness evidence: {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
