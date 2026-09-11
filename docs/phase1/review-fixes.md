# Follow-up to PRs #8–#11

This change is stacked on `phase1/staging-parity` (PR #11). It repairs the review findings without changing the approved provider-attempt ceiling or activating a Cloudflare route.

- The asset builder refuses repository/home roots and ancestors, including symlink aliases. Nonempty output directories must carry this builder's ownership marker in `locations/route-manifest.json`. Existing output from older revisions has no marker: choose a fresh directory, or move the old generated directory aside before rebuilding at the default `worker-assets` path. No new publicly served marker file is added.
- Vercel recovery capture inspects the serving `www.wetbulb35.com` alias and requires a ready production deployment. It does not infer serving state from deployment creation order. Python checks backup permissions portably on macOS and Linux. Historical captures are unchanged; the capture tests use fake CLIs and fake environment values.
- Tailwind scans the extracted page renderer, and changes to that renderer trigger Vercel builds. Generated CSS tests cover screen-reader-only status text and search layout utilities.
- The weather formula preserves production's clamped calculation inputs while retaining original temperature/humidity readings in the response. Saturated air (100% humidity) returns the dry-bulb reading instead of a clamped 99% estimate. Tests cover saturated air, very dry air, cold/hot readings, and cache reuse without additional provider calls.
- The expanded parity gate compares browser script references and the full CSS, JS, and search-index contents. Local HTTP fixtures prove changed assets fail the gate; they never contact a weather provider.
- PR #11 already fixes poisoned manifest retries. Additional tests exercise transient HTTP failures, malformed JSON, and invalid schemas on the same renderer instance.

Live parity evidence, credentials, deployment, log access, alerts, and production cutover remain separate operational work. The previous 8/16 staging record is not reclassified as passing by these fixes.
