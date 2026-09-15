import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { pollingPhase, runReleaseChecks } from "../scripts/production-release-monitor.mjs";
import { restoreProductionRoute, selectRouteAction } from "../scripts/restore-production-worker-route.mjs";

const EXPECTED = "11111111-1111-4111-8111-111111111111";
const ROLLBACK = "22222222-2222-4222-8222-222222222222";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function cards(prefix, count) {
  return Array.from({ length: count }, (_, index) => `<a class="p-4 border rounded-lg hover:bg-gray-50 transition-colors" href="/${prefix}/${String(index).padStart(4, "0")}/"><div class="font-semibold">${prefix} ${String(index).padStart(4, "0")}</div></a>`).join("");
}

function canonical(path) {
  return `<html><head><link rel="canonical" href="https://www.wetbulb35.com${path}"></head></html>`;
}

function state() {
  return {
    activeVersion: EXPECTED,
    routes: [{ id: "route-1", pattern: "www.wetbulb35.com/*", script: "wetbulb35-weather-production" }],
    failBrowse: false,
    failWeather: false,
  };
}

async function fixture() {
  const fixtureState = state();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.test");
    const send = (status, type, body = "") => {
      response.writeHead(status, { "content-type": type });
      if (request.method !== "HEAD") response.end(body); else response.end();
    };
    if (url.pathname === "/client/v4/accounts/account-1/workers/scripts/wetbulb35-weather-production/deployments") {
      return send(200, "application/json", JSON.stringify({ success: true, result: { deployments: [{ id: "deployment-1", versions: [{ version_id: fixtureState.activeVersion, percentage: 100 }] }] } }));
    }
    if (url.pathname === "/client/v4/zones" && request.method === "GET") {
      return send(200, "application/json", JSON.stringify({ success: true, result: [{ id: "zone-1", name: "wetbulb35.com", status: "active" }] }));
    }
    if (url.pathname === "/client/v4/zones/zone-1/workers/routes" && request.method === "GET") {
      return send(200, "application/json", JSON.stringify({ success: true, result: fixtureState.routes }));
    }
    if (url.pathname === "/client/v4/zones/zone-1/workers/routes" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const route = JSON.parse(body);
        fixtureState.routes.push({ id: "route-restored", ...route });
        send(200, "application/json", JSON.stringify({ success: true, result: fixtureState.routes.at(-1) }));
      });
      return;
    }
    if (url.pathname === "/") return send(200, "text/html", "<title>Current Wet Bulb Temperature</title>");
    if (url.pathname === "/wetbulb-temperature/") {
      if (fixtureState.failBrowse) return send(500, "text/plain", "failed");
      const links = Array.from({ length: 40 }, (_, index) => `<a href="/wetbulb-temperature/test/r/city-${index}/">City ${index}</a>`).join("");
      return send(200, "text/html", `<title>Wet Bulb Temperature by Country</title><section aria-labelledby="popular-wet-bulb-temperatures">${links}</section>`);
    }
    if (url.pathname === "/wetbulb-temperature/united-states/") return send(200, "text/html", cards("State", 51));
    if (url.pathname === "/wetbulb-temperature/united-states/texas/") return send(200, "text/html", cards("City", 1_009));
    if (url.pathname === "/wetbulb-temperature/united-states/texas/houston/") return send(200, "text/html", canonical(url.pathname));
    if (url.pathname === "/wetbulb-temperature/singapore/singapore/singapore/" || url.pathname === "/wetbulb-temperature/hong-kong/hong-kong/hong-kong/") return send(200, "text/html", canonical(url.pathname));
    if (url.pathname === "/assets/app.js") return send(200, "text/javascript", "maps.googleapis.com/maps/api/js fetchWeather");
    if (url.pathname === "/assets/locations.json") return send(200, "application/json", "[]");
    if (url.pathname === "/robots.txt") return send(200, "text/plain", "Sitemap: https://www.wetbulb35.com/sitemap.xml");
    if (url.pathname === "/sitemap.xml") {
      const members = Array.from({ length: 228 }, (_, index) => `<sitemap><loc>https://www.wetbulb35.com/sitemaps/sitemap-${index}.xml</loc></sitemap>`).join("");
      return send(200, "application/xml", `<sitemapindex>${members}</sitemapindex>`);
    }
    if (url.pathname === "/api/weather") return fixtureState.failWeather
      ? send(500, "application/json", JSON.stringify({ error: "provider unavailable" }))
      : send(200, "application/json", JSON.stringify({ weather: { temperature: 30, humidity: 70, wetBulb: 25 } }));
    return send(404, "text/plain", "missing");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return { server, state: fixtureState, origin, apiBase: `${origin}/client/v4` };
}

