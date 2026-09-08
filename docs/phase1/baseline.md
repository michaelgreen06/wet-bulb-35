# Phase 1.1 production baseline

**Scope:** inventory only. This records the production and source state at commit `f6acf975b57d3352cfaaa45db3164e5389ea2c3a`; it does not approve a migration or SEO change. The bounded, no-JavaScript production capture is in [`captures/manifest.json`](captures/manifest.json). It made nine HTTPS GET requests on 2026-09-08 UTC, did not request `/api/weather`, did not run JavaScript, and did not fetch child sitemaps or linked AI-instruction files.

## Architecture and delivery

- The repository is a Next.js 15 / React 19 application with Tailwind tooling, but `vercel.json` deploys through `npm run vercel-build`, not `next build`.
- `scripts/build-vercel-output.mjs` creates Vercel Build Output v3: static site output generated from `scripts/resolved_cities.json`, plus one Node.js 22 serverless function at `/api/weather`.
- The static generator emits crawlable HTML, CSS, `/assets/app.js`, and a locations search data asset. The HTML includes route metadata and breadcrumbs before JavaScript runs.
- Production is served on the canonical `https://www.wetbulb35.com` host through Cloudflare and Vercel. The previous live audit observed HTTP-to-HTTPS and apex-to-`www` 308 redirects. The nine bounded captures request only the canonical HTTPS host, so they do not independently revalidate that redirect chain.
- Vercel's `ignoreCommand` examines deployment inputs and skips builds for changes outside them unless `FORCE_VERCEL_BUILD` is set. Documentation/capture changes are not listed deployment inputs.

### Verified Vercel account baseline

- Vercel scope: `michaels-projects-899a0e11`. The linked project is `wetbulb2` (`prj_5MhIySYFwcqz6P5N0HhCL8s0ZsuZ`), configured with Framework **Other**, root directory `.`, Node.js **22.x**, install command `npm ci`, and build command `npm run vercel-build`.
- Current production deployment: `dpl_98CXao2fnVfTWFmn8AxFeuNSnUXe`, from `f6acf975...`, at `https://wetbulb2-nc0ku4gtp-michaels-projects-899a0e11.vercel.app`. Its aliases include both wetbulb35 hosts and `wetbulb2.vercel.app`.
- The project has one Node.js 22 function: `/api/weather` in `iad1`, configured for 1,024 MB and 10 seconds.
- Environment variables recorded by name and scope only: `OPENWEATHER_API_KEY` is a secret in Production; `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_GOOGLE_PLACES_API_KEY`, and `NEXT_PUBLIC_OPENWEATHER_API_KEY` are configuration variables in Production, Preview, and Development. `NEXT_PUBLIC_OPENWEATHER_API_KEY` is an existing exposure risk, not approved remediation.
- The domain is third-party-managed from Vercel's view. There are 34 retained/listed deployments; the latest production deployment is `f6acf97`, and the latest READY preview is commit `128e19c` on `integration/inhabited-hotspots-preview`.
- Vercel CLI usage returned `Costs not found` (404). Request/function metrics require Observability Plus. The Vercel Web Analytics query returned no data.

## Routes and representative behavior

| Page type | Captured path | Status | Server-visible baseline |
|---|---|---:|---|
| Homepage | `/` | 200 | Title and H1: `Current Wet Bulb Temperature`; canonical `/`; empty weather card waits for location/weather. |
| Location directory | `/wetbulb-temperature` | 200 | `Wet Bulb Temperature by Country`; country links/counts are in HTML; canonical has a trailing slash. |
| Country | `/wetbulb-temperature/united-states` | 200 | United States state/province directory in HTML; canonical has a trailing slash. |
| State | `/wetbulb-temperature/united-states/texas` | 200 | Texas city directory in HTML; canonical has a trailing slash. |
| City | `/wetbulb-temperature/united-states/alabama/birmingham` | 200 | Birmingham location/coordinates and empty weather widget are in HTML; dynamic observations require client behavior. |
| Sitemap-listed missing route | `/about` | 404 | Vercel `404: NOT_FOUND` response; no canonical or robots metadata found. |
| Unknown root route | `/not-a-real-page-9b1e3d` | 404 | Same platform 404 class and missing SEO metadata. |
| Robots | `/robots.txt` | 200 | Cloudflare managed AI/content-signal section precedes the repository policy. |
| Sitemap index | `/sitemap.xml` | 200 | XML sitemap index only; child sitemap bodies were intentionally not captured. |

