# Phase 1 staging parity gate

Run the bounded live comparison with:

```bash
npm run check:staging-parity
```

The command compares Vercel production (`https://www.wetbulb35.com`) with the isolated Workers staging hostname. Override either source only deliberately:

```bash
node scripts/staging-parity-gate.mjs --production=https://www.wetbulb35.com --staging=https://wetbulb35-weather-staging.mgdevstuff.workers.dev --evidence=docs/phase1/evidence/staging-parity-gate.json
```

It makes exactly the declared representative GET/HEAD requests for home, browse, country, state, a unique city, a collision-safe city, slashful/slashless city paths, negotiated HTML/JSON/plaintext 404s, `robots.txt`, sitemap index/member, and favicon. It never requests `/api/weather` from either origin; the helper rejects that path before networking.

The review follow-up expands the matrix to 19 checks: it also fetches `/assets/app.css`, `/assets/app.js`, and `/assets/locations.json`, comparing their complete content hashes and lengths. HTML comparison includes external script references, so dropping the browser runtime is a failure even when SEO fields match. Browser assets receive no footer-year normalization. Each origin also receives the existing three latency samples. The 8/16 result below is historical evidence from the earlier matrix, not a result for the expanded gate; re-run after deploying the reviewed candidate.

The evidence also records the intentional **internal** HTML Cache API contract (schema 1; 86,400-second fresh, 604,800-second stale, 691,200-second storage TTL) so it can be audited without treating it as a browser header change. Browser HTML remains `Cache-Control: public, max-age=0, must-revalidate`, and `Cache-Control` remains compared exactly. Classified expected differences: the known Cloudflare-managed `robots.txt` body prefix; zone-injected markup that `workers.dev` bypasses (email obfuscation under `/cdn-cgi/` and the Web Analytics beacon from `static.cloudflareinsights.com`), which is dropped from link and asset comparison; `application/javascript` and `text/javascript` are treated as the same media type; and, until Vercel rebuilds with the Tailwind scanning fix, a production `app.css` that differs only by lacking `.relative{position:relative}` (remove this exception after that deploy). All other status, media type, stable delivery headers, SEO, canonical, JSON-LD, links, and widget-coordinate differences fail the gate.

## 404 platform boundary

Production's Vercel-generated HTML/plaintext 404 includes a request ID and provider branding; its HTML can also include provider analytics. The Worker preserves the stable contract instead: status `404`, cache/HSTS headers, Accept-selected HTML/JSON/plaintext media type, JSON `{ "error": { "code": "404", "message": "The page could not be found" } }`, and equivalent plaintext message/code. It deliberately omits Vercel request IDs, branding, and analytics. The parity gate compares that stable contract, not provider-specific 404 markup or Vercel-only headers.

The same run validates the complete local 130,684-city source route inventory, collision-safe uniqueness, generated metadata manifest count, every locally committed sitemap-index member, the robots sitemap directive, and copied public asset inventory. It does not turn that offline check into 130,684 remote requests.

Evidence is concise JSON: it excludes raw headers, response bodies, secrets, and weather data. Failure is intentional when a parity difference exists: inspect the named fields rather than treating a nonzero exit as a harness error.

## Recorded gate result

**2026-09-10 (expanded 19-check gate):** 19/19 pass against staging version `63b6ffba` (built with the public Places key). Expected differences recorded: `robots` body prefix and the pending `.relative` CSS rule. Three-sample medians: production 147.93 ms, staging 43.6 ms.

### Earlier 16-check record

The recorded run completed all 16 bounded requests without `/api/weather`, and the offline inventory passed: **130,684** rows, **130,684** unique collision-safe city routes, **227** sitemap members, and **238** committed public files. Eight checks pass and eight remain red solely because production has provider-injected email-decoder markup that `workers.dev` does not.

- All recognized HTML delivery headers now match. The eight GET HTML samples remain red because the production zone injects email-decoder markup; `HEAD` passes.
- HTML, JSON, and plaintext 404 contracts pass without copying Vercel request IDs, branding, or analytics.
- `robots.txt`, sitemap index/member, and favicon delivery contracts pass. The robots body prefix is recorded as an exact expected zone-managed difference rather than copied into the application.

The latest bounded three-sample median was 77.36 ms for production and 55.85 ms for staging. These values are observations, not a performance commitment.

## Cache policy / scope

Michael approved **24 hours fresh** and **7 days stale**. The renderer now implements that policy as an internal schema-validated Cache API envelope with an explicit eight-day storage TTL and deployment-versioned namespace. It deliberately preserves browser HTML `Cache-Control: public, max-age=0, must-revalidate`; the policy record is evidence, not permission to ignore browser/header or email-transformation differences.

## Cached-renderer staging deployment

The corrected cache implementation was deployed only to `wetbulb35-weather-staging.mgdevstuff.workers.dev` as Cloudflare version `d1093b5f-bb6f-4776-8f3f-e4504828cd91`. Wrangler reported **5 ms** Worker startup and the `CF_VERSION_METADATA` binding. No custom-domain or production-zone Worker route exists.

Post-deployment checks passed: slashful/query variants returned byte-identical HTML with the browser parity cache header; `HEAD` returned the same status/header with no body; private metadata returned `404`; and one bounded live-weather smoke returned the established payload and private/no-store header. The staging secret remained present. The first and repeated HTML requests completed in 228.643 ms and 85.377 ms respectively, but latency alone does not prove Cache API residency. Direct cache-outcome verification remains part of the next observability gate.

## Startup and latency interpretation

The gate records three bounded end-to-end samples per origin; these are network measurements, not a Cloudflare startup metric. Current isolated weather-staging version `0f11f222-c122-4c11-801d-410fb592e553` reported **7 ms** Worker startup; the earlier renderer-only deployment reported **6 ms** (documented in `hono-renderer-parity.md`). Local Wrangler readiness is explicitly not the Cloudflare one-second script-startup gate.
