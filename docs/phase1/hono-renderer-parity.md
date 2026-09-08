# Phase 1 Hono renderer parity

## Delivered

`workers/hono-page-renderer.mjs` renders the home page plus browse, country, state, and city routes from the private country metadata shards in `env.ASSETS`. This staging renderer is limited to HTML and static UX; it is not a live-weather sign-off.

Recognized directory routes accept slashless and slashful paths and always emit slashful canonical/OG/JSON-LD URLs at `https://www.wetbulb35.com`. `/about` and unknown routes remain 404. `HEAD` is handled by Hono without a response body. HTML routing never consults a weather/provider binding.

The renderer asset build creates public CSS, client JS, locations index, copied public assets, and internal `/locations` metadata in one assets directory. Manifest states are ordered with the production renderer's display-name `localeCompare` rule, not route-slug order. The Worker explicitly returns 404 for `/locations/**`, including manifest and shards; those files are only read through `env.ASSETS.fetch` internally.

`tests/fixtures/hono-renderer-goldens.json` is immutable pre-extraction evidence: `scripts/generate-hono-renderer-goldens.mjs` checked out the original `scripts/prototype-static-generator.mjs` from review-bundle commit `ea7d0da`, rendered against the committed city source, and stored normalized SHA-256 hashes. Its only normalization replaces the dynamic footer year with `<YEAR>`. The current Worker is compared to those hashes without calling the extracted renderer functions. Coverage includes home, browse, state, city, and every ordering-sensitive country page: Algeria, Azerbaijan, Cambodia, Malta, Mayotte, Mongolia, Qatar, Saudi Arabia, Tonga, Turkey, and Yemen.

## Validation and metrics

- Generator/static tests: 17 passing.
- Existing binding/Miniflare tests: 4 passing.
- Renderer tests include independent golden parity, full inventory, bounded local-Wrangler integration, explicit weather-unavailable behavior, and LRU retention: 8 passing.
- Full inventory: all 130,684 generator city routes resolved from generated shards in 8,606.796 ms; no HTML files were generated.
- Local Wrangler integration: a temporary three-file browser-public fixture is copied into a separate served-assets directory; every local HTTP fetch uses `AbortSignal.timeout(2,000)`, the generated temporary config sits outside that directory, and the detached Wrangler process group is terminated on startup failure, assertion failure, or node:test abort.
- Local Wrangler readiness: 1,535.622 ms (fixture assets, local run).
- Full production asset build: 130,684 rows; 224 countries; 225 metadata files before public assets.
- Production-assets Wrangler dry-run: 471 asset files; Worker upload 98.55 KiB (25.43 KiB gzip).

## Remaining differences / tradeoffs

- Metadata resolution currently parses an entire country shard for state and city pages. It avoids 130k HTML files and retains at most eight parsed country shards in access-order LRU state per Worker instance. Same-key in-flight reads coalesce; rejected and invalid loads are not retained. Large-country first requests still cost more than a per-state shard design.
- No live-weather endpoint is implemented in this bounded Phase 1 renderer. `/api/weather` returns a deterministic `501` JSON error and never consults a provider binding. The preserved client JS may request it after browser-side interaction/initial city widget setup; resulting live weather is deliberately outside staging acceptance.
- This change does not alter the isolated staging Worker. It supplies a separate local/dry-run-only `wrangler.renderer-staging.toml`; no deploy, domain, route, DNS, secret, database, Durable Object, or production resource was changed.