All captured successful HTML routes have `meta robots="index, follow"`. The route-specific title/canonical changes by route, but the captured H1 remains `Current Wet Bulb Temperature`. The prior live audit found Open Graph, Twitter, Google Analytics `G-LNPWV0JL7S`, Cloudflare email decoding/Insights, and `BreadcrumbList` JSON-LD; it did not find WeatherForecast, Place, WebPage, or FAQ schema.

## SEO, sitemap, and robots inventory

- `public/sitemap.xml` has **227** sitemap members: the main sitemap, category sitemap, and country sitemap entries.
- The repository has **228** child sitemap files under `public/sitemaps/` (226 country files, including an additional United States part, plus main and categories).
- `sitemap-main.xml` has **3** URLs: `/`, `/about`, and `/wetbulb-temperature`. `/about` is therefore advertised while its production capture is a 404.
- `sitemap-categories.xml` has **3,749** URLs for country/state routes. Country sitemap files carry city routes; generation caps a country file at **9,999** URLs.
- The current captured robots response combines Cloudflare-managed policy (`Content-Signal: search=yes,ai-train=no,use=reference` and named AI-agent disallows) with the checked-in policy. It allows the site and sitemap paths, disallows legacy API/location sitemap URLs, and contains `Sitemap: https://www.wetbulb35.com/sitemap.xml`.
- The prior audit saw trailing-slash canonical URLs while the no-slash directory requests returned 200. This duplicate-200/canonical-slash behavior is preserved as a baseline defect.

## Weather and client/API flow

- Static HTML fetches do not call the weather API. The homepage has no server-rendered coordinates; city HTML has coordinates but the raw capture did not execute JavaScript.
- `/assets/app.js` loads local location data for directory search. Google Places is loaded only after explicit search interaction, not initial render.
- On city pages, browser JavaScript reads weather-widget latitude/longitude and requests `GET /api/weather?lat=...&lon=...`; current-location use follows geolocation approval. The client renders provider data and calculates a Stull wet-bulb fallback if `weather.wetBulb` is absent.
- The generated `/api/weather` function accepts GET only, returns 204 for known bot-like user agents, validates coordinates, and calls OpenWeather's current-weather endpoint using `OPENWEATHER_API_KEY` or `NEXT_PUBLIC_OPENWEATHER_API_KEY`. Successful API responses are `private, no-store, no-cache, max-age=0, must-revalidate`.
- No `/api/weather`, geolocation, Google Places, or OpenWeather request was made for this baseline. The API key value and production provider configuration were not inspected.

## Redirects, errors, and caching

- The prior live audit recorded `http://wetbulb35.com/` → HTTPS apex → HTTPS `www` as two 308 redirects, and HTTPS apex → HTTPS `www` as one 308 redirect. It also recorded plaintext redirect bodies with `Location` and `Refresh` headers.
- Captured HTML uses `Cache-Control: public, max-age=0, must-revalidate`; successful sampled HTML was Vercel `HIT`. The city route had previously been seen as a Vercel `MISS`, consistent with static/ISR cache population behavior.
- The captured sitemap is `application/xml` and Vercel `HIT`; robots is `text/plain; charset=utf-8`, Vercel `HIT`, and cached for four hours. 404s are Vercel `NOT_FOUND` pages with `public, max-age=0, must-revalidate`, no canonical, no robots directive, and no structured data.

## Static scale and Cloudflare constraints