test("release monitor detects health, failure, rollback eligibility, and stale monitors", async () => {
  const mock = await fixture();
  try {
    const options = { origin: mock.origin, apiBase: mock.apiBase, token: "test-token", accountId: "account-1", expectedVersion: EXPECTED, rollbackVersion: ROLLBACK, weather: true };
    const healthy = await runReleaseChecks(options);
    assert.equal(healthy.status, "healthy");
    assert.equal(healthy.rollbackEligible, false);

    mock.state.failWeather = true;
    const weatherWarning = await runReleaseChecks(options);
    assert.equal(weatherWarning.status, "healthy_with_weather_warning");
    assert.equal(weatherWarning.rollbackEligible, false);
    mock.state.failWeather = false;

    mock.state.failBrowse = true;
    const failed = await runReleaseChecks(options);
    const confirmed = await runReleaseChecks(options);
    assert.equal(failed.status, "critical_failure");
    assert.equal(failed.rollbackEligible, true);
    assert.equal(confirmed.status, "critical_failure");
    assert.equal(confirmed.rollbackEligible, true);
    assert.ok(failed.criticalFailures.some((failure) => failure.startsWith("browse:")));

    mock.state.failBrowse = false;
    mock.state.routes = [];
    const missingRoute = await runReleaseChecks(options);
    assert.equal(missingRoute.rollbackEligible, true);
    assert.ok(missingRoute.criticalFailures.some((failure) => failure.startsWith("production_route:")));

    mock.state.routes = [{ id: "route-1", pattern: "www.wetbulb35.com/*", script: "wetbulb35-weather-production" }];
    mock.state.activeVersion = "33333333-3333-4333-8333-333333333333";
    const stale = await runReleaseChecks(options);
    assert.equal(stale.status, "superseded");
    assert.equal(stale.rollbackEligible, false);
  } finally {
    mock.server.close();
  }
});

test("route restoration is exact, dry-run first, verified, and refuses takeover", async () => {
  assert.equal(selectRouteAction([]).action, "create");
  assert.equal(selectRouteAction([{ pattern: "www.wetbulb35.com/*", script: "another-worker" }]).action, "refuse");
  const mock = await fixture();
  try {
    mock.state.routes = [];
    const dryRun = await restoreProductionRoute({ fetchImpl: fetch, apiBase: mock.apiBase, token: "test-token", apply: false });
    assert.equal(dryRun.status, "dry_run_create");
    assert.equal(mock.state.routes.length, 0);
    const applied = await restoreProductionRoute({ fetchImpl: fetch, apiBase: mock.apiBase, token: "test-token", apply: true });
    assert.equal(applied.status, "restored");
    assert.equal(mock.state.routes.length, 1);
    assert.deepEqual({ pattern: mock.state.routes[0].pattern, script: mock.state.routes[0].script }, { pattern: "www.wetbulb35.com/*", script: "wetbulb35-weather-production" });
  } finally {
    mock.server.close();
  }
});

test("polling schedule is two minutes, then thirty minutes, and expires after 24 hours", () => {
  const startedAt = "2026-09-15T00:00:00Z";
  assert.deepEqual(pollingPhase({ startedAt, lastCheckedAt: null, now: new Date("2026-09-15T00:00:00Z") }).intervalMinutes, 2);
  assert.equal(pollingPhase({ startedAt, lastCheckedAt: "2026-09-15T00:00:00Z", now: new Date("2026-09-15T00:01:00Z") }).due, false);
  assert.equal(pollingPhase({ startedAt, lastCheckedAt: "2026-09-15T00:00:00Z", now: new Date("2026-09-15T00:02:00Z") }).due, true);
  assert.equal(pollingPhase({ startedAt, lastCheckedAt: "2026-09-15T01:00:00Z", now: new Date("2026-09-15T01:29:00Z") }).due, false);
  assert.equal(pollingPhase({ startedAt, lastCheckedAt: "2026-09-15T01:00:00Z", now: new Date("2026-09-15T01:30:00Z") }).due, true);
  assert.equal(pollingPhase({ startedAt, lastCheckedAt: "2026-09-15T23:30:00Z", now: new Date("2026-09-16T00:00:00Z") }).expired, true);
});

test("production deploy wrapper is approval-gated and can only use the route-bearing config", () => {
  const script = fs.readFileSync(path.join(root, "scripts/deploy-production-release.sh"), "utf8");
  const deployCommands = script.split("\n").filter((line) => line.includes("wrangler deploy"));
  assert.deepEqual(deployCommands, ["./node_modules/.bin/wrangler deploy --config wrangler.weather-production-route.toml"]);
  assert.doesNotMatch(deployCommands[0], /wrangler\.weather-production\.toml(?:\s|$)/);
  const refusal = spawnSync("bash", [path.join(root, "scripts/deploy-production-release.sh")], { cwd: root, encoding: "utf8" });
  assert.equal(refusal.status, 2);
  assert.match(refusal.stderr, /Refusing production deploy/);
});
