# Phase 1 operational observability and bounded staging load

## Safety boundary

No deployment is performed by this change. The only configured Worker is the isolated `wetbulb35-weather-staging` workers.dev candidate; it has no route, DNS, custom-domain, or production-secret configuration in this repository.

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

This proves local syntax only. It does **not** prove that the Cloudflare account has Worker Logs query access, retention, permissions, billing eligibility, alert policies, Logpush destinations, or notification ownership. No alert is configured here. Before any staging deployment, an account owner must confirm those capabilities and create/assign alerts for provider failures and abnormal cache misses; production cutover remains blocked by those account decisions.

## Proposed staging procedure (not executed)

1. Michael explicitly authorized the existing public production OpenWeather key for this isolated staging Worker. It is already installed encrypted; never display, copy, or rotate it in this procedure. Confirm isolated staging logging, daily budget ownership, retention, and alerting. Do not use production DNS or routes.
2. Build and dry-run locally: `timeout 180s npm run dry-run:weather-edge`.
3. Deploy only after separate authorization: `npm run deploy:weather-staging`.
4. Tail only that Worker: `./node_modules/.bin/wrangler tail wetbulb35-weather-staging --format=json`.
5. Send one bot request, one invalid-coordinate request, one same-key weather warm request and one same-key repeat. Inspect only fixed JSON fields for `weather_bot_skip`, `weather_validation_failure`, `weather_cache_miss`, `weather_cache_hit`, and exactly one terminal provider event for the actual provider attempt. Do not paste request URLs, secrets, bodies, or provider errors into evidence.
6. Record the redacted event counts, terminal outcome, cache state, latency, and reserved budget used/limit. Stop well below 100 provider attempts.

## Bounded load harness

`npm run load:staging-safe` runs `scripts/staging-load-harness.mjs --mode=fake`: a local fake server, 24 HTML requests at concurrency 4, and a warm plus four same-key weather requests. It never contacts a provider and prints only JSON latency percentiles/status counts—never bodies or secrets.

`--mode=local` requires an explicit non-production origin and refuses `wetbulb35.com` hosts. `--mode=staging` requires both the exact isolated workers.dev hostname and `--allow-staging-weather=true`. `--weather-requests` counts measured weather requests; a nonzero value adds one warm request, so it is capped at 19 and total weather requests are capped at 20. `--weather-requests=0` is HTML-only mode and makes zero weather requests. Example (only after authorization):

```sh
node scripts/staging-load-harness.mjs --mode=staging \
  --origin=https://wetbulb35-weather-staging.mgdevstuff.workers.dev \
  --allow-staging-weather=true --weather-requests=4
```
