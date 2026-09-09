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

For HTML it compares title, description, robots, canonical, Open Graph values, JSON-LD, links, widget coordinate attributes, and public asset references. Text/XML/assets compare a SHA-256 and byte count. It compares status, media type, and stable headers. Only POP/provider/request-varying delivery headers listed in the evidence are ignored; `Cache-Control` and content type remain comparable. The only body normalization is the documented footer-year token.

The same run validates the complete local 130,684-city source route inventory, collision-safe uniqueness, generated metadata manifest count, every locally committed sitemap-index member, the robots sitemap directive, and copied public asset inventory. It does not turn that offline check into 130,684 remote requests.

Evidence is concise JSON: it excludes raw headers, response bodies, secrets, and weather data. Failure is intentional when a parity difference exists: inspect the named fields rather than treating a nonzero exit as a harness error.

## Recorded gate result

The recorded run completed all 14 bounded requests without `/api/weather`, and the offline inventory passed: **130,684** rows, **130,684** unique collision-safe city routes, **227** sitemap members, and **238** committed public files. Remote parity is intentionally red in the current staging state (0/14): production has provider-injected email-decoder markup that staging does not, and the production delivery headers below are absent from the isolated worker responses.

- HTML and `HEAD`: `Cache-Control: public, max-age=0, must-revalidate`, `Access-Control-Allow-Origin: *`, `Strict-Transport-Security: max-age=63072000`, and Vercel content-disposition are absent in staging. No 24-hour/7-day replacement was selected or implemented.
- 404: staging has no media type or comparable cache/HSTS headers; production is `text/html` with the baseline cache policy.
- `robots.txt` and favicon: staging keeps `public, max-age=0, must-revalidate`; production uses `public, max-age=14400, must-revalidate`. Production also supplies CORS/HSTS and favicon content-disposition.
- Sitemap index/member bodies and media types match; staging lacks production CORS/HSTS/content-disposition. Robots body differs because production includes Cloudflare-managed policy beyond the committed file.

The bounded three-sample median was 81.34 ms for production and 31.95 ms for staging in the recorded run. These values are observations, not a performance commitment.

## Cache policy / scope

Michael approved **24 hours fresh** and **7 days stale** for future HTML caching; caching is no longer approval-blocked and is the next serial task. This gate reports current header differences but does **not** implement cache behavior or select `Cache-Control` values. Any cache implementation remains a separately reviewed runtime change.

## Startup and latency interpretation

The gate records three bounded end-to-end samples per origin; these are network measurements, not a Cloudflare startup metric. The only currently recorded Cloudflare script-startup evidence is Wrangler's isolated staging deployment report of **6 ms** for `wetbulb35-hono-renderer-staging` (documented in `hono-renderer-parity.md`). Local Wrangler readiness is explicitly not the Cloudflare one-second script-startup gate.
