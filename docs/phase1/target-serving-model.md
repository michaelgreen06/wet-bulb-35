# Phase 1.2 target serving model

**Status:** draft for architecture review.  Phase 1 is a parity migration, not an SEO or product change.

## Scope and classification

| Class | Meaning |
| --- | --- |
| **Verified** | Observed in this checkout or supplied as a project constraint. |
| **Decision** | Target boundary for Phase 1.2. |
| **Approval required** | A proposed value or behavior Michael must approve before it becomes implementation scope. |
| **Account unknown** | Requires inspection of the Cloudflare account; do not infer plan, enabled products, or retention. |

**Verified:** production is generated static HTML plus one uncached Vercel Node weather function. The target runtime is Hono on Cloudflare Workers. HTML location pages already request weather in the browser; the existing API blocks recognized bots with `204`, accepts finite numeric coordinates, and returns `400` for missing/non-numeric coordinates, `405` for non-GET, and `500` for provider failures. The committed city dataset is 130,684 rows / 19,923,105 bytes. The supplied Cloudflare constraints are 100,000 paid static assets, 64 MiB Worker size, 128 MB isolate memory, and 25 MiB individual assets.

**Decision:** retain existing URLs, rendered content, metadata, robots directives, sitemap URLs, status behavior where documented below, and known defects unless an approval explicitly names a change. Do not add SEO features, revise copy, alter titles/descriptions/schema, create redirects, or expose weather in server-rendered HTML.

## Route and canonical contract

The canonical host remains `www.wetbulb35.com` over HTTPS. Host redirects, if necessary, are edge/domain configuration, not Hono application routes. Query strings do not affect an HTML page identity.

| Request class | Canonical path / handling | Status and body |
| --- | --- | --- |
| Home | `/` | `200`, parity HTML shell; no provider call. |
| Browse index | `/wetbulb-temperature/` | `200`, parity HTML shell; no provider call. |
| Existing country | `/wetbulb-temperature/{country}/` | `200`, parity HTML shell; no provider call. |
| Existing state | `/wetbulb-temperature/{country}/{state}/` | `200`, parity HTML shell; no provider call. |
| Existing city | `/wetbulb-temperature/{country}/{state}/{city}/` | `200`, parity HTML shell and existing canonical/JSON-LD; no provider call. Collision-safe city slugs stay exact. |
| The preceding HTML paths without the terminal slash | slashless request path; canonical tags remain trailing-slash URLs | `200`, parity HTML shell; no provider call. Preserve the current duplicate-`200` behavior. Changing it, including by adding a slash redirect, requires later explicit approval. |
| Unknown, malformed, over-deep, or wrong-case HTML path | none | `404`; no SPA fallback, fuzzy lookup, redirect, or provider call. Case sensitivity is intentional until production behavior is captured. |
| Weather endpoint | `/api/weather` exactly | API contract below. `/api/weather/` is `404`, not redirected. |
| Existing public files, including `/robots.txt`, `/sitemap.xml`, `/sitemaps/*`, `/favicon.svg`, `/logo.svg`, and `/assets/*` | exact requested path | Static response, `200` when present; no Worker HTML rendering or provider call. Missing files are `404`. |
| Other `/api/*` or sitemap-like legacy URLs | none | Preserve the current static `robots.txt` directives; otherwise `404`. |

**Decision:** canonical tags and Open Graph URLs remain the currently generated trailing-slash URLs. This is normalization only; it is explicitly **not** a canonical-tag, sitemap, robots, indexing, or content improvement project.

## Hono request flow

1. The Worker receives a request after domain/TLS handling.
2. Exact public/static assets are delegated to the static-asset binding. Hono does not intercept a valid asset to synthesize an HTML page.
3. Hono handles `GET`/`HEAD` HTML routes. It applies the route matrix, serves both recognized slashful and slashless HTML routes with `200` while retaining slashful canonical tags, resolves location metadata locally, renders the parity template, and stores/serves HTML from the edge cache. Rendering never imports weather code and never calls a provider. Changing this duplicate-`200` behavior requires later explicit approval.
4. Hono handles `/api/weather` separately. It performs bot and method checks, validation/normalization, cache lookup, and only then one provider fetch on a cache miss. It returns JSON only.
5. Everything else is `404`. Error middleware must not convert a missing page to `200` or an API error to HTML.

