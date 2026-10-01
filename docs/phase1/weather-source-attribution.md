# Diagnose weather-provider budget attribution (research PR)

A city-page HTML request is static and does **not** call OpenWeather. Its browser JavaScript reads the page's city coordinates and requests `/api/weather?lat=…&lon=…`; the Worker can then call OpenWeather on a miss or stale refresh. A provider key hash matching a city coordinate proves that the requested location is in the city inventory. It does **not** prove that the client loaded that city's page, rather than calling the API directly with the same coordinates.

This change only adds source diagnostics for **future** reservations. It does not change the page, API response, caching, provider, budget, routing, or bot policy. PR creation is not approval to merge or deploy. No past requester can be identified from these new fields.

## New application event

The Durable Object emits exactly one `weather_source_attribution` event when a provider attempt is reserved or denied by the global budget (not for an edge-cache hit or a still-fresh Durable Object entry). It includes the deployment version but **no city key or coordinate hash**, so network provenance is not joinable to a precise requested location. Fixed fields are:

- `source_state`: `reserved` or `budget_denied`; `cache_state`: `miss` or `stale_refresh`.
- `asn`: Cloudflare-provided ASN number, or `null`; `country`: two-character country code, or `null`.
- `ua_family`: `chrome`, `edge`, `firefox`, `safari`, `script`, or `other`; `ua_major`: bounded browser major number or `null`.
- `referrer_class`: `city_page`, `site_other`, `external`, `none`, or `invalid`. This is a **self-reported** Referer classification, not proof of a page visit or an authorization signal.
- `verified_bot`: Cloudflare Bot Management value when present; otherwise `null`. Do not interpret `null` as a human visitor.

Worker `request.cf.asn` and country are the only network provenance inputs. The ASN organization name, IP address, raw user agent, full Referer, paths, URLs, search text, coordinates, city names, credentials and upstream responses are **not** included. Source fields are normalized at ingress **and** revalidated before logging. Observability remains best-effort: a failed logger must not change weather responses or retry the provider. The existing `weather_provider_call` and `weather_budget_exhausted` schemas are unchanged; compare their aggregate counts by UTC interval, never join individual callers to location hashes.

Cloudflare's invocation envelopes may contain request metadata even when application events are safe. Never print or save raw query responses or run an unsanitized production tail. The repository's safe tail validator accepts this exact new schema but its command still targets **staging only**.

## Read-only audit after a separately approved deployment

Supply the existing project-scoped token **in a protected environment**, not as a CLI argument. Determine the account ID from the authenticated Wrangler account metadata. Query an exact, historical UTC window of at most six hours:

```sh
node scripts/audit-weather-source-events.mjs \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --start 2026-09-30T16:00:00Z --end 2026-09-30T17:00:00Z
```

The script requires `CLOUDFLARE_API_TOKEN` in its environment, makes only dry read-only telemetry queries, divides the range into at most one-hour requests, and refuses capped or incomplete results. It emits **aggregate counts only**: provider reservations versus budget denials, top ASN numbers and request counts, countries, coarse browser families, Referer classes and verified-bot states. It never outputs hashes, IPs, raw request metadata, user agents or location identifiers. Look up an ASN's owner separately when needed; Cloudflare's reported country/ASN and claimed browser family do not conclusively identify a crawler operator. Query promptly while the account's Worker Logs are retained.

## Release boundary

Run local unit/privacy suites and a Wrangler dry run, then test the diagnostic event on isolated staging without increasing the provider-call budget. A staging test does not authorize production. Before any production deployment, recheck the live Worker version, domain and backup-and-restore gate, obtain Michael's separate approval, and monitor the active version. This PR does **not** implement click gating, Turnstile, WAF rules, or a budget increase; those are separate UX and security decisions.
