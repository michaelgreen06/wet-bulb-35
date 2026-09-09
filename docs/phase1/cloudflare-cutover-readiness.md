# Cloudflare cutover-readiness audit

Captured 2026-09-09 with `scripts/capture-cloudflare-cutover-readiness.py`. The capture uses authenticated Cloudflare **GET** inventory calls and the repository-installed Wrangler only; it does not fetch weather, tail logs, or change Cloudflare. Sanitized facts are in `evidence/cloudflare-cutover-readiness.json`.

## Decision matrix

| Area | Read-only result | Decision / blocker |
| --- | --- | --- |
| Production route safety | Zone Worker-route inventory is **0**. Account custom-domain inventory is **0**. | Safe baseline; no production Worker target exists. Do not create one before approval. |
| Staging identity | `wetbulb35-weather-staging`; 9 deployment records, active newest version `dec4cf15-c5c0-4fd9-9701-0f478a181330`; secret names: `OPENWEATHER_API_KEY` only. | Staging is reachable and separately versioned. The historical final candidate `fe629b5a-08f8-4b28-bc4e-185f04dfe93e` remains retained in the deployment list. |
| Persisted Workers Logs | Staging config sets observability/logs enabled, `persist=true`, `invocation_logs=false`, and `redact_query_string=true`; Workers Logs is available on Free and Paid plans. Workers Logs stores custom logs and, unless disabled, invocation logs.[1] | **Configured, but account query access is blocked:** GET list-saved-queries returned 403. The intended setting disables persisted invocation events; custom fixed-field `console.log` events remain eligible. Cloudflare documents redaction as removing query strings from request URLs in logs/traces, so it is a persisted-observability control—not proof that raw live-tail envelopes are safe. Keep the sanitizer-only tail rule. Confirm dashboard/query permission and retention before cutover. |
| Logs retention | Cloudflare documents 3 days on Free and 7 days on Paid; the generic maximum is 7 days.[1] | **Plan-dependent blocker:** account plan/actual retention was not exposed by this token. Select retention/owner and export policy before production. |
| Alerts | One existing policy: `billing_budget_alert`. Available alert catalog includes `Workers Observability` with `workers_observability_alert`; no policy exists for it. | A built-in Workers Observability alert can be configured by an authorized owner. The notification API is type-driven, not an arbitrary application-event/log-message trigger; the fixed `weather_provider_call` and cache fields cannot directly create custom Notifications events.[4] **Blocker:** approve an alert threshold/recipient, or send application events to an owned external alerting system. |
| Workers metrics | Workers metrics and zone Workers analytics exist; metrics use GraphQL and retain up to three months, zone analytics up to 30 days.[2] | **Access unverified:** no GraphQL metrics query was made and observability query-list access is 403. Assign/read-test Workers Analytics/GraphQL capability before production. |
| Durable Objects | Namespace inventory reports **1** namespace. The staging Worker declares one SQLite `WeatherGate` migration. Durable Objects bill compute duration and storage; Free limits reset daily and Paid has metered overages.[5] | **Cost visibility unresolved:** token can inventory namespaces but did not expose account plan, billable usage, or budget view. The current budget alert is account-wide only. Owner must inspect product/billable-usage view and set a cost guard before scaling traffic. |
| Routing / rollback | Cloudflare supports `workers.dev`, routes, and custom domains; a custom domain makes the Worker its subdomain origin.[6] Cloudflare retains rollback choices among the 100 most recent published versions.[7] | Route/custom-domain APIs are available and currently empty. Existing staging versions are a rollback source, but no production version exists yet. A rollback creates a new deployment and does not roll back bindings/resources.[7] |
| Vercel rollback readiness | Last retained Vercel capture: production deployment `dpl_98CXao2fnVfTWFmn8AxFeuNSnUXe` was `READY`, with five production aliases and 36 listed deployments; environment values remain external and one sensitive value is unrecoverable from Vercel CLI. | **Retained evidence only:** Vercel CLI is not installed on this host, so it was not refreshed. Install/authenticate an approved installed CLI, then rerun `capture-vercel-recovery-baseline.sh`; do not use `npx`. |
| HSTS | Zone `security_header.strict_transport_security.enabled=false`; the production parity capture contains HSTS. Zone setting reads expose this configuration.[8] | **Unresolved cutover contract:** do not assume the current Vercel-delivered HSTS header follows a Worker. Choose Worker response header or approved zone rule, then verify on the custom domain. |
| Email obfuscation | Zone `email_obfuscation=on`; existing production HTML difference is the decoder markup. | **Zone-managed expected at cutover:** retain application HTML unchanged. Verify that the intended Worker attachment still receives the transform; do not make `workers.dev` imitate it. |
| Managed robots | Production `robots.txt` difference is consistent with Cloudflare-managed robots/content signals. Managed robots prepends to an existing robots file.[9] | **Zone-managed expected at cutover:** preserve the committed robots policy and verify the custom domain result. API permission to inspect rulesets was 403. |
| Cache | Zone reads: `browser_cache_ttl=14400`, `cache_level=aggressive`, `edge_cache_ttl=7200`; production assets/robots show 14,400-second browser cache behavior. | **Zone-managed expected at cutover, verify:** a Worker response/cache rule interaction is not proven by this account token; cache-rules/rulesets access is 403. Keep application HTML policy exact and verify all response classes after attachment. |
| CORS / content-disposition | Production has CORS and Vercel-style content-disposition headers; staging does not. Cloudflare can add CORS through a Worker, Snippet, or Response Header Transform Rule.[10][11] | **Unresolved delivery contract:** no readable response-transform inventory and neither behavior is a Worker custom-domain default. Decide whether to reproduce each header in the Worker or via approved transform rule. |

