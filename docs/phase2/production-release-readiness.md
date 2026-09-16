# Production release readiness: Phase 2 SEO and Tier-1 structure

## Status

This runbook prepares the combined production release represented by already-merged PR #13 plus open PR #15. It does not authorize merging or production deployment. The credential-free rehearsal runs on pull requests as well as through `workflow_dispatch`. Record its successful GitHub-hosted run for the reviewed monitor commit before requesting production approval; merge the operations workflow before starting scheduled production monitoring.

## Exact release boundary

Current public production is served by Cloudflare Worker `wetbulb35-weather-production` through exactly one route:

- route: `www.wetbulb35.com/*`
- current active Worker version: `c18cba53-a7ef-4b1e-add7-5fec3c3e65f5`
- current deployment ID: `95743285-6a32-49c1-9f4e-eb61b95e4405`
- current Vercel fallback: `dpl_HnU4QEFJwa4zwtgFf5YPdcdR4jwX`

Proposed application head:

- PR #15: https://github.com/michaelgreen06/wet-bulb-35/pull/15
- reviewed head: `f06db92369b81ae1448c6fe39aa74b177587eed0`
- isolated full-feature staging: https://wetbulb35-weather-staging.mgdevstuff.workers.dev

Re-read every identifier immediately before approval and deployment. A mismatch invalidates readiness.

## Full current-production to proposed-release review

The release is not merely PR #15's branch diff. The active production Worker predates PR #13, so the review boundary includes PR #13 and PR #15.

Live production and isolated staging were crawled directly:

- current production sitemap index: 227 members; all 227 returned 200;
- current sitemap member entries: 134,435;
- current raw unique URLs: 132,840;
- current duplicate entries: 1,595;
- current unique URLs after trailing-slash normalization: 132,839;
- proposed sitemap index: 228 members; all 228 returned 200;
- proposed sitemap member entries: 134,440;
- proposed unique URLs: 134,440;
- proposed duplicate entries: zero;
- normalized route-set change: 3,025 additions and 1,424 removals.

The large route-set change is the PR #13 canonical sitemap correction, not 3,025 newly invented cities. It replaces collision-prone/noncanonical routes with renderer-identical canonical routes, adds omitted canonical routes, removes `/about/` from the generated sitemap, and includes `/`. PR #15 then adds Singapore and Hong Kong plus Singapore's country sitemap.

Representative live HTML confirms PR #13 is not yet on the active Worker. Houston currently has the generic `Current Wet Bulb Temperature` H1 and lacks the visible breadcrumb, methodology, disclaimer attribution block, and city-specific introduction. The proposed release has the city-specific H1, breadcrumb, methodology, disclaimer, attribution, corrected coordinates, and unchanged canonical URL.

PR #15 adds:

- a sanitized 200-city internal planning manifest;
- exactly 40 alphabetized Popular links on `/wetbulb-temperature/`;
- canonical Singapore and Hong Kong pages;
- alphabetical country and region directories; and
- static/Worker build and validation changes.

The pre-deployment review must rerun the complete route-set comparison, representative HTML semantic checks, renderer tests, sitemap tests, weather tests, and browser autocomplete flow against the exact merged commit.

## Deployment command and route preservation

Only `scripts/deploy-production-release.sh` may perform the Worker deployment. It verifies a clean worktree at the explicitly approved commit, checks required credentials, runs the release test suites, builds browser assets, confirms Google Places is present, and then invokes:

```sh
./node_modules/.bin/wrangler deploy \
  --config wrangler.weather-production-route.toml
```

The script deliberately refuses to use `wrangler.weather-production.toml`. That configuration is route-free and could remove the production trigger.

The route-bearing configuration must contain only:

- Worker `wetbulb35-weather-production`;
- route `www.wetbulb35.com/*`; and
- no custom domain.

After deployment, read back the route and active version before any public health claim.

## Route restoration

A Worker version rollback does not repair a missing or changed routing trigger. `scripts/restore-production-worker-route.mjs` provides a separate narrow action.

It may only:

- discover the single active `wetbulb35.com` zone;
- inspect existing routes;
- do nothing when the exact route already points to the expected Worker;
- create `www.wetbulb35.com/*` pointing to `wetbulb35-weather-production` when that exact pattern is absent; and
- verify the resulting route.

