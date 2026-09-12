import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const harness = path.join(root, "scripts/staging-load-harness.mjs");
function run(...args) { return spawnSync(process.execPath, [harness, ...args], { cwd: root, encoding: "utf8", timeout: 30_000 }); }
function output(result) { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); }

test("load harness includes warm weather request in the twenty-request cap", () => {
  const defaultRun = output(run("--mode=fake"));
  assert.equal(defaultRun.bounds.weather_measured_requests, 4);
  assert.equal(defaultRun.bounds.weather_total_requests, 5);
  const maxRun = output(run("--mode=fake", "--weather-requests=19"));
  assert.equal(maxRun.bounds.weather_total_requests, 20);
  const rejected = run("--mode=fake", "--weather-requests=20");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /weather-requests must be an integer from 0 to 19/);
});

test("HTML-only harness mode performs zero weather requests", () => {
  const result = output(run("--mode=fake", "--weather-requests=0"));
  assert.equal(result.bounds.weather_measured_requests, 0);
  assert.equal(result.bounds.weather_total_requests, 0);
  assert.equal(result.warm_status, null);
  assert.equal(result.weather.count, 0);
  assert.deepEqual(result.weather.statuses, {});
});
