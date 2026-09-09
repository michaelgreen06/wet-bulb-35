# Phase 1.2 target serving model

**Status:** draft for architecture review.  Phase 1 is a parity migration, not an SEO or product change.

## Scope and classification

| Class | Meaning |
| --- | --- |
| **Verified** | Observed in this checkout or supplied as a project constraint. |
| **Decision** | Target boundary for Phase 1.2. |
| **Approval required** | A proposed value or behavior Michael must approve before it becomes implementation scope. |
| **Account unknown** | Requires inspection of the Cloudflare account; do not infer plan, enabled products, or retention. |

**Verified:** production is generated static HTML plus one uncached Vercel Node weather function. The target runtime is Hono on Cloudflare Workers. HTML location pages already request weather in the browser; the existing API blocks recognized bots with `204` and parses coordinates with `Number(source.lat)` / `Number(source.lon)`: missing parameters (`null`) and empty strings both coerce to `0`, while non-numeric, `NaN`, and infinite values return `400`; non-GET returns `405`, and provider failures return `500`. The committed city dataset is 130,684 rows / 19,923,105 bytes. The official Cloudflare Worker limits page, updated 2026-09-05, states a **64 MiB uncompressed** Worker-size limit for Free and Paid plans (no compressed-size limit), 128 MB isolate memory, and 1 s startup; individual static assets are limited to 25 MiB and paid static assets to 100,000. The reviewer's 10 MB Worker-size claim is stale and rejected.

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

**Decision:** canonical tags and Open Graph URLs remain the currently generated trailing-slash URLs. This preserves current behavior; it is explicitly **not** a canonical-tag, sitemap, robots, indexing, or content improvement project.

## Hono request flow

1. The Worker receives a request after domain/TLS handling.
2. Exact public/static assets are delegated to the static-asset binding. Hono does not intercept a valid asset to synthesize an HTML page.
3. Hono handles `GET`/`HEAD` HTML routes. It applies the route matrix, serves both recognized slashful and slashless HTML routes with `200` while retaining slashful canonical tags, resolves location metadata through the selected metadata binding, renders the parity template, and stores/serves HTML from the edge cache. `HEAD` has the corresponding `GET` status and headers but no body. Rendering never imports weather code and never calls a provider. Changing this duplicate-`200` behavior requires later explicit approval.
4. Hono handles `/api/weather` separately. It performs bot and method checks, validation/normalization, internal-cache lookup, and only then one provider fetch on a cache miss. It returns browser-facing JSON only.
5. Everything else is `404`. Error middleware must not convert a missing page to `200` or an API error to HTML.

**Decision:** use one Worker/Hono application with explicit route groups and a static-asset binding; do not use a catch-all client router, an origin proxy, or R2 in Phase 1.2.

## Location metadata packaging

The 134,676 projected static output files exceed the supplied 100,000 static-asset cap. Static HTML-per-location is therefore not a viable target packaging model.

| Option | Assessment |
| --- | --- |
| All generated HTML as static assets | Rejected: projected file count is over the supplied cap. |
| One 19.9 MB JSON document parsed per request/isolate | Rejected: technically below the verified 64 MiB uncompressed Worker limit before bundle overhead, but needless full parsing risks the 128 MB isolate limit and cold-start cost. |
| Cloudflare KV/D1/R2 | Deferred: account capability, cost, latency, and operational need are unverified. R2 is not introduced without measured need. |
| **Generated, compact static-asset metadata shards plus a small Worker route manifest** | **Preferred pending binding integration.** Build-time country shards are served through the static-asset binding and selected by a small country/state manifest; the Worker reads only the requested shard. The packaging probe now preserves collision-safe route identity using the production JavaScript generator. A separately generated `/assets/locations.json` preserves the current client static-directory search contract. This needs no R2. |

**Decision:** the Worker dynamically renders route-matched HTML from the preferred metadata package and caches it; it does not store 130,684 HTML files. Metadata shards are immutable, build-time-generated static assets—not operational persistence or a required database. Keep metadata access behind a replaceable adapter so a future database can replace shards without changing public URLs, templates, or SEO behavior. The Durable Object proposed for weather-call coordination is separate and is not the location datastore. The renderer must reproduce current generated output semantically (DOM, visible strings, canonical/metadata, links, and widget attributes), subject to Phase 1.2 acceptance tests.