**Decision:** use one Worker/Hono application with explicit route groups and a static-asset binding; do not use a catch-all client router, an origin proxy, or R2 in Phase 1.2.

## Location metadata packaging

The 134,676 projected static output files exceed the supplied 100,000 static-asset cap. Static HTML-per-location is therefore not a viable target packaging model.

| Option | Assessment |
| --- | --- |
| All generated HTML as static assets | Rejected: projected file count is over the supplied cap. |
| One 19.9 MB JSON document parsed per request/isolate | Rejected: technically below the supplied 64 MiB Worker limit before bundle overhead, but needless full parsing risks the 128 MB isolate limit and cold-start cost. |
| Cloudflare KV/D1/R2 | Deferred: account capability, cost, latency, and operational need are unverified. R2 is not introduced without measured need. |
| **Generated, compact, Worker-bundled metadata shards plus a small route manifest** | **Recommended default.** Build-time shards by country (and a small country/state manifest) are imported as data, selected by route prefix, and parsed only for the requested shard. The complete data artifact must remain below the Worker-size limit with measured bundle headroom. A separately generated `/assets/locations.json` preserves the current client static-directory search contract. This needs no R2. |

**Decision:** the Worker dynamically renders route-matched HTML from the recommended metadata package and caches it; it does not store 130,684 HTML files. Metadata is build-time input only and is never fetched at request time. The renderer must reproduce current generated bytes semantically (DOM, visible strings, canonical/metadata, links, and widget attributes), subject to Phase 1.2 acceptance tests.

### Dataset measurement

Method: Python 3 standard-library `json` parsed `scripts/resolved_cities.json`; a Node attempt to run the existing generator could not resolve the uninstalled `slugify` dependency, so it was not used for derived-route counts.

| Result | Value |
| --- | --- |
| Rows | 130,684 |
| File size | 19,923,105 bytes |
| Parse time on this checkout | 0.237 s |
| Required fields present and non-empty | all rows: `name`, `resolvedCountryName`, `resolvedAdmin1Code`, `latitude`, `longitude` |
| Distinct countries / raw country-state pairs | 224 / 3,525 |
| Latitude range / longitude range | -54.93355..78.22334 / -179.11838..179.36451 |
| Supplied projected static output | 134,676 files (>100,000 cap) |

This is a shape check, not a Cloudflare benchmark. Before implementation, measure the generated Worker artifact, cold parsing of a representative largest shard, and static search-index size; reject the default if either Worker limit is approached.

## HTML caching

**Decision:** cache only successful `GET` HTML responses by resolved HTML route. `HEAD` mirrors headers/status and does not create an independent object. Cache key excludes query strings; the response body remains parity HTML, including the existing browser-side weather widget.

- Fresh HTML lifetime: **approval required — propose 24 hours**.
- Stale window: **approval required — propose 7 days**, served while a single best-effort background regeneration runs.
- If render/metadata lookup fails and a stale object exists, serve stale HTML. If no object exists, return `500`; never substitute a weather-provider response or an empty success page.
- Cache headers must state the approved browser/edge policy. Cache invalidation is deployment-versioned (a new Worker/cache namespace or equivalent), not a broad runtime purge assumption.

The cache implementation must be selected only after confirming account/runtime behavior for the static-assets binding and Worker Cache API.

## `/api/weather` contract

### Validation, normalization, and key

**Decision:** only `GET` is supported; other methods return `405` with `Allow: GET`. Recognized bot user agents return empty `204` before coordinate processing and never call the provider. The established bot regex remains the parity baseline; absent user agent is not treated as a bot.

**Decision:** `lat` and `lon` are required and must coerce to finite JavaScript numbers. Missing, empty, `NaN`, and infinite values return `400` with the established `{"error":"Valid lat and lon are required."}` payload. To preserve the existing behavior, Phase 1.2 does **not** reject otherwise finite values outside geographic ranges and does not clamp coordinates.

**Approval required:** reject `lat` outside `[-90, 90]` and `lon` outside `[-180, 180]`. This is desirable abuse protection but would change the parity-locked current API behavior, so it is not silently adopted.

For cache identity, normalize each accepted number using canonical JavaScript `toFixed(4)` semantics; normalize negative zero to `0.0000`. Use the internal key:

```
weather:v1:lat:{normalized-lat}:lon:{normalized-lon}
```

The normalized pair is the only provider coordinate pair. Query parameter order, extra query parameters, and equivalent numeric spellings map to the same key. The response JSON retains the provider's existing shape; add no user-visible cache fields.