## Bounded parity classification (0/14 passed)

The parity gate remains intentionally red. It has not normalized these fields away.

| Sample | Difference(s) | Ownership classification | Cutover action |
| --- | --- | --- | --- |
| home | email decoder markup; CORS/content-disposition/HSTS | email: zone-managed expected; headers: unresolved | Preserve app HTML; decide/recheck headers. |
| browse | email decoder markup; CORS/content-disposition/HSTS | email: zone-managed expected; headers: unresolved | Same. |
| country | email decoder markup; CORS/content-disposition/HSTS | email: zone-managed expected; headers: unresolved | Same. |
| state | email decoder markup; CORS/content-disposition/HSTS | email: zone-managed expected; headers: unresolved | Same. |
| unique city | email decoder markup; CORS/content-disposition/HSTS | email: zone-managed expected; headers: unresolved | Same. |
| colliding city | email decoder markup; CORS/content-disposition/HSTS | email: zone-managed expected; headers: unresolved | Same. |
| slashful city | email decoder markup; CORS/content-disposition/HSTS | email: zone-managed expected; headers: unresolved | Same. |
| slashless city | email decoder markup; CORS/content-disposition/HSTS | email: zone-managed expected; headers: unresolved | Same. |
| HEAD city | CORS/content-disposition/HSTS | unresolved | Decide/recheck headers. |
| 404 | missing `text/html`, cache policy, and comparable HTML semantics; HSTS | application-owned defect; HSTS unresolved | Fix 404 response before cutover; then decide HSTS. |
| robots | managed robots body; 14,400-second cache; CORS/HSTS | body/cache: zone-managed expected; headers: unresolved | Verify final domain policy/headers. |
| sitemap index | CORS/content-disposition/HSTS | unresolved | Decide/recheck headers. |
| sitemap member | CORS/content-disposition/HSTS | unresolved | Decide/recheck headers. |
| favicon | 14,400-second cache; CORS/content-disposition/HSTS | cache: zone-managed expected; headers: unresolved | Verify cache; decide/recheck headers. |

No difference is classified `workers.dev-only`: `workers.dev` isolation explains why the zone transforms are absent, but it does not make a production contract optional. The 404 defect remains application-owned and must not be normalized away.

## Documentation basis

Workers Logs stores account data, supports custom and invocation logs, and documents plan-specific retention; disabling `invocation_logs` suppresses the invocation-log category.[1]
Workers metrics are GraphQL-backed, while zone Workers analytics is scoped to routes on that zone.[2]
The Workers Observability API exposes saved-query, query, and live-tail endpoints, so a 403 to the saved-query inventory is a permission gap rather than proof that no logs exist.[3]
Cloudflare Notifications policies select from supported alert types, rather than accepting arbitrary application log events.[4]
A custom domain points directly to a Worker, and its rollback set is limited to the 100 most-recent published versions.[6][7]
Managed robots can prepend Cloudflare policy to an existing robots file, and response transforms can alter visitor response headers.[9][10]
Durable Objects have separate compute and storage billing dimensions, so namespace presence alone cannot establish cost readiness.[5]
Zone settings expose cache, email-obfuscation, and HSTS configuration, but a custom-domain response must still be tested after attachment.[8]
CORS headers may be added at the origin, in a Worker, a Snippet, or a response transform; the present owner choice is therefore an explicit cutover decision.[11]

## Re-run

```bash
set -a
. /home/laclaw/.hermes/.env
set +a
python3 scripts/capture-cloudflare-cutover-readiness.py
```

The script requires the installed repository Wrangler and never downloads a CLI. It saves only its allowlisted JSON evidence.

## Sources

[1] Cloudflare, [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs)

[2] Cloudflare, [Workers metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics)

[3] Cloudflare, [Workers Observability telemetry API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry)

[4] Cloudflare, [Notification policies API](https://developers.cloudflare.com/api/resources/alerting/subresources/policies)

[5] Cloudflare, [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing)

[6] Cloudflare, [Workers routes and domains](https://developers.cloudflare.com/workers/configuration/routing)

[7] Cloudflare, [Workers rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks)

[8] Cloudflare, [Get zone setting API](https://developers.cloudflare.com/api/resources/zones/subresources/settings/methods/get)

[9] Cloudflare, [Managed robots.txt](https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt)

[10] Cloudflare, [Response Header Transform Rules](https://developers.cloudflare.com/rules/transform/response-header-modification)

[11] Cloudflare, [CORS](https://developers.cloudflare.com/cache/cache-security/cors)