### Dataset measurement

Method: the packaging probe uses Python plus a Node adapter that calls the production `prepareCities`/`getRouteParts` logic. Generated files exist only in a temporary directory.

| Result | Value |
| --- | --- |
| Rows | 130,684 |
| Source file size | 19,923,105 bytes |
| Distinct countries / country-state pairs | 224 / 3,525 |
| Collision groups / affected rows | 1,419 / 3,014 |
| Distinct collision-safe city paths | 130,684, with zero duplicates |
| Compact shards plus manifest | 7,800,362 raw bytes / 2,511,189 gzip bytes |
| Runtime artifact count | 225 |
| Largest compact shard | United States: 955,923 raw bytes / 308,072 gzip bytes |
| Supplied projected static HTML output | 134,676 files (>100,000 cap) |

This is a packaging measurement, not a Cloudflare benchmark. Before implementation, run the Hono/static-assets binding integration plus the current Worker non-deploying dry-run: verify the produced artifact is below the official 64 MiB **uncompressed** limit; also measure requested-shard read/parse time and static search-index size. Local Wrangler readiness is not the Cloudflare 1 s script-startup metric. Design and run staging script-startup validation separately before any staging deployment decision. Reject the preferred packaging if any limit is approached or the binding probe cannot support the minimal integration.

## HTML caching

**Decision:** cache only successful `GET` HTML responses by resolved HTML route. `HEAD` mirrors headers/status and does not create an independent object. Cache key excludes query strings; the response body remains parity HTML, including the existing browser-side weather widget.

- Fresh HTML lifetime: **approval required — propose 24 hours**.
- Stale window: **approval required — propose 7 days**, served while a best-effort background regeneration may run.
- If render/metadata lookup fails and a stale object exists, serve stale HTML. If no object exists, return `500`; never substitute a weather-provider response or an empty success page.
- Cache headers must state the approved browser/edge policy. Cache invalidation is deployment-versioned (a new Worker/cache namespace or equivalent), not a broad runtime purge assumption.

Freshness, stale serving, revalidation, eviction behavior, and same-key collapse are best-effort within an isolate/colo only; Cache API contents do not replicate outside their originating data center and `cache.put` is not tiered. They are not a global guarantee. The cache implementation must be selected only after confirming account/runtime behavior for the static-assets binding and Worker Cache API.

## `/api/weather` contract

### Validation, normalization, and key

**Decision:** only `GET` is supported; `HEAD`, `OPTIONS`, and every other method return `405` with exact `Allow: GET`. Recognized bot user agents return empty `204` before coordinate processing and never call the provider. The established bot regex remains the parity baseline; absent user agent is not treated as a bot. `/api/weather/` remains `404`, not redirected.

**Verified parity evidence:** `URLSearchParams.get()` returns `null` for an absent parameter, and the source's `Number(source.lat)` / `Number(source.lon)` coercion turns both `null` and `""` into `0`. Thus the current API sends missing and empty coordinates through as zero rather than returning `400`; non-numeric, `NaN`, and infinite values return the established `{"error":"Valid lat and lon are required."}` payload. Otherwise finite out-of-range values are forwarded unchanged.

**Implemented approved abuse protection:** require both parameters to be present and non-empty, coerce them to finite JavaScript numbers, and reject `lat` outside `[-90, 90]` or `lon` outside `[-180, 180]` with the established `400` payload. This occurs before any cache or Durable Object call.

For cache identity, canonicalize each accepted parsed JavaScript `Number` using its exact JavaScript number string (`String(number)`), normalizing `-0` to `0`. Use the internal key:

```
weather:v1:lat:{canonical-lat}:lon:{canonical-lon}
```

The exact same parsed numbers are forwarded upstream; no provider-coordinate rounding occurs. Query parameter order, extra query parameters, and equivalent spellings that parse to the same JavaScript number map to the same key. The response JSON retains the provider's existing shape; add no user-visible cache fields. Any future coordinate bucketing, precision reduction, range rule, or rounding is a behavior change requiring explicit approval.