### TTL, stale, and failure semantics

**Approval required — proposed defaults:** fresh API TTL **300 seconds**; stale-on-error/while-revalidate window **600 seconds**; upstream timeout **5 seconds**. These values need provider quota and traffic review.

**Decision:**

1. A fresh cache hit returns `200` without a provider call.
2. A stale hit returns its last successful `200` JSON immediately and starts at most one best-effort refresh for that key; stale is never extended by a failed refresh.
3. A miss calls the provider once through the normalized key. Only a schema-valid successful response is cached.
4. If the provider fails on a miss, return the established `500` JSON error behavior; do not cache failures. If it fails during stale refresh, retain stale only until its fixed stale deadline.
5. Cache headers make browser caching subordinate to Worker/edge semantics; browsers must not defeat the Worker freshness policy. Exact header values are approval-required implementation detail.

**Decision:** preserve current user-visible provider-error messages and `500` status in Phase 1.2. Mapping upstream failures to `502`/`503`, adding retry-after headers, or changing response schema requires approval.

### Bot and load protection

**Decision:** retain the current recognized-bot `204` behavior in both client runtime and API; HTML must still never cause a provider call server-side. The Worker also coalesces simultaneous same-key misses within an isolate, uses the normalized cache key, and places a strict timeout around provider calls. It does not trust an isolate-local map as global rate limiting.

**Account unknown:** whether Cloudflare WAF/rate limiting, Bot Management, Workers Analytics Engine, Logpush, or a globally coordinated primitive is enabled and what their limits/costs are.

**Approval required:** choose a global abuse rule after account discovery: proposed starting policy is a per-client-IP rate limit on `/api/weather` plus an account-level provider-call ceiling/alarm. Do not claim a global cap from local Worker state alone. If no account-level control exists, launch is limited to cache collapse, timeout, bot skip, and observability; Michael must accept that residual risk.

### Provider-call observability

**Decision:** emit one structured event for every attempted provider call, not for cache hits: `event=weather_provider_call`, deployment version, outcome (`success`, `timeout`, `upstream_http`, `invalid_payload`, `exception`), upstream status when available, latency milliseconds, normalized-key hash, and cache state (`miss` or `stale_refresh`). Do not log API keys, raw IPs, raw query strings, or raw coordinates. Emit aggregate counters for cache hit/miss/stale/bot-skip/validation failure and provider outcomes.

**Account unknown:** sink, retention, query access, and alerting. Console structured logs are the minimum fallback; an approved account-backed metrics/log sink and provider-call failure/cache-miss alerts must be verified before production cutover.

## Static assets, sitemaps, and robots

**Decision:** preserve the committed public asset set and byte content where feasible, including `robots.txt`, `/sitemap.xml`, and `/sitemaps/`. They are static-asset responses with no Hono-generated XML and no weather path. Keep the existing robots disallows for old API sitemap paths and existing sitemap absolute URLs/lastmod data. Do not add, remove, regenerate, repartition, or optimize sitemap content in Phase 1.2.

Fingerprinting or changing immutable-cache headers for static assets is deferred: it may be useful, but it is not parity work. The existing `/assets/locations.json` path remains available to the browser; its content/order must be validated against the current generated artifact.

## Secrets and configuration

**Decision:** `OPENWEATHER_API_KEY` is a Worker secret only. It is never bundled, returned, logged, placed in HTML, or named `NEXT_PUBLIC_*`. The existing public Google Places key and GA measurement ID remain public configuration only because the browser currently consumes them; their values are not secrets. Secret absence yields the existing API failure behavior and a provider-call observability event without sensitive detail.

**Account unknown:** secret names/scopes per environment, availability of preview secrets, access controls, rotation procedure, and whether an existing provider key is restricted to the production domain. Verify these without exposing values.

## Preview, staging, and rollback

**Decision:** preview/staging uses a separate Worker deployment and non-production hostname; it must not receive the production custom domain, production provider secret, or production cache namespace. Preview HTML may be tested with fixture/stub weather only; this task does not call `/api/weather`.

Production cutover occurs only after an approved parity evidence set. Rollback is traffic/domain routing back to the known-good Vercel deployment; retain that deployment and its configuration until the rollback window closes. A Worker version rollback is secondary and does not replace the known-good-origin rollback. No data migration exists in the recommended default, so rollback does not require R2/KV/D1 recovery.

