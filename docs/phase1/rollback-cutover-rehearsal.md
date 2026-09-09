# Rollback and cutover rehearsal runbook

## Hard boundary

This runbook is **staging-only**. It never attaches `wetbulb35.com`, `www.wetbulb35.com`, another custom domain, or a zone route. It prohibits DNS/registrar changes, Cloudflare zone-route changes, a merge to `main`, Vercel promotion/rollback, and every production traffic change.

The final production-domain route-back rehearsal is approval-gated. It cannot be genuinely tested without changing production traffic, so it is deliberately not executable from this repository or this runbook.

## Retained recovery evidence

- Vercel scope/project: `michaels-projects-899a0e11` / `wetbulb2` (`prj_5MhIySYFwcqz6P5N0HhCL8s0ZsuZ`).
- Retained Vercel production deployment: `dpl_98CXao2fnVfTWFmn8AxFeuNSnUXe`, `READY`, source `f6acf975b57d3352cfaaa45db3164e5389ea2c3a`; see `docs/phase1/captures/vercel/current-production.json`.
- Deployment inventory, configuration metadata, domains metadata, and the read-only recovery manifest are retained under `docs/phase1/captures/vercel/`; values are not committed. `docs/phase1/vercel-recovery-baseline.md` records the known sensitive-value recovery gap.
- Cloudflare account ID: `fddb460ed1b6d83303e6a0721fd48318`; `wetbulb35.com` zone ID: `a2958cbae3668404739ab40da5bd1569`.
- The retained inventory observation is **0** production-zone Worker routes. A read-only API check at `2026-09-09T06:43:52Z` reconfirmed zero; this is evidence, not permission to alter the zone.
- Disposable target: `wetbulb35-weather-staging.mgdevstuff.workers.dev`, Worker `wetbulb35-weather-staging`. Current version recorded for this rehearsal: `fe629b5a-08f8-4b28-bc4e-185f04dfe93e`; rollback target: `fc8b6893-f622-4467-ac6b-ea552a38bfda`.

## Local, idempotent preflight

```sh
npm run --silent dry-run:rollback-cutover-rehearsal
```

The command performs only local reads plus `./node_modules/.bin/wrangler --version`; it makes no network request or remote mutation. It requires the repository-installed pinned Wrangler `4.129.1`, checks that `wrangler.weather-staging.toml` names only the isolated Worker and contains no route/zone/custom-domain configuration, and checks retained Vercel identifiers. Its fixed JSON report is safe to retain: it contains only IDs, hostnames, versions, and route count—never secrets, request URLs, headers, IPs, or deployment logs. Re-running it is idempotent and produces the same report while inputs are unchanged.

A missing local Wrangler is a deliberate precondition failure. Run the repository's approved dependency-install process before proceeding; do not use `npx` or permit a tool to download Wrangler.

## Disposable workers.dev/version rehearsal

Do this only after the preflight passes and an authorized owner explicitly approves a staging rollback. The owner must confirm all of these before any remote command:

1. The exact Worker and hostname above are disposable staging only; no custom domain, route, DNS record, or production traffic control is involved.
2. The current deployed version is `fe629b5a-08f8-4b28-bc4e-185f04dfe93e`; the retained rollback version is `fc8b6893-f622-4467-ac6b-ea552a38bfda` and is listed as available by the account.
3. `OPENWEATHER_API_KEY` exists by name only; never display, copy, change, or rotate it. `HTML_CACHE_EVENT_SAMPLE_RATE` remains `0`.
4. The owner has an abort path: restore the recorded current version to the same workers.dev Worker. Do not use any other Worker, config, route, or hostname.
5. Evidence will contain only version IDs, command exit status, UTC timestamps, and the fixed-schema output from `npm run --silent tail:weather-staging-safe`. Raw tail envelopes, request URLs, bodies, headers, IPs, and secrets are prohibited.

Use the repository-installed executable, never `npx`. First inspect the pinned CLI's locally installed syntax and then perform only read-only version discovery:

```sh
./node_modules/.bin/wrangler rollback --help
./node_modules/.bin/wrangler versions list --name wetbulb35-weather-staging
```

If discovery already reports the target version as current, record `already-at-target` and stop: this makes repeated attempts effect-idempotent. Otherwise, the approved owner may use the syntax printed by the pinned CLI to shift **only** `wetbulb35-weather-staging` to `fc8b6893-f622-4467-ac6b-ea552a38bfda`, verify the workers.dev hostname and version, then restore `fe629b5a-08f8-4b28-bc4e-185f04dfe93e` using the same Worker-only control. Re-list versions after each shift. Stop immediately on an unexpected Worker name/version or any indication of route/custom-domain/zone scope.

This rehearsal intentionally does not deploy code, alter configuration, alter secrets, attach a domain, create a route, change DNS, merge `main`, or send production traffic.

### Executed staging-only result

Before the `2026-09-09T06:41:41Z` rollback, two identical local preflight runs produced the same report. The pinned Wrangler listed both exact versions, and the effect-idempotence guard confirmed the rollback target was not already active.

The staging Worker shifted from `fe629b5a-08f8-4b28-bc4e-185f04dfe93e` to retained version `fc8b6893-f622-4467-ac6b-ea552a38bfda` at 100%. Its workers.dev HTML HEAD check returned 200. It was then restored to `fe629b5a-08f8-4b28-bc4e-185f04dfe93e` at 100%; deployment `fd4e03e2-3605-4610-8b6f-c1dabb12e30d` confirms the restored state. `OPENWEATHER_API_KEY` still exists by name, and the production-zone Worker route inventory remains zero.

Cloudflare explicitly warned that version rollback does not roll back bound persistence. The staging Durable Object cache and daily-attempt counter were therefore identified as external state and deliberately left unchanged; no data-restore claim is made.

## Production route-back gate

Before a production-domain cutover or route-back can be rehearsed, a separate written approval must name the traffic-control owner, Cloudflare product/control-plane operation, exact route/domain scope, Vercel target deployment, propagation/cache bounds, observation window, abort owner, and evidence handling. That controlled change affects production traffic; it is outside the staging-safe controls above and cannot be simulated as a genuine production route-back.