### TTL, stale, and failure semantics

**Approval required — proposed defaults:** fresh API TTL **300 seconds**; stale-on-error/while-revalidate window **600 seconds**; upstream timeout **5 seconds**. These values need provider quota and traffic review.

**Decision:**

1. A fresh internal-cache hit returns `200` without a provider call in that isolate/colo.
2. A stale internal-cache hit returns its last successful `200` JSON immediately and may start at most one best-effort refresh for that key in that isolate/colo; stale is never extended by a failed refresh.
3. A miss may call the provider once through the canonical key; only a schema-valid successful provider response is stored. Same-key coalescing is isolate-local best effort, not a global provider-call ceiling.
4. The stored object is an **internal cache envelope/response**, separate from the browser response, containing the schema-valid payload plus `storedAt`, `freshUntil`, and `staleUntil` timestamps (and deployment/cache version as needed). Never put the browser-facing `private, no-store` response directly into Cache API.
5. Cache eviction and background refresh are best effort. If the provider fails on a miss, return the established `500` JSON error behavior; do not store failures. If it fails during stale refresh, retain stale only until its fixed stale deadline.
6. Every browser-facing successful `/api/weather` response preserves the current exact `Cache-Control: private, no-store, no-cache, max-age=0, must-revalidate` header. This no-store browser response is constructed from the internal envelope only after lookup/refresh; browser caching cannot replace Worker semantics.

**Decision:** preserve current user-visible provider-error messages and `500` status in Phase 1.2. Mapping upstream failures to `502`/`503`, adding retry-after headers, or changing response schema requires approval.

### Bot and load protection

**Decision:** retain the current recognized-bot `204` behavior in both client runtime and API; HTML must still never cause a provider call server-side. The Worker may coalesce simultaneous same-key misses only within an isolate/colo, uses the canonical key, and places a strict timeout around provider calls. It does not trust isolate-local or colo-local state as global rate limiting.

**Account unknown:** whether Cloudflare WAF/rate limiting, Bot Management, Workers Analytics Engine, Logpush, or a globally coordinated primitive is enabled and what their limits/costs are.

**Pre-cutover gate:** choose and verify a global provider-call ceiling (with alerting and owner) after account discovery, or explicitly quantify and obtain Michael's written acceptance of the residual provider-call risk across isolates/colos. A per-client-IP limit is recommended in addition. Do not claim a global cap from Worker-local state. Cutover cannot proceed on cache collapse, timeout, bot skip, and observability alone without this gate.

### Provider-call observability

**Decision:** emit one structured event for every attempted provider call, not for cache hits: `event=weather_provider_call`, deployment version, outcome (`success`, `timeout`, `upstream_http`, `invalid_payload`, `exception`), upstream status when available, latency milliseconds, canonical-key hash, and cache state (`miss` or `stale_refresh`). Do not log API keys, raw IPs, raw query strings, raw coordinates, outbound provider URLs, provider request objects, or error objects/messages that can contain secrets. Emit aggregate counters for cache hit/miss/stale/bot-skip/validation failure and provider outcomes.

**Account unknown:** sink, retention, query access, and alerting. Console structured logs are the minimum fallback; an approved account-backed metrics/log sink and provider-call failure/cache-miss alerts must be verified before production cutover.

## Static assets, sitemaps, and robots

**Decision:** preserve the committed public asset set and byte content where feasible, including `robots.txt`, `/sitemap.xml`, and `/sitemaps/`. They are static-asset responses with no Hono-generated XML and no weather path. Keep the existing robots disallows for old API sitemap paths and existing sitemap absolute URLs/lastmod data. Do not add, remove, regenerate, repartition, or optimize sitemap content in Phase 1.2.

Fingerprinting or changing immutable-cache headers for static assets is deferred: it may be useful, but it is not parity work. The existing `/assets/locations.json` path remains available to the browser; its content/order must be validated against the current generated artifact.

## Secrets and configuration