It refuses duplicate exact routes, broadened routes assigned to this Worker, and any additional route that can match `www` (including more-specific overrides and null-script exclusions). It refuses to replace a route owned by another Worker. An unexpected route is reported for operator intervention; automation never silently deletes it or claims restoration succeeded. Dry run is the default. The authorized recovery action is:

```sh
node scripts/restore-production-worker-route.mjs --apply=true
```

Approval must explicitly include this narrow route-restoration authority. It does not authorize any DNS, apex, custom-domain, route-scope, or unrelated Worker change.

## Durable monitoring

Monitoring runs on GitHub-hosted Actions through `.github/workflows/production-release-monitor.yml`. It is independent of the Hermes conversation, agent session, local terminal, and Michael's computer power or sleep state.

State is stored in one labeled GitHub issue containing:

- release commit;
- expected active Worker version;
- rollback version;
- start and expiration times;
- most recent check time; and
- most recent structured result;
- persistent `recovering` state and whether weather recovery is required;
- reserved/consumed weather request count; and
- completed full-crawl and first-hour checkpoints.

State schema 2 is required. An older active monitor must be stopped and restarted explicitly. The runner records recovery intent before a mutation and resumes it on subsequent runs until verified, stopped, superseded, or expired. At expiry, unresolved recovery stays visible as `expired_unhealthy` and raises an alert instead of claiming success.

Workflow failures and recovery failures create issue comments and failed GitHub Actions runs, using GitHub's normal notification system. Exactly one active monitor issue is allowed.

Repository configuration required by the workflow:

- encrypted Actions secret `WETBULB35_CLOUDFLARE_API_TOKEN`;
- Actions variable `CLOUDFLARE_ACCOUNT_ID`.

Both are installed. The secret value is not stored in Git, logs, issues, or workflow inputs.

## Polling schedule and expiry

### First hour

The manually started GitHub-hosted job pauses two minutes between completed cycles until one elapsed hour, then performs a final checkpoint. Request time adds to the interval. It survives the initiating agent session ending.

- full sitemap crawl: start and end of the hour;
- two weather locations: start and every ten minutes;
- all other critical checks: every two minutes.

### Hours 2–24

A scheduled workflow requests a run every five minutes but normally runs a health cycle only when 30 minutes have elapsed since the previous completed check. Incomplete recovery is retried on each eligible scheduled run. GitHub can delay or drop scheduled runs; this is best-effort monitoring, not a guaranteed response-time service. A late heartbeat produces a coverage warning on the next runner and prevents a claim of uninterrupted first-hour coverage.

- critical checks: every 30 minutes;
- weather checks: every 60 minutes;
- full sitemap crawl: at the first eligible check after hour 23.

At 24 hours the workflow performs no more recovery actions. A healthy expiry closes the issue; unresolved recovery leaves an explicit incident open. Manual stop closes the issue and runs independently of the intensive job. Runners re-read closure and expiry before each cycle and before rollback and route restoration. A command already in progress cannot be recalled.

Each check pass has a 120-second deadline. Full sitemap crawling uses four concurrent requests, a 45-second deadline, and stops scheduling more members after three failed members. Already-failing critical pages/routes bypass the expensive crawl. The confirmation retry is separated by 20 seconds. These limits leave time for recovery within the hosted job timeout, even when endpoints hang.

## Checks

Critical checks cover:

- active Cloudflare version;
- exact production route, Worker ownership, and absence of unexpected matching routes;
- homepage and browse page;
- Popular section count and uniqueness;
- country and region alphabetical order;
- sampled page canonicals and absence of meta/HTTP `noindex` directives;
- browser JavaScript and Google Places runtime;
- search-index asset availability;
- robots sitemap declaration and crawl permission for the sampled public pages;
- sitemap member count;
- full sitemap status, count, and duplicate checks at bounded milestones.

Weather checks use only Houston and Singapore and validate the complete location/weather response shape. Weather depends on the OpenWeather upstream, and the public API cannot distinguish a provider outage from an application regression, so a weather failure is reported to the operator as a WARNING and never triggers automatic rollback. Neither PR #13 nor PR #15 changes the weather edge. Weather failures are fixed forward or waited out.