**Account unknown:** whether custom-domain routing, weighted/canary rollout, version retention, preview domains, and rollback controls are available. Do not promise staged percentages or instant rollback until confirmed.

## Compact decision record

| ID | Decision | Rationale | State |
| --- | --- | --- | --- |
| D-01 | Dynamic Worker rendering plus edge HTML cache; no static HTML-per-city assets | 134,676 projected files exceed the 100,000 cap | Decided |
| D-02 | Build-time, sharded Worker metadata; no R2 | Dataset is 19.9 MB and R2 need is unmeasured | Decided |
| D-03 | Slashful HTML URLs are canonical; recognized slashless routes return `200` | Preserves current duplicate-`200` behavior while retaining generated canonical route form; any change requires later explicit approval | Decided |
| D-04 | HTML never calls weather; browser calls `/api/weather` | Required Phase 1 separation | Decided |
| D-05 | API accepts finite coordinates only; no range rejection | Preserves present behavior | Decided |
| D-06 | Normalize to four decimals and cache provider results/stale responses | Controls duplicate calls without response-schema change | Pending TTL approval |
| D-07 | Provider controls use cache collapse, timeout, bot skip, then account-level rule if available | Isolate-local state cannot provide a global limit | Pending account discovery/approval |
| D-08 | Preserve robots, sitemap, and SEO output exactly | Phase 1 is parity-only | Decided |

## Phase 1.2 acceptance tests

1. Route fixtures cover home, browse, one country, one state, a normal city, and a collision-safe city: canonical slashful URL and slashless equivalent each return `200`; canonical tags remain slashful; unknown/wrong-case/over-deep routes return `404`. The tests must reject any unapproved redirect or other change to this duplicate-`200` behavior.
2. HTML snapshot/semantic comparison proves the selected fixtures retain visible copy, DOM/widget attributes, title, description, robots, canonical, Open Graph, JSON-LD, links, and no server-side provider invocation. It must explicitly prove that an HTML request performs zero provider calls.
3. Asset tests fetch/inspect `robots.txt`, `sitemap.xml`, representative `/sitemaps/*`, favicon/logo, and `/assets/locations.json`; expected paths/content and `200` behavior are unchanged. Missing assets are `404`.
4. Metadata tests resolve every route produced by the source dataset, preserve collision-safe routes, and report bundle size plus representative largest-shard parse time. The Worker artifact is below 64 MiB and the test does not require R2.
5. API unit/integration tests cover GET success; missing/non-finite coordinates (`400`); `POST` (`405`, `Allow: GET`); bot (`204`, zero provider calls); normalized equivalent coordinates sharing one key; fresh hit (zero provider calls); same-key concurrent miss collapse; stale hit with successful refresh; stale hit with failed refresh; miss failure (`500`, not cached); and timeout.
6. API tests prove payload shape and current user-visible error strings/statuses remain compatible, no raw coordinates/keys/IPs appear in observability output, and exactly one provider-call event is emitted per attempted upstream call.
7. Cache tests prove query strings do not create distinct HTML cache entries, API extra query parameters do not change the normalized weather key, and a new deployment/cache namespace cannot accidentally serve an old HTML artifact.
8. Preview tests prove preview uses no production domain, provider secret, or cache namespace. Rollback rehearsal documents a successful route back to Vercel without data restoration.

## Next bounded subphase

Run a **non-deploying packaging feasibility probe only**: generate the proposed metadata shards and route manifest from the committed dataset, measure Worker artifact size and largest-shard parse time, and compare representative generated HTML semantics with current static output. It must use no Cloudflare authentication, deployment, R2, provider call, or product-code change. Account discovery and TTL/rate-limit decisions remain review gates, not implementation work.

## Questions requiring architect/user decision

1. Does Michael approve the proposed API fresh/stale TTLs (300 s / 600 s), 5 s timeout, and HTML TTLs (24 h / 7 d), or provide alternatives?
2. Does Michael approve geo-range rejection despite the current finite-only API contract, or should Phase 1 retain finite out-of-range forwarding?
3. Which Cloudflare account capabilities are available for static assets, Worker Cache API behavior, WAF/rate limiting, logs/metrics/alerts, preview domains, custom-domain cutover, and rollback/version retention?
4. Is a global provider-call ceiling required before production cutover, and what provider quota/budget should drive it?
5. What rollout and rollback window is acceptable while Vercel remains the known-good origin?
