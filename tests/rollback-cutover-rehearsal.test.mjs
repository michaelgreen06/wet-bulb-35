import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const rehearsal = path.join(root, "scripts/rollback-cutover-rehearsal.mjs");
const fakeWrangler = path.join(root, "node_modules", ".bin", "wrangler");
let createdFakeWrangler = false;

before(() => {
  if (existsSync(fakeWrangler)) return;
  mkdirSync(path.dirname(fakeWrangler), { recursive: true });
  writeFileSync(fakeWrangler, "#!/bin/sh\nprintf '4.129.1\\n'\n");
  chmodSync(fakeWrangler, 0o755);
  createdFakeWrangler = true;
});

after(() => {
  if (createdFakeWrangler) rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
});

function run(...args) {
  return spawnSync(process.execPath, [rehearsal, ...args], { cwd: root, encoding: "utf8", timeout: 30_000 });
}

function report(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("dry-run validates only the disposable workers.dev/version rehearsal and is idempotent", () => {
  const first = report(run("--dry-run"));
  const second = report(run("--dry-run"));

  assert.deepEqual(second, first);
  assert.deepEqual(first, {
    mode: "dry-run",
    remote_mutation: false,
    worker: "wetbulb35-weather-staging",
    workers_dev_host: "wetbulb35-weather-staging.mgdevstuff.workers.dev",
    current_version: "fe629b5a-08f8-4b28-bc4e-185f04dfe93e",
    rollback_version: "fc8b6893-f622-4467-ac6b-ea552a38bfda",
    checks: {
      repository_wrangler: "4.129.1",
      staging_config_is_route_free: true,
      vercel_recovery_evidence: "dpl_98CXao2fnVfTWFmn8AxFeuNSnUXe",
      cloudflare_route_inventory: {
        account_id: "fddb460ed1b6d83303e6a0721fd48318",
        zone_id: "a2958cbae3668404739ab40da5bd1569",
        production_zone_worker_route_count: 0,
      },
    },
    next_step: "approval-required disposable workers.dev rollback rehearsal",
  });
});

test("tool refuses anything other than a local dry run", () => {
  const result = run("--execute");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only supports --dry-run/);
});
