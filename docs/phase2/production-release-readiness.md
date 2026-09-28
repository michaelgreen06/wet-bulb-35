# Production release operations

## Current serving architecture

As of **September 27, 2026**, production has no Vercel fallback and no Cloudflare Worker route:

- `www.wetbulb35.com` is the one enabled production custom domain for Worker `wetbulb35-weather-production`.
- `wetbulb35.com` is the one enabled production custom domain for Worker `wetbulb35-apex-redirect`.
- The apex Worker returns a `308` to `https://www.wetbulb35.com`, preserving the request path and query string. It sends HSTS and cache headers and rejects requests for any other host.
- The retired Vercel project, DNS records, and Worker routes must not be recreated as a rollback or deployment fallback.

Historical cutover and Vercel documents remain historical records only; they are not operational instructions.

## Production deployment

Only the reviewed production wrapper may deploy the weather Worker:

```sh
EXPECTED_RELEASE_SHA=<approved-40-character-commit> \
  scripts/deploy-production-release.sh --approved-existing-custom-domain-deploy
```

The wrapper requires an exact clean commit and deployment credentials, validates `wrangler.weather-production-domain.toml`, runs the release checks, builds assets, and deploys only:

```sh
./node_modules/.bin/wrangler deploy --config wrangler.weather-production-domain.toml
```

That config must continue to name only `wetbulb35-weather-production` and this exact custom domain:

```toml
routes = [{ pattern = "www.wetbulb35.com", custom_domain = true }]
```

It must not contain a Worker route, `zone_name`, wildcard hostname, or a second domain. The version-controlled apex configuration is `wrangler.apex-redirect-production.toml`; it is a separate service and must only contain the exact `wetbulb35.com` custom domain.

Credential-free validation:

```sh
npm run test:production-release-monitor
npm run test:apex-redirect
npm run dry-run:weather-production-domain
npm run dry-run:apex-redirect-production
```

Dry runs validate packaging only. They do not authorize deploys and must not be used to change live bindings.

## Durable monitor

`.github/workflows/production-release-monitor.yml` runs the monitored release state machine on GitHub-hosted Actions. State is retained in exactly one labeled GitHub issue, including the expected and rollback Worker versions, approved release SHA, timestamps, weather budget, and last result.

The monitor reads two Cloudflare control-plane facts:

1. The active deployment for `wetbulb35-weather-production` is 100% the expected version (or the rollback version while recovery is being verified).
2. `GET /accounts/{account_id}/workers/domains` reports **exactly one** `www.wetbulb35.com` record with:
   - `service: wetbulb35-weather-production`
   - `environment: production`
   - `enabled: true`
   - a nonempty `cert_id` (certificate evidence)

Any absent, pending, disabled, duplicate, or wrong-service `www` binding is a critical failure. The monitor intentionally does not inspect, create, restore, or rely on Worker routes, DNS records, or Vercel.

The first hour checks every two minutes; the remaining window checks every 30 minutes until 24 hours. Full sitemap checks run at bounded milestones. Two matching critical failure categories, separated by 20 seconds, are required before rollback. A stale monitor stops without mutation when another version is active.

Weather checks remain warn-only: provider failures create a warning and never make a release rollback-eligible.

## Rollback and recovery

A confirmed release regression may run only one mutation:

```sh
npx --yes wrangler@4.129.1 rollback <last-known-good-version> \
  --name wetbulb35-weather-production \
  --message "Confirmed production release failure" \
  --yes
```

Before that command, the monitor re-reads the active version and refuses to roll back if it is no longer the failed expected version. Afterwards it re-reads the active version, verifies the same enabled `www` custom-domain binding, and repeats public health checks. It never restores a route, changes DNS, modifies an apex binding, or recreates Vercel.

If rollback or verification fails, monitor state remains `recovering`, GitHub Actions fails, and the retained issue records a critical incident. A later eligible runner may retry version rollback verification; it still has no authority to alter custom-domain records.

## Approval boundary

A production approval must identify the exact merged commit and explicitly authorize only:

1. deployment of `wetbulb35-weather-production` through its existing `www.wetbulb35.com` custom domain;
2. the 24-hour GitHub-hosted monitor; and
3. version-only rollback to the recorded last-known-good Worker version after the confirmed failure threshold.

It does not authorize binding changes, DNS changes, Worker routes, apex changes, Vercel restoration, merge, or unrelated Worker deployment.