- `scripts/resolved_cities.json` has **130,684** rows and is **19,923,105** bytes. The Vercel-output generator's production limit is 130,684, so any full static rebuild materializes the complete route corpus rather than a small sample.
- Sitemap generation loads the full JSON repeatedly for country/state counting and streams it for individual country sitemap writes. It serializes country sitemap jobs in batches of 10 and index work in batches of 50; these are source-level memory/concurrency controls, not confirmed provider limits.
- Cloudflare is demonstrably in the delivery path and injects/manages part of `robots.txt`. Do not assume a repository change fully controls edge behavior. Cache rules, WAF/bot controls, Workers, zones, DNS, plan quotas, purge permissions, observability, and Cloudflare account-level limits are **unknown** until authenticated account inspection.
- At the current [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/), the predicted complete static output of **134,676 files** exceeds the Paid static-asset cap of 100,000 files by **34,676**. The **19.9 MB** resolved-cities dataset is below the 64 MiB Worker size limit, and the **17.9 MB** generated locations search index is below the 25 MiB individual static-asset limit. Parsing, heap, and CPU behavior still require benchmarking against the 128 MB isolate-memory limit. These figures do not imply that R2 is required.
- Do not broaden crawls or prewarm the 130k-page corpus during Phase 1.1. The raw captures are deliberately capped at nine allowlisted URLs; child sitemaps are excluded.

## Build, test, and security baseline

- Parent verification at baseline: `node --test tests/static-generator.test.mjs tests/vercel-ignore-build.test.mjs` passed **17/17**.
- `npm test` currently fails because Vitest treats the Node test files as empty and `components/SearchBox.tsx` has JSX syntax errors under that runner.
- `npm run build` currently fails on `components/SearchBox.tsx` JSX syntax errors.
- `npm audit` reported **18** vulnerabilities: 1 low, 5 moderate, 9 high, and 3 critical. This is an inventory result, not an approved dependency update.

## External dependencies

| Dependency | Observed role | Baseline handling |
|---|---|---|
| Vercel | Static Build Output, serverless weather function, deployment cache | Account/deployment baseline recorded above; request/function metrics remain unavailable without Observability Plus. |
| Cloudflare | Edge delivery, managed robots policy, Insights/email decode | Account configuration unavailable. |
| OpenWeather | Server-side weather current-conditions endpoint | Never called for this capture. |
| Google Maps Places | Search autocomplete after user interaction | Never loaded/called for this capture. |
| Google Analytics | Client analytics measurement `G-LNPWV0JL7S` | No analytics interaction performed. |

## Existing defects/behaviors: preserve unless explicitly approved

1. `/about` remains in the main sitemap but returns 404 in production.
2. Directory routes can return 200 with and without a trailing slash while canonicals select the slash form.
3. Platform 404 responses lack intentional HTML SEO/noindex/canonical/structured-data treatment.
4. The global H1 remains `Current Wet Bulb Temperature` even on directory/location pages.
5. Static crawlable delivery remains separate from the weather-provider call path; bot/webdriver safeguards that avoid weather requests must not be removed without explicit approval.
6. Do not alter Cloudflare-managed robots behavior or cache/security configuration from this repository baseline without authenticated account review and approval.

## Missing account and measurement data

The following account and measurement gaps remain:

- **Google Search Console:** the current Google session has no property access. Index coverage, canonical selection, sitemap processing, crawl stats, URL inspection, manual actions, and performance data are unverified.
- **Cloudflare account:** Wrangler is installed but unauthenticated. Zone/account identity, DNS, redirects, Cache Rules, WAF, bot management, Workers, rate limits, plan, analytics, purge history, and configuration ownership are unverified.
- **Vercel measurement:** costs were not returned by the CLI (`Costs not found`, 404); request/function metrics require Observability Plus, and the Web Analytics query returned no data.

## Capture contents and repeatability

`captures/manifest.json` records per response: UTC capture time, requested/final URL, final status, parsed redirect chain, body SHA-256, byte size, and relative header/body filenames. The 18 raw files are one `.headers.txt` and one `.body` for each of the nine allowlisted paths; the manifest is the nineteenth file.

Run `scripts/capture-phase1-baseline.sh` from a clean working tree to refresh this bounded set. It has a hard-coded nine-route allowlist, uses curl with no JavaScript, follows at most five redirects, excludes `/api/weather`, and does not request child sitemaps.
