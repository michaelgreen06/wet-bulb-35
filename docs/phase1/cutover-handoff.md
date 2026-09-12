# Cutover handoff (2026-09-12)

Read this first in a fresh session. It records the current state and the remaining sequence for moving `www.wetbulb35.com` from Vercel to the Cloudflare Worker. Michael owns every step below; `production-cutover-runbook.md` has the full gate language.

## Where things stand

- **PR stack:** #8 → #9 → #10 → #11 → #12, all `MERGEABLE`/`CLEAN`, none merged. #12 (`fix/phase1-review-findings`) holds the review fixes, the saturated-air wet-bulb fix, the parity-gate classification changes, and the 2,000/day cap. PR #7 (inhabited hotspots preview) is unrelated; leave it.
- **Staging Worker** `wetbulb35-weather-staging.mgdevstuff.workers.dev`: version `63b6ffba`, built from #12 with the public Google Places key baked into `/assets/app.js`. Places autocomplete verified by hand. Parity gate 19/19 against production (2026-09-10).
- **Production Worker** `wetbulb35-weather-production`: deployed 2026-09-09 from older code, no Places key, cap still 100, secret `OPENWEATHER_API_KEY` set, zero routes. Must be redeployed from `main` before cutover.
- **DNS:** `wetbulb35.com` zone is on Cloudflare and `www` is proxied to Vercel (proved by `/cdn-cgi/` injections on production responses). Cutover is a Worker route, not a DNS change.
- **Vercel backup:** three env snapshots on the LaClaw box (`laclaw@100.122.107.124:~/.hermes/backups/wetbulb35/vercel/`). One value is a `[SENSITIVE]` placeholder (the OpenWeather secret); irrelevant for rollback because Vercel is never torn down.
- **Places key:** `NEXT_PUBLIC_GOOGLE_PLACES_API_KEY` in that backup. Build with `NEXT_PUBLIC_GOOGLE_PLACES_API_KEY=... npm run build:hono-renderer-assets`. It is public browser config, not a secret.
- **Tooling on this Mac:** `source ~/.nvm/nvm.sh && nvm use 22` before any wrangler command (Node 20 is default and wrangler refuses it). `wrangler login` done 2026-09-11; tokens expire, rerun in a real terminal if `whoami` fails.

## Decisions made

- Cap is 2,000 provider attempts per UTC day (OpenWeather subscription cap). Setting it to 0 disables weather entirely; never do that. Alerting near the cap is a fast follow (hourly Cron Trigger reading the Durable Object counter, Telegram message to LaClaw at 80%).
- Uptime monitoring (UptimeRobot or Better Stack, homepage plus `/api/weather` keyword checks every 15 minutes) is a fast follow, not a cutover blocker.
- Wet bulb at 100% humidity returns the dry-bulb reading; Stull clamps stay for other out-of-range inputs.
- Reviewer feedback rejected: rounding-order "parity bug" (Vercel rounds first too), symlink/TOCTOU hardening of local scripts. Accepted but deferred: hash `arrayBuffer()` bytes, derive asset list from HTML.
- The parity gate's `.relative` CSS exception exists only until Vercel rebuilds with #12; after cutover the gate against Vercel is moot.

## Completed 2026-09-12

- Step 1: #8 through #12 merged bottom-up with merge commits; `main` at `a497d73`.
- Step 2: route rehearsal done on `cutover-test.wetbulb35.com`. Attach: `wrangler deploy` with route config, hostname served by the Worker 9s after deploy (homepage, country page, city page, `/api/weather` all 200, no `x-vercel-id`). Detach: Michael deleted the route in the dashboard (Workers & Pages, Worker, Settings, Domains & Routes); hostname fell back to Vercel (525, Vercel has no cert for that hostname). Detach latency not measured (poller started after the click). DNS record deleted, staging redeployed with original config (workers.dev restored, version `5da33c0a`).
- Correction: the Worker sets no `x-worker-version` header (version id is only used for the HTML cache key). Worker-vs-Vercel check is: `x-vercel-id` absent, `content-disposition: inline` and `access-control-allow-origin: *` present.
- Deploying a config with `routes` and no `workers_dev` key disables the workers.dev URL for that Worker. Redeploying the original config re-enables it.
- A scoped Cloudflare API token (Zone DNS Edit + Zone Read, wetbulb35.com only) lives in `~/.cloudflare-dns-token` on this Mac. Revoke it and delete the file after cutover.
- Step 3 (partial): fresh Vercel recovery capture taken on LaClaw 2026-09-12T14:35Z (`docs/phase1/captures/vercel/`, env backup `production-env-2026-09-12T14-35-13Z.env`). Vercel production is already built from `a497d73`, so the `.relative` parity exception can go. Vercel requests/day and GA sessions/day: not captured (dashboard-only; Michael chose to skip, not a blocker). LaClaw checkout is now on `main` at `a497d73`.

## Remaining sequence

1. **Merge the stack**, bottom up with merge commits: merge #8, retarget #9 to `main`, merge, repeat through #12. Check `gh pr view N --json mergeable,mergeStateStatus` after each retarget.
2. **Route rehearsal on a throwaway hostname** (runbook section 7): Michael adds proxied DNS record `cutover-test.wetbulb35.com` (same target as `www`). Deploy the staging Worker with a temporary copy of `wrangler.weather-staging.toml` plus `routes = [{ pattern = "cutover-test.wetbulb35.com/*", zone_name = "wetbulb35.com" }]`. Curl it, then delete the route in the dashboard, curl again (expect Vercel response), delete the DNS record, and note how long each step took.
3. **Gather baselines:** Vercel requests/day, GA sessions/day for the last 14 days, and a fresh Vercel recovery capture (`scripts/capture-vercel-recovery-baseline.sh` on LaClaw, needs `vercel` CLI login there).
4. **Redeploy production Worker from `main`:** `NEXT_PUBLIC_GOOGLE_PLACES_API_KEY=... npm run build:hono-renderer-assets && ./node_modules/.bin/wrangler deploy --config wrangler.weather-production.toml`. Confirm `wrangler deployments list` shows the new version and `wrangler secret list` still shows `OPENWEATHER_API_KEY`.
5. **Cutover:** open the dashboard route page for the production Worker in a browser tab first. Run `./node_modules/.bin/wrangler tail --config wrangler.weather-production.toml` in one terminal. Then `./node_modules/.bin/wrangler deploy --config wrangler.weather-production-route.toml`. Curl `https://www.wetbulb35.com/` and a city page; check that `x-vercel-id` is absent and `content-disposition: inline` is present, `/cdn-cgi/` injections still present, and no 5xx in tail. Load a city page in a browser and confirm weather renders.
6. **Rollback if anything is wrong:** delete the `www.wetbulb35.com/*` route in the dashboard. Traffic returns to Vercel within seconds. Re-adding later is step 5 again.
7. **After a quiet day:** set up uptime monitor and cap alert. Keep the Vercel project alive for at least a month.

## Follow-ups not part of cutover

- GA traffic analysis (Michael asked; separate session).
- Cap-proximity alert via Cron Trigger and Telegram.
- Remove the `.relative` parity exception and, eventually, the Vercel-vs-Worker gate itself.
