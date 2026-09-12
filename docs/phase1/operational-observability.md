# Phase 1 operational observability and bounded staging load

## Safety boundary

Deployment and verification are limited to the isolated `wetbulb35-weather-staging` workers.dev candidate. It has no route, DNS, custom-domain, or production-secret configuration in this repository; production remains untouched.

Application logs are fixed-field JSON emitted through `console.log`. They do not contain request URLs, paths, query strings, coordinates, IPs, provider URLs, API keys, request/error objects, or untrusted error text. Canonical weather keys are represented only by a SHA-256 hash.

Every actual provider fetch emits exactly one terminal `weather_provider_call` event:

```json
{
  "event": "weather_provider_call",
  "deployment_version": "Cloudflare-version-id-or-unknown",
  "outcome": "success|timeout|upstream_http|invalid_payload|exception",
  "upstream_status": 200,
  "latency_ms": 12,
  "canonical_key_hash": "sha256 hex",
  "cache_state": "miss|stale_refresh",
  "reserved_budget_used": 1,
  "reserved_budget_limit": 100
}
```

`upstream_status` is `null` when no safe HTTP status exists. Cache/bot/validation events use only their fixed event name, deployment version, cache state, and (when a canonical key exists) its hash. `weather_budget_exhausted` is internal evidence of the reserved daily used/limit; there is intentionally no public budget/admin endpoint.

HTML cache event sampling is explicitly controlled by `HTML_CACHE_EVENT_SAMPLE_RATE`. It defaults to `0` in the staging config, so HTML event collection is disabled until a reviewed fraction from `0` through `1` is set. HTML events contain only `html_cache_outcome`, deployment version, `hit|miss|stale`, cache state, and the fixed route class `html`.

The logger and hash are best effort: disabled, throwing, or rejected sinks are swallowed and do not affect weather/HTML status, cache behavior, retries, or provider execution. Provider calls remain one attempt with no retry.

## Pinned Wrangler configuration

The pinned local Wrangler is `4.129.1`. Its local `config-schema.json` accepts `[observability] enabled`, `redact_query_string`, and `[observability.logs] enabled`, `invocation_logs`, and `persist`. `wrangler.weather-staging.toml` enables persisted Worker Logs for the isolated candidate, disables invocation logs, and enables query-string redaction. `npm run dry-run:weather-edge` validates the configuration without uploading.

This proves local syntax only. It does **not** prove that the Cloudflare account has Worker Logs query access, retention, permissions, billing eligibility, alert policies, Logpush destinations, or notification ownership. Persisted Workers Logs retention and Cloudflare-side redaction remain **unverified**. No alert is configured here. Before any staging deployment, an account owner must confirm those capabilities and create/assign alerts for provider failures and abnormal cache misses; production cutover remains blocked by those account decisions.

## Safe tail wrapper

Do **not** run `wrangler tail` directly and do not redirect its stdout or stderr to a terminal, file, or ticket: raw invocation envelopes can include request URLs, query strings, client IPs, and Cloudflare/TLS metadata.

Use only `npm run --silent tail:weather-staging-safe` (equivalently, `node scripts/wrangler-tail-sanitizer.mjs`). The `--silent` flag is mandatory so npm itself cannot add non-event banner lines. The wrapper invokes the repository-installed pinned Wrangler for the fixed isolated Worker, privately consumes both streams, incrementally parses concatenated or multiline JSON envelopes, and writes only application `logs[].message` values that exactly match the fixed schemas above. It drops malformed, non-application, and schema-mismatched messages; it never prints raw envelopes or Wrangler stderr.

## Staging procedure

1. Michael explicitly authorized the existing public production OpenWeather key for this isolated staging Worker. It is already installed encrypted; never display, copy, or rotate it in this procedure. Confirm isolated staging logging, daily budget ownership, retention, and alerting. Do not use production DNS or routes.
2. Build and dry-run locally: `timeout 180s npm run dry-run:weather-edge`.
3. Deploy only after separate authorization: npm run deploy:weather-staging.
4. Tail only through `npm run --silent tail:weather-staging-safe`; direct raw `wrangler tail` is prohibited.
5. Send one bot request, one invalid-coordinate request, one same-key weather warm request and one same-key repeat. Inspect only fixed JSON fields for `weather_bot_skip`, `weather_validation_failure`, `weather_cache_miss`, `weather_cache_hit`, and exactly one terminal provider event for the actual provider attempt. Do not paste request URLs, secrets, bodies, or provider errors into evidence.
6. Record the redacted event counts, terminal outcome, cache state, latency, and reserved budget used/limit. Stop well below 100 provider attempts.

## Executed isolated verification

Recorded at `2026-09-09T06:43:52Z`. The existing encrypted `OPENWEATHER_API_KEY` was preserved by name, and the production-zone Worker route count remained zero.

- A bounded temporary deployment set `HTML_CACHE_EVENT_SAMPLE_RATE=1`; two same-route requests with distinct query strings produced sanitized Cache API counts of exactly `miss=1` and `hit=1`. The final deployment restored the rate to `0` at version `fe629b5a-08f8-4b28-bc4e-185f04dfe93e`; Wrangler reported 6 ms startup.
- Sanitized weather validation produced one bot skip, one validation failure, one cache miss, one cache hit, and exactly one terminal provider event. The sole attempt succeeded with upstream status 200 in 188 ms; the event reported reserved budget `4/100`. No retry occurred.
- Every retained tail event passed the fixed schema validator. Raw invocation envelopes and Wrangler stderr were neither displayed nor retained; the temporary sanitized files were removed. Persisted Workers Logs retention and Cloudflare-side redaction remain unverified.
- Live contracts passed: HTML GET/HEAD `200`, exact HTML cache-control, empty HEAD body; invalid weather `400` with the established error; weather `200` with the expected payload shape and exact private/no-store cache-control.

## Bounded load harness

`npm run load:staging-safe` runs `scripts/staging-load-harness.mjs --mode=fake`: a local fake server, 24 HTML requests at concurrency 4, and a warm plus four same-key weather requests. It never contacts a provider and prints only JSON latency percentiles/status counts—never bodies or secrets.

`--mode=local` requires an explicit non-production origin and refuses `wetbulb35.com` hosts. `--mode=staging` requires both the exact isolated workers.dev hostname and `--allow-staging-weather=true`. `--weather-requests` counts measured weather requests; a nonzero value adds one warm request, so it is capped at 19 and total weather requests are capped at 20. `--weather-requests=0` is HTML-only mode and makes zero weather requests. Example (only after authorization):

```sh
node scripts/staging-load-harness.mjs --mode=staging \
  --origin=https://wetbulb35-weather-staging.mgdevstuff.workers.dev \
  --allow-staging-weather=true --weather-requests=4
```

Executed against final version `fe629b5a-08f8-4b28-bc4e-185f04dfe93e` without retaining bodies:

- HTML-only: 24/24 status 200; latency p50 31.028 ms, p95 102.374 ms, max 113.660 ms.
- Same-key warm weather: warm status 200 and 4/4 measured status 200; measured latency p50 72.881 ms, p95/max 80.098 ms. The companion single HTML request returned 200 in 76.126 ms.
