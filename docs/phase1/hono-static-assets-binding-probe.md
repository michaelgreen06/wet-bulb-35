# Phase 1 Hono static-assets binding probe

**Status:** deployed only to the isolated `workers.dev` staging hostname. No custom domain, zone route, DNS record, production secret, database, Durable Object, or weather-provider integration exists.

## What this proves

- `workers/hono-binding-probe.mjs` is a minimal Hono Worker that reads `env.ASSETS` through `ASSETS.fetch(Request)`.
- The route manifest and requested country shard determine country, state, unique-city, and collision-safe city recognition. State slugs and `outputCitySlug` are emitted by `scripts/probe-location-route-identity.mjs`, which calls the production `prepareCities`/`getRouteParts` JavaScript; this probe does not implement slug or collision rules.
- Deterministic three-row fixtures cover country, state, one unique city, both generated Metsamor collision paths, and a missing city. Each recognized slashful and slashless route returns `200`; each HTML document has a slashful `https://www.wetbulb35.com` canonical, including local requests.
- The direct binding test supplies a throwing `WEATHER_PROVIDER.fetch` and verifies zero provider calls across all HTML fixture routes. The Worker contains no weather import, endpoint, or provider fetch.
- `tests/hono-binding-probe.test.mjs` also starts `wrangler dev --local` (Wrangler/Miniflare) and makes real HTTP requests against the static-assets binding. It proves direct metadata manifest and shard URLs return `404`, while recognized HTML routes still read those assets internally through `env.ASSETS.fetch`.

## Staging configuration

`wrangler.staging.toml` declares only the generated `ASSETS` binding, a probe-only name, main module, compatibility date, trusted canonical-origin variable, and `run_worker_first = true`. The probe config has the same Worker-first asset behavior. They contain no `route`, `routes`, `custom_domain`, secret, provider URL, or production cache binding.

## Measured local run (2026-09-08)

| Check | Exact result |
| --- | --- |
| Candidate build | 130,684 rows; 224 countries; 1,419 collision groups / 3,014 collision rows; **225 runtime files** (224 shards + route manifest) |
| Candidate directory | **7,957,370 bytes**; 225 files; inventory SHA-256 `a7d6b54cb4461f6f72618e1f70547601c15eb28b9ea780282b786450d79e5f42` |
| `wrangler deploy --dry-run` | Wrangler 4.129.1 read **227 files** from the assets directory; Worker bundle **64.97 KiB**, gzip **16.19 KiB**; bindings shown as `env.ASSETS` and `env.CANONICAL_ORIGIN`; exited with `--dry-run: exiting now` |
| Local runner readiness | **1,337.002 ms** from Wrangler spawn to first local `404` readiness response, using the small fixture assets |
| Local integration | 4/4 tests passed; both forms of 5 recognized fixture routes returned `200`; missing route and direct manifest/shard requests returned `404` |

## Isolated staging verification

Deployed Worker `wetbulb35-hono-binding-probe-staging`, version `d3f34bea-af5b-44a1-9129-2076455b9cd5`, to `https://wetbulb35-hono-binding-probe-staging.mgdevstuff.workers.dev` after explicit approval. Wrangler reported **6 ms Worker Startup Time**. Live checks confirmed:

- slashful and slashless country routes return `200` with the production-host slashful canonical;
- both tested collision-safe Metsamor routes return `200` with the intended canonicals;
- direct manifest and shard URLs return `404`;
- an unknown route returns `404`;
- the `wetbulb35.com` zone has **zero custom Worker routes**.

## Limitations / gate outcome

- The 1,337.002 ms local runner-readiness measurement includes Wrangler process startup, Miniflare initialization, and polling granularity. It is **not** the Cloudflare 1 s script-startup metric and must not be compared to that gate. The isolated staging deployment reported the actual Worker startup metric as 6 ms.
- The original packaging measurement's compact manifest had only country entries. This probe adds production-generated state-slug-to-name entries to the same route manifest so the Worker never recreates state slugs. That raises the candidate directory from the earlier 7,800,362-byte compact-shard-plus-manifest measurement to 7,957,370 bytes. This is an integration artifact measurement, not approval of a final package schema.
- The local fixture is deliberately tiny. It proves binding path/response behavior, not full-inventory route parity, Cloudflare production limits, edge-cache behavior, real cold starts, DNS/custom-domain behavior, or provider behavior.
- Staging deployment used the dedicated scoped token. No custom route/domain/DNS, production secret, Durable Object, R2, database, or provider request was used.

## Reproduce

```sh
npm run test:hono-binding-probe
npm run dry-run:hono-binding-probe
```
