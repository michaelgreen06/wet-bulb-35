# Region-sharded location metadata: free-plan CPU candidate

**Scope:** Build-time metadata packaging and Worker lookup only. No canonical routes, page templates, weather/forecast APIs, production bindings, or sitemaps change. This candidate is not a production release.

## Measured baseline and candidate (2026-10-16)

From clean `origin/main` `bc1f1ca`, direct `node scripts/build-hono-renderer-assets.mjs` with a dummy Places key into a scratch directory took **29.49 s**, peak **957,436 KB**. It generated 225 country shards for 130,686 city routes, 66.48 MiB total; the largest (`united-states.json`) was 8.01 MiB. A fresh Node resolver load of the first state took 497 ms CPU for the US and 403 ms for France. These are local Node cold-path probes, **not Cloudflare Worker CPU measurements**.

The first candidate grouped identity rows once at build time and emitted one region shard per canonical state slug, each with its own local climate-cell table. Country and browse pages still used the manifest; state/city pages fetched only their region. The direct build took **28.06 s**, peak **870,228 KB**, producing 3,527 region shards (3,994 actual asset files). The first-state local Node resolver CPU was 75 ms for the US and 56 ms for France. An isolated Cloudflare staging deployment `00e3eb6b-fd8b-4ff4-836d-213cd1e47ec7` returned 200 for 76 distinct cold city URLs, but its first 93 recorded invocations had p50 **5.94 ms** and p99 **88.8 ms** CPU (0 resource errors). The large-region tail is too high to treat region splitting alone as sufficient.

The revised candidate retains a full region shard for directory pages and emits deterministic city-bucket shards only for regions with more than 96 cities. City pages fetch one bucket of at most 96 rows; state directories still fetch the complete region. Each shard has its own climate-cell table. The direct revised build took **29.28 s**, peak **914,420 KB**, producing **5,570 metadata shards** and **6,037 actual asset files**, below the **20,000 Workers Free asset limit**. The isolated staging deployment `a114926c-fba1-47af-9536-16e4725d34d3` returned **200 for all 118 sampled cold paths** (88 large-region city URLs, 20 small-region cities, 10 region directories) and all **400 additional distinct large-region city URLs**. Its first 540 Cloudflare invocation records had **0 exceededResources**, CPU p50 **3.85 ms**, CPU p99 **22.47 ms**. Those are hosted observations for a bounded sample, not a guarantee of zero future free-plan limit errors. The production Worker remains at `bd13754d-22f9-4256-8db8-86660637c9b5`.

## Large-region directory fix (2026-10-22)

Review found that directories of bucketed regions still loaded, indexed and rendered every city on a cold request. Local Node probes: `united-kingdom/england` (3,069 cities, 1.42 MB region shard) took 54–105 ms to resolve plus 37 ms to render; `germany/bavaria` 37–104 ms plus 27 ms. Most render time is per-card slug derivation, so a smaller JSON alone would not fix it.

Each of the 290 bucketed regions now also gets `<country>/<region>.directory.json`: its city cards pre-rendered at build time with the same card markup and city order the Worker uses (`renderStateCityCards`, `compareStateCities`). A cold directory page fetches only the manifest and that file. The Worker rejects a fragment whose version, region path, city count or card count differs from the manifest, or that exceeds the size bound. Small regions and city pages are unchanged. The real-data build has **6,327 actual asset files** (+290), below the 20,000 limit.

`tests/region-shards.test.mjs` checks byte-identical HTML and headers against the full-region render for a synthetic region with escaped and accented names, and for real England, Bavaria and Lombardy data. The tests also reject tampered fragments. Local cold England CPU after the fix is still variable, **10–61 ms** including local file reads. **Hosted CPU after this fix has not been measured; the 10 ms gate below is unsolved.**

## Gates

- Asset generation accounts for every one of 130,686 canonical routes and matches the immutable HTML goldens; country/region ordering, search index and sitemap route inventory remain unchanged.
- The versioned manifest identifies only bounded `<country>/<region>.json` paths; a shard or directory fragment claiming a different region fails closed.
- Weather and forecast are not called on SEO HTML requests. The isolated staging config has no production custom domain, route, provider secret, Durable Object or R2 binding. It cannot validate live weather/search parity.
- The staging config sets `workers_dev = false` and `preview_urls = false`. Wrangler enables workers.dev when the key is absent, and public staging endpoints were disabled after 16,911 unexpected quota-consuming requests. A test rejects the config if either key is missing. The staged Worker must not be made public before Cloudflare Access covers it.
- **Unsolved:** hosted cold CPU for the largest region directories and city buckets after the directory fix. Before any production decision, measure cold and warm crawler-like requests on an Access-protected staging Worker, compare Cloudflare `exceededResources` and CPU, and include the largest regions. If the cold path still breaches 10 ms, choose another safe targeted optimization rather than claiming this candidate is a fix.
- No merge or production deployment without Michael's separate approval and the current backup/release gates.
