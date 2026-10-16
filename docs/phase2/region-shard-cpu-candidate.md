# Region-sharded location metadata: free-plan CPU candidate

**Scope:** Build-time metadata packaging and Worker lookup only. No canonical routes, page templates, weather/forecast APIs, production bindings, or sitemaps change. This candidate is not a production release.

## Measured baseline and candidate (2026-10-16)

From clean `origin/main` `bc1f1ca`, direct `node scripts/build-hono-renderer-assets.mjs` with a dummy Places key into a scratch directory took **29.49 s**, peak **957,436 KB**. It generated 225 country shards for 130,686 city routes, 66.48 MiB total; the largest (`united-states.json`) was 8.01 MiB. A fresh Node resolver load of the first state took 497 ms CPU for the US and 403 ms for France. These are local Node cold-path probes, **not Cloudflare Worker CPU measurements**.

The candidate groups identity rows once at build time and emits one region shard per canonical state slug, each with its own local climate-cell table. Country and browse pages still use the manifest; state/city pages fetch only their region. Version 1 country shards remain accepted for existing fixtures. The direct candidate build took **28.06 s**, peak **870,228 KB**, producing 3,527 region shards (3,994 actual asset files including public assets, below the 20,000 Workers Free asset limit). The first-state local Node resolver CPU was 75 ms for the US and 56 ms for France. This improvement is a directional proxy, not proof that every Cloudflare cold request fits its free-plan CPU limit.

## Gates

- Asset generation accounts for every one of 130,686 canonical routes and matches the immutable HTML goldens; country/region ordering, search index and sitemap route inventory remain unchanged.
- The versioned manifest identifies only bounded `<country>/<region>.json` paths; a shard claiming a different region fails closed.
- Weather and forecast are not called on SEO HTML requests. The isolated staging config has no production custom domain, route, provider secret, Durable Object or R2 binding. It cannot validate live weather/search parity.
- Before any production decision, test cold and warm crawler-like requests through deployed isolated staging, compare Cloudflare `exceededResources` and CPU measurements, and inspect the largest regions. If the cold path still breaches 10 ms, subdivide large regions or choose another safe targeted optimization rather than claiming this candidate is a fix.
- No merge or production deployment without Michael's separate approval and the current backup/release gates.
