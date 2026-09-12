# Phase 1 production cutover runbook

**Status:** the route-free production Worker and encrypted secret are provisioned; no public target, route, DNS, custom domain, traffic, merge, retarget, Vercel change, weather request, alert, or log action occurred. Route attachment remains unauthorized.

**Update 2026-09-12:** see `cutover-handoff.md` for current state. PR #12 (`fix/phase1-review-findings`) is stacked on #11 and must merge last. The expanded 19-check parity gate passes 19/19 against staging version `63b6ffba` (built with the public Places key; autocomplete verified by hand). The daily provider ceiling is now **2,000 attempts per UTC day**, matching the OpenWeather subscription cap. A route attach/detach rehearsal on a throwaway hostname is planned before the `www` attachment (section 7).

## Recommendation and evidence

Use one Cloudflare **route**: `www.wetbulb35.com/*`; do **not** use a custom domain for this cutover. Read-only evidence at `docs/phase1/evidence/cloudflare-cutover-readiness.json` recorded zero production-zone routes and zero account custom domains. Vercel remains the current external origin: the retained deployment is `dpl_98CXao2fnVfTWFmn8AxFeuNSnUXe`, and 42 deployments were listed.

Cloudflare documents that a Route runs in front of an existing proxied hostname and that `fetch(request)` reaches the DNS-defined origin. A Custom Domain instead makes the Worker the hostname origin and creates Worker-directed DNS. Therefore deleting the exact route returns `www` to its existing Cloudflare-to-Vercel path without DNS change; a custom domain would not preserve that simple fallback. Sources: [Routes and domains](https://developers.cloudflare.com/workers/configuration/routing/), [Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), and [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

This remains conditional on the recorded DNS evidence: before attachment, an authorized owner must read-confirm that `www` has a proxied zone DNS record whose existing origin is still Vercel. No route is safe to attach otherwise. **Apex is separately verified:** `wetbulb35.com` is not in route scope. Before and after `www` cutover and after rollback, verify its existing apex-to-`www` redirect and that no apex route/custom domain was introduced.

The production configuration must name `wetbulb35-weather-production`, contain no `routes`/`route`/`custom_domain` during provisioning, use a separate production cache/persistence namespace, and contain no secret value. The sanitized checklist is `docs/phase1/production-cutover-checklist.json`.

## 1. Merge and retarget the stack

Current read-only PR state is recorded in the integration section below. Do not merge a child while its base is open: it keeps inherited commits in the diff and makes review/CI stale.

The repository permits merge commits, squash merges, and rebase merges. Use **merge commits** for this stack so each merged parent head becomes an ancestor of `main`; then retargeting exposes only the child's delta. If merge commits are not used, stop and explicitly rebase each child with `--onto` before retargeting—blind retargeting after a squash can reintroduce the parent diff.

1. Gate #8: `main` base, head `phase1/review-bundle` at `ea7d0da4fd3662116902b1c8533f8b0dec053471`; merge only after its checks remain successful.
2. Retarget #9 from `phase1/review-bundle` to `main`, wait for recalculated diff/checks, then merge #9 with a merge commit.
3. Retarget #10 from `phase1/hono-renderer` to `main`, wait for recalculated diff/checks, then merge #10 with a merge commit.
4. Retarget #11 from `phase1/weather-edge` to `main`, wait for recalculated diff/checks, then merge #11 with a merge commit.
5. Retarget #12 from `phase1/staging-parity` to `main`, wait for recalculated diff/checks, then merge #12 with a merge commit.
6. After each merge/retarget, re-read exact base/head, mergeability, changed files, and required checks. Stop on conflicts, an unexpected diff, or pending/failing checks.

Read-only check commands:

```sh
gh pr view 8 --json number,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup
gh pr checks 8
gh pr view 9 --json number,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup
gh pr checks 9
gh pr view 10 --json number,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup
gh pr checks 10
gh pr view 11 --json number,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup
gh pr checks 11
gh pr view 12 --json number,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup
gh pr checks 12
```

Merging and retargeting are remote mutations and require Michael's explicit approval at the time. They are intentionally not scripted here.

Exact CLI mutations, still **NOT AUTHORIZED**:

```sh
gh pr merge 8 --merge # NOT AUTHORIZED
gh pr edit 9 --base main # NOT AUTHORIZED
gh pr merge 9 --merge # NOT AUTHORIZED after recalculated checks pass
gh pr edit 10 --base main # NOT AUTHORIZED
gh pr merge 10 --merge # NOT AUTHORIZED after recalculated checks pass
gh pr edit 11 --base main # NOT AUTHORIZED
gh pr merge 11 --merge # NOT AUTHORIZED after recalculated checks pass
gh pr edit 12 --base main # NOT AUTHORIZED
gh pr merge 12 --merge # NOT AUTHORIZED after recalculated checks pass
```

Run each line separately only after the preceding merge is visible on `main` and the retargeted PR's recalculated diff/checks pass.

## 2. Provision a production-named Worker with no route

Completed under Michael's authorization on 2026-09-09. Sanitized evidence is in `evidence/route-free-production-worker.json`: Worker `wetbulb35-weather-production`, deployment `c3473d0f-e269-49d7-9abb-56b5647550d4`, version `368ecf1b-04b0-4444-b9ec-3cbcf33685d8` at 100%, zero deployed targets, zero production-zone routes, and zero custom domains. Future updates still require approval.

Gate: serial stack merged; reviewed production configuration is route-free; Cloudflare owner, window, rollback owner, and Vercel observer are named; no production serving change is approved yet.

```sh
# NOT AUTHORIZED: creates/updates only the named Worker; config must contain no route/custom domain.
npm run build:hono-renderer-assets # NOT AUTHORIZED production preflight
./node_modules/.bin/wrangler deploy --config wrangler.weather-production.toml # NOT AUTHORIZED
```

Immediately read-confirm the Worker identity/version and that the zone route/custom-domain inventories are still zero. If either inventory differs, abort before secret installation. This command may create a Worker but cannot be used to serve `www` without a later route attachment.

## 3. Install the encrypted secret by name

Completed under the same authorization. Read-back lists only `OPENWEATHER_API_KEY`; its value is not present in repository evidence or command output. No public endpoint exists for this Worker.

Gate: the approved secret custodian supplies the value only through the terminal prompt; evidence records only `OPENWEATHER_API_KEY` as a name. Never paste, log, commit, export, or capture a value.

```sh
# NOT AUTHORIZED: encrypted secret installation for the route-free production Worker.
./node_modules/.bin/wrangler secret put OPENWEATHER_API_KEY --name wetbulb35-weather-production # NOT AUTHORIZED
```

Read-confirm only the secret name, not its value. The Vercel `[SENSITIVE]` finding means the exact-config backup is incomplete: Vercel returned a placeholder for one existing sensitive value, so exact secret equivalence is not proven and must not be fabricated. This does **not** remove the retained-deployment fallback: `dpl_98CXao2fnVfTWFmn8AxFeuNSnUXe` remains the direct Vercel rollback candidate while it is retained. Recover any missing value only from its original secret source before an exact Vercel configuration recovery drill.

Read-only Vercel inventory check:

```sh
vercel ls wetbulb2 --scope michaels-projects-899a0e11
```

## 4. Dry/live canary

Dry canary gate: route-free and route-bearing production configs pass their non-deploying dry runs, local tests, and the isolated staging parity gate. The committed configs differ only by the single reviewed `www.wetbulb35.com/*` route. Staging evidence (2026-09-10) is 19/19 on the expanded gate: HTML, `HEAD`, negotiated 404s, robots, sitemaps, favicon, browser CSS/JS/search index, and the full 130,684 inventory. Production-zone injections (email obfuscation, Web Analytics beacon) are classified expected differences and are dropped from comparison rather than copied into the Worker; see `staging-parity-gate.md`.

The route-free production Worker is verified through the control plane only: exact version, bindings, secret name, and zero routes/custom domains. Cloudflare does not generate Preview URLs for Workers that implement Durable Objects, so this Worker deliberately sets `workers_dev=false` and `preview_urls=false`; do not claim an HTTP canary for it before attachment. Functional live testing remains on the separate `wetbulb35-weather-staging.mgdevstuff.workers.dev` service. Source: [Preview URL limitations](https://developers.cloudflare.com/workers/configuration/previews/#limitations).

Live cutover gate: approve a short named window, operator, observer, budget owner, alert recipient, and an explicit maximum request count. The global ceiling is **2,000 attempts per UTC day**, matching the OpenWeather subscription cap so the Worker degrades to stale data before the provider starts rejecting calls. Routes have no documented weighted canary in this evidence; treat attachment as all `www` traffic. The only permitted initial probe set is the approved bounded route matrix, excluding `/api/weather`; weather requires a separate one-request budget approval and redacted outcome evidence. Never generate a production load test.

## 5. Attach exactly one route

Gate: all gates above pass; read-confirm proxied `www` DNS/Vercel origin, route inventory is zero, custom-domain inventory is zero, and the exact route string is `www.wetbulb35.com/*`. No apex route and no custom domain.

```sh
# NOT AUTHORIZED: attaches exactly www.wetbulb35.com/* via the reviewed route-bearing config.
npm run build:hono-renderer-assets # NOT AUTHORIZED production preflight
./node_modules/.bin/wrangler deploy --config wrangler.weather-production-route.toml # NOT AUTHORIZED
```

The route-bearing config must be reviewed side-by-side with the route-free config; its only routing delta is the one `www.wetbulb35.com/*` route. Record the Cloudflare route identifier returned by the authorized control plane: it is mandatory rollback evidence.

## 6. HTML/SEO/assets/404/weather budget

During the approved window, test the bounded home/browse/country/state/city/slashless/`HEAD` matrix, favicon, sitemap index/member, robots, and HTML/JSON/plaintext intentional 404s. Confirm status, content type, canonical/OG/robots/JSON-LD contract, cache/HSTS/CORS/content-disposition headers, asset bytes, and no unexpected route exposure. Confirm the result contains the zone **email obfuscation and managed robots** transforms: decoder markup and managed-robots prefix. The isolated staging hostname correctly lacked those zone transforms.

For weather, first prove HTML requests make zero provider calls. Then use at most the explicitly approved live weather request budget; verify the selected global ceiling, timeout/error behavior, alert delivery, telemetry query/read access, and owner. Abort rather than infer a global cap from Worker-local state.

## 7. Rollback: delete the exact route

**Rehearsal (before touching `www`):** add a proxied DNS record for a throwaway hostname such as `cutover-test.wetbulb35.com` pointing at the same Vercel target as `www`; deploy the staging Worker with a temporary config whose only route is `cutover-test.wetbulb35.com/*`; confirm the Worker answers; delete that route in the dashboard (Workers & Pages, Worker, Settings, Domains & Routes) and confirm the hostname falls back to the origin; remove the DNS record. This proves the exact detach path and its timing without any production traffic. Re-adding a route later is one `wrangler deploy` with the route-bearing config.

Abort immediately for: route scope other than `www.wetbulb35.com/*`; any unexpected 5xx in the bounded matrix; wrong/missing canonical, robots, content type, cache/HSTS, asset, 404, email, or robots transform; budget/timeout/error alert; missing telemetry evidence; or changed apex behavior.

The authorized Cloudflare owner must delete **only** the recorded route whose pattern is `www.wetbulb35.com/*` and whose route ID was recorded at attachment. Do not delete the Worker, DNS record, custom domain, Vercel alias, secret, or apex configuration. Route deletion is the rollback because it returns `www` to the retained Vercel origin path. Then verify the retained Vercel deployment/alias serves `www`, repeat the bounded non-weather checks, and separately verify the apex redirect. If Vercel fallback does not pass, keep the incident open; do not claim recovery from the incomplete exact-config backup.

## 8. Owner and window approvals

Michael must explicitly decide: (1) approve merge-commit-based serial merge/retarget; (2) approve route—not custom-domain—cutover for `www` only; (3) approve route-free production Worker/secret provisioning; (4) name the production-window owner, Cloudflare route/rollback owner, Vercel observer, and incident abort owner; (5) name the alert recipient and approve telemetry/retention evidence plus a one-request live-weather canary budget; and (6) grant Search Console access for `sc-domain:wetbulb35.com` or explicitly waive that baseline. The 2,000-attempt daily ceiling was approved on 2026-09-12.

## Integration snapshot (read-only, 2026-09-09)

| PR | Base → head (exact head) | Mergeability/checks | Changed files / overlap | Required serial action |
| --- | --- | --- | --- | --- |
| #8 | `main` → `phase1/review-bundle` (`ea7d0da4fd3662116902b1c8533f8b0dec053471`) | `MERGEABLE`, `CLEAN`; Vercel and Vercel Preview Comments succeeded | 55; overlaps #9: 4, #10: 2, #11: 8 | merge first |
| #9 | `phase1/review-bundle` → `phase1/hono-renderer` (`a1c3eac3cff14a1b0d8c96f8e7213d9836f01ca4`) | `MERGEABLE`, `CLEAN`; both checks succeeded | 15; overlaps #10: 4, #11: 6 | retarget to `main`, recalc, merge |
| #10 | `phase1/hono-renderer` → `phase1/weather-edge` (`86648afbfaddff164b2999f430058b59f2196b56`) | `MERGEABLE`, `CLEAN`; both checks succeeded | 8; overlaps #11: 8 | retarget to `main`, recalc, merge |
| #11 | `phase1/weather-edge` → `phase1/staging-parity`; pre-runbook inspected head `3781bea23c08a410b053f52be0061346546eae54` | `MERGEABLE`; the pre-runbook Vercel check was pending and must be read live | inherited stack overlap noted above | read the current self-referential head/checks; retarget to `main`, recalc, merge |
| #12 | `phase1/staging-parity` → `fix/phase1-review-findings` (2026-09-12: `MERGEABLE`, `CLEAN`) | read live | review fixes, parity gate, cap | retarget to `main` after #11, recalc, merge last |

Changed-file overlap is expected from the stacked implementation (`package.json`, renderer, tests, docs, and staging config); serial merge then retarget prevents inherited stale diffs from being reviewed as new changes.

## Safe local verification

```sh
python3 -m unittest tests/test_production_cutover_runbook.py
npm run --silent dry-run:hono-binding-probe
npm run --silent dry-run:hono-page-renderer
npm run --silent dry-run:weather-edge
npm run --silent dry-run:weather-production
npm run --silent dry-run:weather-production-route
npm run --silent check:staging-parity
npm run --silent dry-run:rollback-cutover-rehearsal
```

These are preparation checks only; none attach a production route or send a production weather request.
