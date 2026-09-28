import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import worker from "../workers/apex-redirect.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("apex redirect uses a permanent canonical redirect and preserves path and query", async () => {
  const response = await worker.fetch(new Request("https://wetbulb35.com/wetbulb-temperature/united-states/texas/houston/?source=test&unit=c"));
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://www.wetbulb35.com/wetbulb-temperature/united-states/texas/houston/?source=test&unit=c");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=63072000");
  assert.equal(response.headers.get("cache-control"), "public, max-age=14400, must-revalidate");
});

test("apex redirect refuses unexpected hosts", async () => {
  const response = await worker.fetch(new Request("https://www.wetbulb35.com/path?x=1"));
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("location"), null);
});

test("production domain configs contain only their exact custom domains", () => {
  const weather = fs.readFileSync(path.join(root, "wrangler.weather-production-domain.toml"), "utf8");
  const apex = fs.readFileSync(path.join(root, "wrangler.apex-redirect-production.toml"), "utf8");
  assert.match(weather, /^routes = \[\{ pattern = "www\.wetbulb35\.com", custom_domain = true \}\]$/m);
  assert.doesNotMatch(weather, /zone_name|route\s*=/);
  assert.match(apex, /^routes = \[\{ pattern = "wetbulb35\.com", custom_domain = true \}\]$/m);
  assert.doesNotMatch(apex, /zone_name|route\s*=/);
  assert.equal(fs.existsSync(path.join(root, "wrangler.weather-production-route.toml")), false);
  assert.equal(fs.existsSync(path.join(root, "scripts/restore-production-worker-route.mjs")), false);
});