All hosted weather requests, including confirmation retries and recovery, share a persisted cap of 58 per monitoring window. Requests are reserved before execution and unused reservations are refunded after a completed cycle; a killed runner conservatively consumes its reservation. Retries may reduce later weather sampling. A weather failure cannot be cleared by a retry that omitted weather due to budget exhaustion. If weather recovery cannot be verified within the remaining allowance, the incident stays unresolved. Normal caching should make provider attempts lower. No state in the Durable Object's 2,000-attempt UTC-day counter is changed by rollback.

## Failure threshold

A matching critical failure category must occur in two consecutive attempts separated by 20 seconds before automatic rollback. Different failures, loss of control-plane access, or a weather retry without budget produce an alert rather than an unearned success. This filters short network and control-plane transients.

No automatic rollback occurs when:

- the Cloudflare control plane cannot be verified; or
- the active Worker version differs from the release version recorded by the monitor.

Those cases create an alert instead. A stopped/expired monitor has no recovery authority. A rollback version already active triggers recovery verification, rather than skipping public checks.

## Protection from stale monitors

Immediately before rollback, `scripts/execute-production-rollback.sh` reads the active Worker deployment from Cloudflare. It proceeds only if the active version exactly equals the failed release version recorded when monitoring started.

If a later deployment is active, rollback is refused and the old monitor closes as superseded. This prevents a delayed or stale monitor from rolling back a newer release.

## Rollback and recovery verification

On a confirmed critical failure:

1. Re-read and compare the active version with the monitor's expected release version.
2. Roll back to the recorded last-known-good version with `wrangler rollback`.
3. Run the narrow exact-route restoration action.
4. Verify the rollback version is active at 100%.
5. Verify the exact production route points to `wetbulb35-weather-production`.
6. Verify the homepage, browse page, established city page, browser asset, search index, robots file, and 227-member pre-release sitemap index. Weather is reported but is not a recovery gate.

If any rollback, route restoration, or recovery check fails, the workflow:

- does not claim recovery;
- adds a `CRITICAL` comment to the monitor issue;
- links the failed workflow run; and
- exits failed so GitHub sends its configured notifications.

The persistent state remains `recovering`. Subsequent runners recheck deployment identity, skip an already-completed version rollback, retry permitted route restoration, and verify public health. They never roll back a newer deployment. GitHub notification delivery depends on the operator's notification settings; confirm those settings before release.

Connected resources, including the Durable Object and its provider-attempt counter, are not reset by a version rollback.

## Rehearsal gates

The local and GitHub-hosted deterministic rehearsal runs the production state machine against a mock HTTP site and Cloudflare API. It also invokes the actual shell rollback entry point with an intercepted fetch implementation and simulated Wrangler command. It needs no credentials and cannot contact production. It proves:

- healthy release detection;
- critical failure detection;
- rollback eligibility only for the expected active version;
- stale-monitor refusal when a newer version is active;
- exact route-restoration selection;
- dry-run behavior;
- successful mock route creation and verification;
- refusal to take over another Worker's route; and
- bounded sitemap timeouts and short-circuiting;
- robots, meta/HTTP indexing, and broadened-route detection;
- confirmed weather failure and the persisted request cap;
- failed recovery, process restart, and successful verification without duplicate rollback;
- deployment supersession and operator stop before recovery;
- actual runner start, first-hour checkpoint, scheduled resumption, and stop; and
- expiry without a false recovery claim.

A live read-only run against isolated staging and the production Cloudflare control plane passed the complete proposed sitemap, route, weather, asset, canonical, Popular, and alphabetical-order checks.

Before production approval, record the passing `rehearse` job URL on the reviewed monitor commit. After merging the operations workflow, verify repository Actions permissions, secret/variable names, scheduled availability, and operator notifications. The simulated rehearsal verifies orchestration, not live credentials or permission to mutate Cloudflare. Retain live read-only preflight evidence separately. No production deployment may begin without both gates.

## Approval boundary

Final production approval must authorize exactly:

1. merge PR #15;
2. build and deploy its exact merged commit using `wrangler.weather-production-route.toml`;
3. start the 24-hour GitHub-hosted monitor;
4. automatically roll back only after the confirmed critical threshold;
5. restore only `www.wetbulb35.com/*` to `wetbulb35-weather-production` if the exact route is absent;
6. submit the sitemap after the first stable hour; and
7. make no DNS, apex, custom-domain, unrelated route, or Vercel-removal change.
