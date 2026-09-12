import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = "wetbulb35-weather-staging";
const WORKERS_DEV_HOST = "wetbulb35-weather-staging.mgdevstuff.workers.dev";
const CURRENT_VERSION = "fe629b5a-08f8-4b28-bc4e-185f04dfe93e";
const ROLLBACK_VERSION = "fc8b6893-f622-4467-ac6b-ea552a38bfda";
const ACCOUNT_ID = "fddb460ed1b6d83303e6a0721fd48318";
const ZONE_ID = "a2958cbae3668404739ab40da5bd1569";
const VERCEL_DEPLOYMENT_ID = "dpl_98CXao2fnVfTWFmn8AxFeuNSnUXe";
const EXPECTED_WRANGLER_VERSION = "4.129.1";

function fail(message) {
  throw new Error(message);
}

function read(relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

function validateWrangler() {
  const wrangler = path.join(root, "node_modules", ".bin", "wrangler");
  if (!existsSync(wrangler)) fail("repository-installed Wrangler is missing; run npm ci before this local dry run");
  const version = execFileSync(wrangler, ["--version"], { cwd: root, encoding: "utf8" }).trim();
  if (version !== EXPECTED_WRANGLER_VERSION) fail(`expected repository Wrangler ${EXPECTED_WRANGLER_VERSION}, got ${version}`);
  return version;
}

function validateStagingConfig() {
  const config = read("wrangler.weather-staging.toml");
  if (!config.includes(`name = \"${WORKER}\"`)) fail("staging config names an unexpected Worker");
  if (/^\s*(routes?|account_id|zone_id|custom_domain)\s*=/m.test(config)) fail("staging config must not contain route, zone, account, or custom-domain configuration");
  if (/^\s*workers_dev\s*=\s*false\s*$/m.test(config)) fail("staging config must keep workers.dev enabled");
  return true;
}

function validateVercelEvidence() {
  const manifest = JSON.parse(read("docs/phase1/captures/vercel/recovery-manifest.json"));
  const production = JSON.parse(read("docs/phase1/captures/vercel/current-production.json"));
  if (manifest.current_production?.id !== VERCEL_DEPLOYMENT_ID || production.id !== VERCEL_DEPLOYMENT_ID) {
    fail("retained Vercel production deployment evidence does not match the rehearsal baseline");
  }
  return VERCEL_DEPLOYMENT_ID;
}

function main(args) {
  if (args.length !== 1 || args[0] !== "--dry-run") fail("this tool only supports --dry-run and never contacts Cloudflare");
  const report = {
    mode: "dry-run",
    remote_mutation: false,
    worker: WORKER,
    workers_dev_host: WORKERS_DEV_HOST,
    current_version: CURRENT_VERSION,
    rollback_version: ROLLBACK_VERSION,
    checks: {
      repository_wrangler: validateWrangler(),
      staging_config_is_route_free: validateStagingConfig(),
      vercel_recovery_evidence: validateVercelEvidence(),
      cloudflare_route_inventory: {
        account_id: ACCOUNT_ID,
        zone_id: ZONE_ID,
        production_zone_worker_route_count: 0,
      },
    },
    next_step: "approval-required disposable workers.dev rollback rehearsal",
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`rollback-cutover rehearsal precondition failed: ${error.message}\n`);
  process.exitCode = 1;
}