**Decision:** `OPENWEATHER_API_KEY` is a Worker secret only. It is never bundled, returned, logged, placed in HTML, or named `NEXT_PUBLIC_*`. The existing public Google Places key and GA measurement ID remain public configuration only because the browser currently consumes them; their values are not secrets. Secret absence yields the existing API failure behavior and a provider-call observability event without sensitive detail.

**Account unknown:** secret names/scopes per environment, availability of preview secrets, access controls, rotation procedure, and whether an existing provider key is restricted to the production domain. Verify these without exposing values.

## Preview, staging, and rollback

**Decision:** preview/staging uses a separate Worker deployment and non-production hostname; it must not receive the production custom domain, production provider secret, or production cache namespace. Preview stub weather testing is fixture-only and proves no production-provider behavior. Before cutover, a separately authorized, redacted production-equivalent provider smoke is required; it must use an approved non-production credential/endpoint arrangement, record only redacted outcome evidence, and make no secret-bearing provider URL/request/error logs.

**Pre-cutover rollback gate:** name the production traffic control plane (Cloudflare custom-domain routing control plane, including account/product and UI/API identifier; plus DNS/registrar control plane if separate), the Vercel production deployment URL/ID and retained configuration, the propagation and cache-expiry bounds, the rollback owner, and the rollback-window end. Rehearse a reversible cutover and route-back to the retained Vercel deployment using that control plane, and retain evidence. A Worker version rollback is secondary and does not replace the known-good-origin rollback. No data migration exists in the preferred default, so rollback does not require R2/KV/D1 recovery.

**Account unknown:** whether custom-domain routing, weighted/canary rollout, version retention, preview domains, and rollback controls are available. Do not promise staged percentages or instant rollback until confirmed.

## Compact decision record

| ID | Decision | Rationale | State |
| --- | --- | --- | --- |
| D-01 | Dynamic Worker rendering plus edge HTML cache; no static HTML-per-city assets | 134,676 projected files exceed the 100,000 cap | Decided |
| D-02 | Preferred build-time static-asset metadata shards plus small Worker manifest; no R2 | Avoids bundling the corpus; packaging/binding probe and minimal integration remain gates | Pending probe |
| D-03 | Slashful HTML URLs are canonical; recognized slashless routes return `200` | Preserves current duplicate-`200` behavior while retaining generated canonical route form; any change requires later explicit approval | Decided |
| D-04 | HTML never calls weather; browser calls `/api/weather` | Required Phase 1 separation | Decided |
| D-05 | Coordinate presence/non-empty and geographic-range validation are one approval-required abuse-protection contract; approve before cutover | Current `Number()` coercion sends missing/empty coordinates as zero and forwards finite out-of-range values, creating malformed cache/provider calls | Approval required |
| D-06 | Canonical parsed-Number-string cache identity; internal timestamped envelope; exact parsed numbers upstream | Preserves coordinate precision and browser `private, no-store` behavior | Pending TTL approval |
| D-07 | Provider controls require global ceiling or accepted quantified residual risk before cutover | Isolate/colo-local state cannot provide a global limit | Pre-cutover gate |
| D-08 | Preserve robots, sitemap, and SEO output exactly | Phase 1 is parity-only | Decided |

## Phase 1.2 acceptance tests

