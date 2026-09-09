# Phase 1 staging parity gate

Run the bounded live comparison with:

```bash
npm run check:staging-parity
```

The command compares Vercel production (`https://www.wetbulb35.com`) with the isolated Workers staging hostname. Override either source only deliberately:

```bash
node scripts/staging-parity-gate.mjs --production=https://www.wetbulb35.com --staging=https://wetbulb35-weather-staging.mgdevstuff.workers.dev --evidence=docs/phase1/evidence/staging-parity-gate.json
```

It makes exactly the declared representative GET/HEAD requests for home, browse, country, state, a unique city, a collision-safe city, slashful/slashless city paths, 404, `robots.txt`, sitemap index/member, and favicon. It never requests `/api/weather` from either origin; the helper rejects that path before networking.

The evidence also records the intentional **internal** HTML Cache API contract (schema 1; 86,400-second fresh, 604,800-second stale, 691,200-second storage TTL) so it can be audited without treating it as a browser header change. Browser HTML remains `Cache-Control: public, max-age=0, must-revalidate`, and `Cache-Control` remains compared exactly. The harness does not normalize Cloudflare email-obfuscation markup or zone/Vercel header transformations: those remain visible differences, while real status, content type, SEO, canonical, JSON-LD, links, and widget-coordinate defects still fail the gate.

The same run validates the complete local 130,684-city source route inventory, collision-safe uniqueness, generated metadata manifest count, every locally committed sitemap-index member, the robots sitemap directive, and copied public asset inventory. It does not turn that offline check into 130,684 remote requests.

Evidence is concise JSON: it excludes raw headers, response bodies, secrets, and weather data. Failure is intentional when a parity difference exists: inspect the named fields rather than treating a nonzero exit as a harness error.

## Recorded gate result

The recorded run completed all 14 bounded requests without `/api/weather`, and the offline inventory passed: **130,684** rows, **130,684** unique collision-safe city routes, **227** sitemap members, and **238** committed public files. Remote parity is intentionally red in the current staging state (0/14): production has provider-injected email-decoder markup that staging does not, plus remaining delivery-header differences listed below.

- HTML and `HEAD`: the browser `Cache-Control: public, max-age=0, must-revalidate` now matches. Production's `Access-Control-Allow-Origin: *`, `Strict-Transport-Security: max-age=63072000`, and Vercel content-disposition remain absent in isolated staging; HTML semantic fields also remain different because production has provider-injected email-decoder markup.
- 404: staging has no media type or comparable cache/HSTS headers; production is `text/html` with the baseline cache policy.
- `robots.txt` and favicon: staging keeps `public, max-age=0, must-revalidate`; production uses `public, max-age=14400, must-revalidate`. Production also supplies CORS/HSTS and favicon content-disposition.
- Sitemap index/member bodies and media types match; staging lacks production CORS/HSTS/content-disposition. Robots body differs because production includes Cloudflare-managed policy beyond the committed file.

The latest bounded three-sample median was 64.97 ms for production and 30.89 ms for staging. These values are observations, not a performance commitment.

## Cache policy / scope

Michael approved **24 hours fresh** and **7 days stale**. The renderer now implements that policy as an internal schema-validated Cache API envelope with an explicit eight-day storage TTL and deployment-versioned namespace. It deliberately preserves browser HTML `Cache-Control: public, max-age=0, must-revalidate`; the policy record is evidence, not permission to ignore browser/header or email-transformation differences.

## Cached-renderer staging deployment

The corrected cache implementation was deployed only to `wetbulb35-weather-staging.mgdevstuff.workers.dev` as Cloudflare version `d1093b5f-bb6f-4776-8f3f-e4504828cd91`. Wrangler reported **5 ms** Worker startup and the `CF_VERSION_METADATA` binding. No custom-domain or production-zone Worker route exists.

Post-deployment checks passed: slashful/query variants returned byte-identical HTML with the browser parity cache header; `HEAD` returned the same status/header with no body; private metadata returned `404`; and one bounded live-weather smoke returned the established payload and private/no-store header. The staging secret remained present. The first and repeated HTML requests completed in 228.643 ms and 85.377 ms respectively, but latency alone does not prove Cache API residency. Direct cache-outcome verification remains part of the next observability gate.

## Startup and latency interpretation

The gate records three bounded end-to-end samples per origin; these are network measurements, not a Cloudflare startup metric. Final isolated weather-staging version `fe629b5a-08f8-4b28-bc4e-185f04dfe93e` reported **6 ms** Worker startup; the earlier renderer-only deployment also reported **6 ms** (documented in `hono-renderer-parity.md`). Local Wrangler readiness is explicitly not the Cloudflare one-second script-startup gate.
