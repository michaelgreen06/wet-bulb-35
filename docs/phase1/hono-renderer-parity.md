# Phase 1 Hono renderer parity

## Delivered

`workers/hono-page-renderer.mjs` renders the home page plus browse, country, state, and city routes from the private country metadata shards in `env.ASSETS`. It uses `lib/page-renderer.mjs`, the Worker-safe extraction of the static generator's rendering functions, so page HTML is byte-parity tested against the generator for home, browse, country, state, a unique city, and both members of a collision.

Recognized directory routes accept slashless and slashful paths and always emit slashful canonical/OG/JSON-LD URLs at `https://www.wetbulb35.com`. `/about` and unknown routes remain 404. `HEAD` is handled by Hono without a response body. HTML routing never consults a weather/provider binding.

The renderer asset build creates public CSS, client JS, locations index, copied public assets, and internal `/locations` metadata in one assets directory. The Worker explicitly returns 404 for `/locations/**`, including manifest and shards; those files are only read through `env.ASSETS.fetch` internally.

## Validation and metrics

- Generator/static tests: 17 passing.
- Existing binding/Miniflare tests: 4 passing.
- Renderer parity, full inventory, and bounded local-Wrangler integration tests: 5 passing.
- Full inventory: all 130,684 generator city routes resolved from generated shards in 8,565.187 ms; no HTML files were generated.
- Local Wrangler integration: a temporary three-file browser-public fixture is copied into a separate served-assets directory; every local HTTP fetch uses `AbortSignal.timeout(2,000)`, the generated temporary config sits outside that directory, and the detached Wrangler process group is terminated on startup failure, assertion failure, or node:test abort.
- Local Wrangler readiness: 1,363.663 ms (fixture assets, local run).
- Full production asset build: 130,684 rows; 224 countries; 225 metadata files before public assets.
- Production-assets Wrangler dry-run: 471 asset files; Worker upload 97.07 KiB (25.02 KiB gzip).

## Remaining differences / tradeoffs

- Metadata resolution currently parses an entire country shard for state and city pages. It avoids 130k HTML files and caches the manifest and each requested shard for the life of a Worker instance, but large-country first requests cost more than a per-state shard design.
- No weather endpoint is implemented in this bounded Phase 1 renderer. The preserved client JS still requests `/api/weather` after browser-side interaction/initial city widget setup; HTML requests themselves do not call it.
- This change does not alter the isolated staging Worker. It supplies a separate local/dry-run-only `wrangler.renderer-staging.toml`; no deploy, domain, route, DNS, secret, database, Durable Object, or production resource was changed.