1. Route fixtures cover home, browse, one country, one state, a normal city, and a collision-safe city: canonical slashful URL and slashless equivalent each return `200`; canonical tags remain slashful; unknown/wrong-case/over-deep routes return `404`. The tests must reject any unapproved redirect or other change to this duplicate-`200` behavior.
2. Full-inventory semantic parity evidence is generated from the current static output before implementation: a versioned per-route manifest/fingerprint records every route and status, title/description/robots/JSON-LD metadata, canonical and Open Graph values, widget attributes, links, sitemap membership, and the locations-index checksum/order. Compare the target against that manifest before cutover. Keep representative DOM snapshots for home, browse, country, state, normal city, collision-safe city, and error routes; these snapshots complement rather than replace the inventory evidence. HTML tests explicitly prove zero server-side provider calls.
3. Asset tests fetch/inspect `robots.txt`, `sitemap.xml`, representative `/sitemaps/*`, favicon/logo, and `/assets/locations.json`; expected paths/content and `200` behavior are unchanged. Missing assets are `404`.
4. Metadata tests resolve every route produced by the source dataset, preserve collision-safe routes, prove static-asset shard binding behavior and minimal integration, and report artifact size plus representative requested-shard read/parse time. A current non-deploying Worker dry-run confirms the artifact is below the official 64 MiB uncompressed limit; a startup check confirms the official 1 s limit. Neither test requires R2.
5. API unit/integration tests preserve explicit source-parity evidence: fixtures prove that source `Number()` coercion sends each of missing `lat`, missing `lon`, empty `lat`, and empty `lon` as `0`, and that finite out-of-range values are forwarded; non-numeric, `NaN`, and infinite values return the established `400` payload. The target tests cover the coordinate contract Michael approves: if the recommended abuse protection is approved, each missing/empty or out-of-range coordinate returns `400` with zero cache/provider calls; if parity retention is approved instead, those documented coercion/forwarding fixtures remain target behavior. In either case, also cover GET success; `HEAD`, `OPTIONS`, `POST`, and another verb (each `405`, exact `Allow: GET`); `/api/weather/` (`404`, no redirect); bot (`204`, zero provider calls); canonical equivalent coordinates sharing one key with `-0` normalized to `0`; exact parsed numbers forwarded upstream; fresh hit (zero provider calls); isolate/colo-local best-effort same-key concurrent-miss collapse; stale hit with successful refresh; stale hit with failed refresh; miss failure (`500`, not cached); timeout; and the internal envelope timestamps. They must not assert global collapse or global freshness.
6. API tests prove payload shape and current user-visible error strings/statuses remain compatible; every browser-facing successful response has exact `Cache-Control: private, no-store, no-cache, max-age=0, must-revalidate`; the Cache API receives only the internal timestamped envelope, never that browser response; no raw coordinates/keys/IPs, provider URLs/request objects, or secret-bearing errors appear in observability; and exactly one provider-call event is emitted per attempted upstream call.
7. Cache tests prove query strings do not create distinct HTML cache entries, API extra query parameters do not change the canonical weather key, `HEAD` HTML mirrors the corresponding `GET` status/headers without a body, eviction/background refresh remain best effort, and a new deployment/cache namespace cannot accidentally serve an old HTML artifact.
8. Preview tests label stub results fixture-only and prove preview uses no production domain, provider secret, or cache namespace. A separately authorized, redacted production-equivalent provider smoke is evidenced before cutover. Rollback rehearsal documents a reversible route back to the retained Vercel deployment/config through the named control plane, owner, and propagation/cache bounds, without data restoration.

## Next bounded subphase

Run a **non-deploying packaging feasibility probe only**: generate preferred static-asset metadata shards and the small Worker route manifest from the committed dataset; correct/confirm static-asset binding packaging and add only the minimal binding integration; measure artifact size, requested-shard read/parse time, and static search-index size; run Worker dry-run/startup checks against the official 64 MiB uncompressed/1 s limits; and generate the versioned current-output parity manifest/fingerprint with representative DOM snapshots. It must use no Cloudflare authentication, deployment, R2, provider call, or product-code change beyond the probe's minimal binding integration. Account discovery and TTL/rate-limit decisions remain review gates, not implementation work.

## Questions requiring architect/user decision

1. Does Michael approve the proposed API fresh/stale TTLs (300 s / 600 s), 5 s timeout, and HTML TTLs (24 h / 7 d), or provide alternatives?
2. Does Michael approve the recommended combined abuse protection—presence/non-empty validation plus geographic-range rejection—before cutover, or explicitly approve retaining current `Number()` coercion (missing/empty-as-zero) and finite out-of-range forwarding?
3. Which Cloudflare account capabilities are available for static assets, Worker Cache API behavior, WAF/rate limiting, logs/metrics/alerts, preview domains, custom-domain cutover, and rollback/version retention?
4. What global provider-call ceiling and owner are required before production cutover, or what quantified residual risk will Michael explicitly accept?
5. What rollout and rollback window is acceptable while Vercel remains the known-good origin, including propagation and cache-expiry bounds and named traffic control plane?
