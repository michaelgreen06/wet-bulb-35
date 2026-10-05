import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = path.resolve(import.meta.dirname, "../.github/workflows/hotspot-r2-credential-preflight.yml");

test("hosted R2 credential preflight is manual and metadata-only", () => {
  const source = fs.readFileSync(workflow, "utf8");
  assert.match(source, /^on:\s*\n  workflow_dispatch:/m);
  assert.doesNotMatch(source, /\b(schedule|pull_request|push):/);
  assert.match(source, /timeout-minutes: 10/);
  assert.match(source, /curl --fail-with-body --silent --show-error --max-time 15/);
  assert.match(source, /api\.cloudflare\.com\/client\/v4\/accounts\/\$CLOUDFLARE_ACCOUNT_ID\/r2\/buckets\/\$HOTSPOT_R2_BUCKET/);
  assert.match(source, /secrets\.WETBULB35_CLOUDFLARE_API_TOKEN/);
  assert.match(source, /vars\.HOTSPOT_R2_BUCKET/);
  assert.doesNotMatch(source, /\br2 object (put|delete)\b|wrangler deploy|generate:hotspot-snapshot|await-ifs-run-readiness|OPEN_METEO_API_KEY|npm ci|POST|PUT|DELETE/);
  const script = source.split("        run: |\n")[1]?.replace(/^          /gm, "");
  assert.ok(script, "preflight must have exactly one shell step");
  const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("read-only preflight parses hosted metadata without publishing or retaining the response", () => {
  const source = fs.readFileSync(workflow, "utf8");
  const script = source.split("        run: |\n")[1].replace(/^          /gm, "");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotspot-hosted-preflight-"));
  try {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nprintf '%s\\n' '{\"success\":true,\"result\":{\"name\":\"bucket\"}}'\n", { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: root,
      CLOUDFLARE_ACCOUNT_ID: "f".repeat(32),
      CLOUDFLARE_API_TOKEN: "fake-sensitive-token",
      HOTSPOT_R2_BUCKET: "bucket",
    };
    const result = spawnSync("bash", ["-e"], { input: script, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /object read\/write permission remains unverified/);
    assert.doesNotMatch(result.stdout + result.stderr, /fake-sensitive-token/);
    assert.deepEqual(fs.readdirSync(root).sort(), ["bin"]);
    env.HOTSPOT_R2_BUCKET = "other-bucket";
    const mismatch = spawnSync("bash", ["-e"], { input: script, env, encoding: "utf8" });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /did not identify the configured bucket/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
