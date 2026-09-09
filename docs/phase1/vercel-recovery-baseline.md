# Vercel recovery baseline

Captured **2026-09-09T12:30:09Z** by `scripts/capture-vercel-recovery-baseline.sh` with the installed, authenticated native Vercel CLI `59.11.7`. The script uses authenticated Vercel CLI reads and a production HEAD request only; it does not deploy, promote, rollback, edit Vercel settings, domains, or environment variables.

## Recovery identity

- Scope: `michaels-projects-899a0e11` (`team_RBAXXuGiv43ShbhlGU7Fs0LA`)
- Project: `wetbulb2` (`prj_5MhIySYFwcqz6P5N0HhCL8s0ZsuZ`)
- Current production: `dpl_98CXao2fnVfTWFmn8AxFeuNSnUXe`, `READY`, source `f6acf975b57d3352cfaaa45db3164e5389ea2c3a` on `main`.
- Production deployment URL: `wetbulb2-nc0ku4gtp-michaels-projects-899a0e11.vercel.app`.
- Production aliases: `www.wetbulb35.com`, `wetbulb35.com`, `wetbulb2.vercel.app`, the project Vercel alias, and the `main` branch alias. The canonical host returned HTTP 200 through Cloudflare with `x-vercel-cache: HIT`.

## Rollback evidence

`captures/vercel/deployment-inventory.json` contains all **42** deployments returned by the CLI at capture time, with URLs, state/target/timestamps, source ref/SHA, aliases, and deployment IDs where the CLI could inspect them. The three ERROR deployments could not be inspected for IDs, but their rollback-relevant list metadata is retained. This is an inventory of presently listed deployments, not a retention guarantee. The retained production deployment above is the current rollback candidate; routing/DNS control remains in Cloudflare and is out of scope.

## Build/runtime baseline

- Framework preset: Other; root directory: `.`; Node.js: `22.x`.
- Install command: `npm ci`; build command: `npm run vercel-build`; ignore command: `node scripts/should-ignore-vercel-build.mjs`.
- Production build uses `@vercel/vc-build`, created in `sfo1`.
- One captured lambda: `api/weather`, Node.js `22.x`, 1024 MB, 10-second timeout, deployed to `iad1`.

## Environment recovery boundary

`captures/vercel/environment-metadata.json` lists four variable names, targets, types, and timestamps only. No values are committed.

The external protected file is recorded, hashed, sized, and permission-checked in `captures/vercel/recovery-manifest.json`. It is mode `0600` and contains every production value the CLI can retrieve. **It is not a complete recovery copy:** Vercel declined to reveal one existing `sensitive` value and wrote `[SENSITIVE]` instead. Recover that value from its original secret source; neither CLI nor normal dashboard viewing can reveal an already-stored sensitive value. Do not place it in Git.

## Observability and gaps

- `vercel usage --group-by project --json` returned `Costs not found (404)`; no usable account/project usage metric was accessible.
- This CLI version has no `analytics` command. Vercel Web Analytics and request/function observability require separate dashboard/product entitlement and were not retrievable here.
- DNS/Cloudflare configuration, analytics dashboards, Observability Plus metrics, and the unrevealed sensitive environment value require their respective control-plane access.

## Rerun

From the repository root:

```bash
./scripts/capture-vercel-recovery-baseline.sh
```

Optional environment overrides: `VERCEL_SCOPE`, `VERCEL_PROJECT`, `VERCEL_CAPTURE_DIR`, `VERCEL_BACKUP_DIR`, and `VERCEL_BIN`. By default the script resolves the installed `vercel` executable on `PATH`; if it is absent, the script fails before creating capture output or making a remote request. Set `VERCEL_BIN` to an explicit executable name or path when needed. The script never downloads a CLI package. Each run records the detected CLI version in `captures/vercel/recovery-manifest.json`, replaces sanitized repository captures, and creates a new timestamped private backup under `~/.hermes/backups/wetbulb35/vercel/`.
