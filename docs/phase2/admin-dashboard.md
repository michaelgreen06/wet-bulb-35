# Private operations dashboard (issue #53)

## Status

Code and tests only. **Not deployed, not routable.** No Cloudflare Access application, DNS record, Worker route/custom domain, KV namespace, or secret has been created. Each of those is a separate approval gate below.

## Architecture

```
operator host (cron)                         Cloudflare (after approval)
scripts/run-admin-status.sh                  wetbulb35-admin-dashboard Worker
  collect-admin-status.py                      scheduled */5: WeatherGate /budget (read-only DO)
    site   → public provider-free routes           → KV status/v1/panel/budgets
    top50  → public snapshot APIs + GH runs     fetch (Access JWT + allowlist + host + HTTPS):
    search → GSC read-only scope                   KV status/v1/panel/* → projection → HTML / JSON
    ga4    → GA4 Data API (Viewer)
  → ~/.local/share/wetbulb35-admin/panels/*.json (0600)
  → optional --publish-kv (gated) → KV
```

- **Page views only read stored panel documents.** They never call Google, weather providers, ECMWF, or the WeatherGate Durable Object, and never start forecast generation. The only outbound request a page view can make is the Access signing-key fetch (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached 1 h).
- **Contract:** `lib/admin/status-contract.mjs`. One document per panel: `schemaVersion`, `panel`, `status` (`ok|degraded|down|unknown|unavailable`), `reason` (fixed code), `collectedAt`, `lastAttempt {at,outcome,reason}`, `data`. The Worker projects every document through an explicit field allowlist, so unexpected fields (raw payloads, queries, provider text) never reach the browser. `scripts/validate-admin-status.mjs <dir>` fails if a collector emits a field the projection would drop.
- **Freshness is evaluated at view time.** A panel older than its maximum age (site 30 min, budgets 20 min, Top-50 60 min, GSC/GA4 36 h) or whose latest attempt failed is shown as **Stale** with its last result kept and labeled not live. `null` means not collected; `0` is a real zero; `unavailable` means the source failed before any success.
- **Collector failures** keep the last successful document and record the failed attempt. The collector prints one de-duplicated alert line per state change (panel, state, reason code only) for the existing cron alert path.

## Panels

| Panel | Source | Notes |
|---|---|---|
| Site health | Single HTTPS probe from the operator host: `/`, tier-1 rank-1 city page (canonical link checked), `/api/inhabited-hotspots` | Provider-free routes only. One probe, not global uptime; separate from the temporary post-release monitor. A `404` snapshot route is "not published", not down. |
| Top-50 forecast health | `/api/inhabited-hotspots`, `/api/global-grid-hotspots` (metadata only) + public GitHub Actions run metadata | Inhabited and unfiltered shown separately: IFS initialization, retrieval, publish time, validity window, latest cycle, latest failed/retrying cycle. Rankings, places and values are discarded. Expired (`now ≥ validTo`) is never current; missing initialization is "run metadata missing" and initialization after `validFrom` or in the future is invalid — neither is current. |
| Weather call budgets | WeatherGate DO `/budget` | Reserved attempts vs configured daily caps for current conditions (OpenWeather) and five-day (Open-Meteo), last provider error (time, fixed outcome, HTTP status only), reset = **our** 00:00 UTC counter rollover. Labeled internal safeguards, not vendor quota/reset. Top-50 scheduled refinements are shown separately from visitor-triggered calls. |
| Search health | GSC `webmasters.readonly`: Search Analytics by `date` only; URL Inspection of a fixed 10-URL sample (homepage + tier-1 ranks 1–9) | Last 7/28 complete days vs prior windows. Windows end at an explicit complete day: GSC `metadata.firstIncompleteDate` − 1 (query uses `dataState: all`; incomplete rows dropped), else a conservative today − 3. Never the newest row: zero-impression days are omitted by GSC and count as zero, so a collapse shows as zeros. The latest day with any data is shown separately; no data within 2 days of the complete day is degraded. Sample status is not a sitewide indexed count. No query dimension, sitemap submission, or indexing request. |
| GA4 health | GA4 Data API (Viewer): daily sessions, product-event count | Latest data date; days after "complete through" (today − 2) labeled partial. Reuses `wetbulb_ga4.py` and reads the spike monitor's last evaluation date and latest weekly report date. |

## WeatherGate changes

`workers/weather-edge.mjs` adds:

- `POST /budget` on the Durable Object: read-only; returns today's `attempts:` / `forecast-attempts:` counters, configured limits, next UTC midnight, and last provider errors. It reserves nothing and calls no provider. It is reachable only through the Durable Object binding; no public route forwards to it.
- On a non-success OpenWeather or Open-Meteo provider call, it stores `provider-error:weather|forecast` = `{at, outcome, upstreamStatus}`. Provider bodies, messages, keys and coordinates are never stored.

`workers/forecast-edge.ts` is unchanged, avoiding overlap with issue #50.

## Issue #50 integration (required before staging)

#50 keeps OpenWeather for current conditions and moves five-day and Top-50 to explicit IFS. Before staging:

1. Add #50's final run/readiness field locations to `TOP50_FIELD_PATHS` in `scripts/admin_status.py` (the first present path wins; missing fields render as unknown, never inferred).
2. Set `ADMIN_TOP50_MAX_INIT_AGE_HOURS` (Worker var and collector env) to #50's overdue-cycle threshold (e.g. 15 h for 6-hourly cycles; default 36 h matches PR #29's daily run).
3. Set `ADMIN_TOP50_WORKFLOW` if #50 renames the workflow, and `HOTSPOT_DAILY_LOCATION_LIMIT` to the approved per-run cap.
4. Re-run `npm run test:admin-dashboard` against a real #50 snapshot's metadata.

## Access and exposure (prepared, not configured)

Primary control: a Cloudflare Access self-hosted application covering `admin.wetbulb35.com/*` (every path, API and asset), policy **Allow → Emails → approved list**, login method **One-time PIN** only. Configure it **before** attaching any route. Then:

- `wrangler.admin-dashboard.toml` already sets `workers_dev = false`, `preview_urls = false` and has no routes, so no alternate hostname exists. The Worker also returns `404` for any host other than `ADMIN_HOSTNAME`.
- The Worker independently verifies the `Cf-Access-Jwt-Assertion` token (RS256, team issuer, application audience, expiry) and the email allowlist; it returns `503` with no data until all of `ADMIN_ACCESS_TEAM_DOMAIN`, `ADMIN_ACCESS_AUD` and `ADMIN_ALLOWED_EMAILS` are set.
- Plain HTTP is redirected to HTTPS without data; responses carry `X-Robots-Tag: noindex, nofollow, noarchive`, `Cache-Control: private, no-store`, a script-free CSP, `X-Frame-Options: DENY` and HSTS. There is no analytics tag, no public link, and no sitemap entry.

## Approval and validation gates

| Gate | Owner | Blocks |
|---|---|---|
| Approved allowlist email addresses | Michael | Access policy and the `ADMIN_ALLOWED_EMAILS` Worker secret (not guessed, never committed) |
| Cloudflare Access application + OTP (team domain, AUD) | Michael approves; operator configures | Any route |
| KV namespace for `ADMIN_STATUS` + KV-write token for the collector host | Michael | Real data in the dashboard (`--publish-kv`) |
| Cross-script DO binding to `wetbulb35-weather-production` | Michael | Budget panel |
| Custom domain `admin.wetbulb35.com` + DNS | Michael (after Access verified) | Reachability |
| GSC: a service account with Full user access to the property (as `gsc_tracker.py` smoke test requires for URL Inspection), used only with the read-only scope, `GSC_SERVICE_ACCOUNT_FILE`/`_JSON` + `GSC_SITE_URL` on the host; `google-api-python-client` in the collector venv | Michael | Search panel (currently `credential_not_configured`) |
| GA4: existing Viewer credential (outside Git) | — | Validated only by unit tests here; a live read-only run is a later validation step |
| #50 merged final IFS fields | #50 owner | Top-50 panel staging verification |
| Staging verification: Access denial of HTML/JSON/assets/alternate hosts, HTTPS, crawler exclusion, aggregates vs local counters/GSC/GA4 outputs | Hermes | Release |

## Operator runbook (after gates)

```sh
# every 15 min
scripts/run-admin-status.sh --panels site,top50 --publish-kv
# daily (GSC: 10 inspections/run, well under the 2,000/day property limit shared with gsc_tracker.py)
scripts/run-admin-status.sh --panels search,ga4 --publish-kv
node scripts/validate-admin-status.mjs ~/.local/share/wetbulb35-admin/panels
```

## Tests

```sh
npm run test:admin-dashboard     # Worker, contract, Access gate, Python collectors, cross-language contract
npm run test:weather-edge        # WeatherGate incl. existing budget/provider tests
npm run dry-run:admin-dashboard  # packages only; no upload
```

## Non-goals

Exhaustive indexing inventories, raw URL/query analytics, per-city analytics, billing reconciliation, real-time GA4, rich charts.
