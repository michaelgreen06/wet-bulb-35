# All-location city enrichment: priority and indexing plan

**Status: proposal only.** This page prioritizes data and validation for the 130,686 canonical city routes; it does not authorize source downloads, indexing submissions, route changes, PR merge, or deployment. The existing Popular-40 climate module is not the Top 50: 24 Top-50 routes are in that 40-city set. All-city forecasts and the population sidecar are separate products, not evidence that all pages have server-rendered climate context.

## Decision

Do not copy the Popular-40 record or template 130,686 times merely to change page text. Pursue a useful, source-backed **universal baseline** where data is valid, while fixing discovery and identity issues and measuring indexing with fixed cohorts. An enrichment rollout is a hypothesis to test, not a promise that Google will index every page. Keep a page when a source fact is unavailable, but omit unsupported facts rather than fabricate them.

## Priority 0 — make the existing inventory crawlable and trustworthy

1. Preserve each published canonical route and its historical identity. Join a pinned GeoNames record by stable ID; reconcile the remaining ambiguous/unmatched routes without deleting them. Keep existing sitemaps, renderer paths, canonicals, and one-hop redirects consistent; remove avoidable duplicate forms only through separately reviewed changes.
2. Ensure important city pages have crawlable HTML `<a href>` paths from the alphabetical country/region directories or relevant nearby links, including on mobile. Audit a representative sample of unknown, discovered-not-indexed, crawled-not-indexed, indexed, and Google-selected-alternate-canonical URLs in Search Console. A sitemap alone does not guarantee discovery or indexing.
3. Verify fast `200` city HTML, indexability, truthful canonical, one distinct location identity, accessible page text before JavaScript, and no weather-provider fetch on crawl. Do not force a new sitemap submission, synthetic `lastmod`, or arbitrary internal-link reshuffle.

## Priority 1 — lowest-cost, useful universal data, server-rendered

Order within this tier is about user value and safe scalability, **not** an SEO ranking guarantee:

1. **Verified place identity and context:** human-readable city, country and region; an unambiguous admin2/county label only where necessary; IANA timezone; and approximate point elevation only when the pinned GeoNames value is valid. Keep GeoNames ID and ISO/admin codes in the provenance/lookup, not as promotional page copy. Preserve existing page URL and geographic hierarchy.
2. **Local climate class:** a reviewed 1991–2020 Köppen-Geiger center class and plain-English meaning. Publish only where the raster cell is valid and the documented neighborhood-agreement gate passes; otherwise mark it unavailable or boundary-sensitive. This is climate context, not a wet-bulb danger rating.
3. **Wet-bulb seasonality:** the already piloted NASA POWER 1991–2020 modeled monthly mean wet-bulb values, peak month(s), and a compact accessible table/graphic, only where the source response, coordinate, period, units, and grid-quality checks pass. Label its coarse modeled grid and local-solar-time basis. Values shared by nearby cities are shared model-cell estimates—not independent city measurements or guaranteed unique content. Fetch/cache by actual source cell when scaling; never one provider call per page render.
4. **Source and interpretation note:** short readable description of the formula/dataset/period, what the figures mean, and the key coast/terrain/urban limitations, adjacent to the values. Write from tested conditional templates and real data, not per-city AI filler. Reuse the current accessible source-note placement.

Do not show `null` as zero. Identity, timezone and elevation alone are small contextual improvements, not a sufficient reason for Google to index otherwise thin pages; the useful seasonal wet-bulb interpretation is the main new reader value in this tier. One compact derived record per verified canonical identity, or an explicit unavailable reason, must be reproducible from pinned source versions. Keep raw downloads and private quality reports out of Git.

## Priority 2 — richer data after a bounded, representative pilot

- Same-cell, simultaneous-hour ERA5-Land wet-bulb distributions, seasonal percentiles and threshold frequencies, with full-period completeness and coast/terrain review. This adds more direct humid-heat value than generic geography, but the cost and quality gates are much higher than Priority 1.
- GHSL urban-centre context, coastal distance and other geographic comparisons only when the matched city/metro definition is defensible. Do not silently substitute urban-area population for municipal population or describe a grid cell as an entire city.
- Useful links between genuinely relevant places only after testing identity, link integrity, and reader value; ordinary directory order remains alphabetical. The existing nearby links should be audited before adding another link system.

## Priority 3 — historical calendar-day extrema and optional facts

366 month/day modeled-high entries require complete local-day hourly series, pinned upstream chunks, leap/DST and coastline handling, source-cell **plus timezone** grouping, disclosure of ERA5-Land period and grid distance, bounded asset sizes, and a local-midnight refresh. The current 10-city private research periods are not publication-ready. They must not be used as an easy way to make many thin pages look different. Station records, trends, or health/danger claims are separate reviewed products; do not mix station observations with modeled highs.

## Rollout and measurement gates

1. Freeze the current canonical inventory and a stable-ID join; quantify unmatched/ambiguous records and actual reuse of climate grid cells. Benchmark input retrieval/terms, shard sizes, parsed Worker memory, build time, and storage *before* forecasting all-location cost. Keep provider access offline and rate bounded.
2. Validate the existing Popular pilot against a geographically and climatically diverse set, including coast/islands, mountains, tropics, cold areas, namesakes, missing-admin places and already indexed/unindexed pages. Complete the missing Top-50 baseline records where validated, but do not require a vanity `50/50` if the data cannot support a field.
3. Add a fixed, matched treatment/control cohort outside the already promoted Popular/Top-50 pages. Record a private pre-change Search Console snapshot (including known/discovered/crawled/indexed states and Google-selected canonicals), then stage a bounded Priority-1 expansion. Test full-route accounting, provenance, accessibility, mobile, HTML rendering, and no redirects/sitemap drift; compare index and impression changes over sufficiently delayed windows with controls. Popularity, link prominence, page age and prior crawls can confound an observed lift.
4. If quality and measured outcomes justify it, expand in reviewable batches to all valid routes. At every batch require exactly one output or unavailable reason per canonical route, no unjustified duplicate model-cell prose, zero route loss, bounded asset/runtime memory, and explicit approval for production. Do not equate passing tests with Google indexing every route.

**SEO basis:** Google says crawl demand depends in part on content quality, relevance and popularity, that not every crawled page is indexed, that important pages need crawlable internal links, and that mass-produced pages without additional value risk scaled-content abuse. See Google Search Central: [crawl budget](https://developers.google.com/crawling/docs/crawl-budget), [link best practices](https://developers.google.com/search/docs/crawling-indexing/links-crawlable), [helpful content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content), and [spam policies](https://developers.google.com/search/docs/essentials/spam-policies).
