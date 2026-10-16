# Region-sharded location metadata: free-plan CPU candidate

**Scope:** Build-time metadata packaging and Worker lookup only. No canonical routes, page templates, weather/forecast APIs, production bindings, or sitemaps change. This candidate is not a production release.

## Measured baseline and candidate (2026-10-16)

From clean `origin/main` `bc1f1ca`, direct `node scripts/build-hono-renderer-assets.mjs` with a dummy Places key into a scratch directory took **29.49 s**, peak **957,436 KB**. It generated 225 country shards for 130,686 city routes, 66.48 MiB total; the largest (`united-states.json`) was 8.01 MiB. A fresh Node resolver load of the first state took 497 ms CPU for the US and 403 ms for France. These are local Node cold-path probes, **not Cloudflare Worker CPU measurements**.

The first candidate grouped identity rows once at build time and emitted one region shard per canonical state slug, each with its own local climate-cell table. Country and browse pages still used the manifest; state/city pages fetched only their region. The direct build took **28.06 s**, peak **870,228 KB**, producing 3,527 region shards (3,994 actual asset files). The first-state local Node resolver CPU was 75 ms for the US and 56 ms for France. An isolated Cloudflare staging deployment `00e3eb6b-fd8b-4ff4-836d-213cd1e47ec7` returned 200 for 76 distinct cold city URLs, but its first 93 recorded invocations had p50 **5.94 ms** and p99 **88.8 ms** CPU (0 resource errors). The large-region tail is too high to treat region splitting alone as sufficient.

The revised candidate retains a full region shard for directory pages and emits deterministic city-bucket shards only for regions with more than 96 cities. City pages fetch one bucket of at most 96 rows; state directories still fetch the complete region. Each shard has its own climate-cell table. The direct revised build took **29.28 s**, peak **914,420 KB**, producing **5,570 metadata shards** and **6,037 actual asset files**, below the **20,000 Workers Free asset limit**. These are local build/Node measures; hosted CPU and resource errors for this revision remain to be tested.

## Gates

- Asset generation accounts for every one of 130,686 canonical routes and matches the immutable HTML goldens; country/region ordering, search index and sitemap route inventory remain unchanged.
- The versioned manifest identifies only bounded `<country>/<region>.json` paths; a shard claiming a different region fails closed.
- Weather and forecast are not called on SEO HTML requests. The isolated staging config has no production custom domain, route, provider secret, Durable Object or R2 binding. It cannot validate live weather/search parity.
- Before any production decision, test cold and warm crawler-like requests through deployed isolated staging, compare Cloudflare `exceededResources` and CPU measurements, and inspect the largest regions. If the cold path still breaches 10 ms, subdivide large regions or choose another safe targeted optimization rather than claiming this candidate is a fix.
- No merge or production deployment without Michael's separate approval and the current backup/release gates.
