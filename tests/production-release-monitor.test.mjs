import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { pollingPhase, runReleaseChecks, selectCustomDomainBinding } from "../scripts/production-release-monitor.mjs";
import { indexable, robotsAllowPublicPages } from "../scripts/release-indexing-checks.mjs";
import { advanceMonitor, confirmedChecks, recoverRelease, newMonitorState } from "../scripts/production-monitor-control.mjs";
import { validateProductionConfig } from "../scripts/validate-production-release-config.mjs";

const EXPECTED = "11111111-1111-4111-8111-111111111111";
const ROLLBACK = "22222222-2222-4222-8222-222222222222";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);

function cards(prefix, count) {
  return Array.from({ length: count }, (_, index) => `<a class="p-4 border rounded-lg hover:bg-gray-50 transition-colors" href="/${prefix}/${String(index).padStart(4, "0")}/"><div class="font-semibold">${prefix} ${String(index).padStart(4, "0")}</div></a>`).join("");
}

function canonical(path) {
  return `<html><head><link rel="canonical" href="https://www.wetbulb35.com${path}"></head></html>`;
}

function state() {
  return {
    activeVersion: EXPECTED,
    domains: [{ id: "domain-1", hostname: "www.wetbulb35.com", service: "wetbulb35-weather-production", environment: "production", status: "active" }],
    failBrowse: false,
    failWeather: false,
    requests: [],
  };
}

async function fixture() {
  const fixtureState = state();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.test");
    fixtureState.requests.push(`${request.method} ${url.pathname}`);
    const send = (status, type, body = "") => {
      response.writeHead(status, { "content-type": type });
      response.end(request.method === "HEAD" ? "" : body);
    };
    if (url.pathname === "/client/v4/accounts/account-1/workers/scripts/wetbulb35-weather-production/deployments") {
      return send(200, "application/json", JSON.stringify({ success: true, result: { deployments: [
        { id: "old", created_on: "2026-09-01T00:00:00Z", versions: [{ version_id: "00000000-0000-4000-8000-000000000000", percentage: 100 }] },
        { id: "active", created_on: "2026-09-15T00:00:00Z", versions: [{ version_id: fixtureState.activeVersion, percentage: 100 }] },
      ] } }));
    }
    if (url.pathname === "/client/v4/accounts/account-1/workers/domains") return send(200, "application/json", JSON.stringify({ success: true, result: fixtureState.domains }));
    if (url.pathname === "/test/rollback" && request.method === "POST") {
      fixtureState.rollbackCalls = (fixtureState.rollbackCalls || 0) + 1;
      fixtureState.activeVersion = ROLLBACK;
      fixtureState.failBrowse = false;
      return send(200, "application/json", "{}");
    }
    if (url.pathname === "/") return send(200, "text/html", canonical("/") + "<title>Current Wet Bulb Temperature</title>");
    if (url.pathname === "/wetbulb-temperature/") {
      if (fixtureState.failBrowse) return send(500, "text/plain", "failed");
      const links = Array.from({ length: 40 }, (_, index) => `<a href="/wetbulb-temperature/test/r/city-${index}/">City ${index}</a>`).join("");
      return send(200, "text/html", canonical(url.pathname) + `<title>Wet Bulb Temperature by Country</title><section aria-labelledby="popular-wet-bulb-temperatures">${links}</section>`);
    }
    if (url.pathname === "/wetbulb-temperature/united-states/") return send(200, "text/html", canonical(url.pathname) + cards("State", 51));
    if (url.pathname === "/wetbulb-temperature/united-states/texas/") return send(200, "text/html", canonical(url.pathname) + cards("City", 1_009));
    if (url.pathname === "/wetbulb-temperature/united-states/texas/houston/" || url.pathname === "/wetbulb-temperature/singapore/singapore/singapore/" || url.pathname === "/wetbulb-temperature/hong-kong/hong-kong/hong-kong/") return send(200, "text/html", canonical(url.pathname));
    if (url.pathname === "/assets/app.js") return send(200, "text/javascript", "maps.googleapis.com/maps/api/js fetchWeather");
    if (url.pathname === "/assets/locations.json") return send(200, "application/json", "[]");
    if (url.pathname === "/robots.txt") return send(200, "text/plain", "Sitemap: https://www.wetbulb35.com/sitemap.xml");
    if (url.pathname === "/sitemap.xml") {
      const count = fixtureState.activeVersion === ROLLBACK ? 227 : 228;
      return send(200, "application/xml", `<sitemapindex>${Array.from({ length: count }, (_, index) => `<sitemap><loc>https://www.wetbulb35.com/sitemaps/sitemap-${index}.xml</loc></sitemap>`).join("")}</sitemapindex>`);
    }
    if (url.pathname === "/api/weather") return fixtureState.failWeather
      ? send(500, "application/json", JSON.stringify({ error: "provider unavailable" }))
      : send(200, "application/json", JSON.stringify({ location: { name: "Test", lat: 30, lng: 10 }, weather: { temperature: 30, humidity: 70, wetBulb: 25, timestamp: Date.now() } }));
    return send(404, "text/plain", "missing");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  return { server, state: fixtureState, origin, apiBase: `${origin}/client/v4` };
}

const optionsFor = (mock) => ({ origin: mock.origin, apiBase: mock.apiBase, token: "test-token", accountId: "account-1", expectedVersion: EXPECTED, rollbackVersion: ROLLBACK });

test("monitor requires one enabled production custom domain and never queries routes", async () => {
  const mock = await fixture();
  try {
    const healthy = await runReleaseChecks(optionsFor(mock));
    assert.equal(healthy.status, "healthy");
    assert.equal(healthy.rollbackEligible, false);
    assert.ok(mock.state.requests.includes("GET /client/v4/accounts/account-1/workers/domains"));
    assert.equal(mock.state.requests.some((request) => request.includes("/workers/routes")), false);

    mock.state.domains = [];
    const missing = await runReleaseChecks(optionsFor(mock));
    assert.equal(missing.rollbackEligible, true);
    assert.ok(missing.criticalFailures.some((failure) => failure.startsWith("production_custom_domain:")));

    mock.state.domains = [
      { id: "domain-1", hostname: "www.wetbulb35.com", service: "wetbulb35-weather-production", environment: "production", status: "active" },
      { id: "domain-2", hostname: "www.wetbulb35.com", service: "another-worker", environment: "production", status: "active" },
    ];
    assert.equal((await runReleaseChecks(optionsFor(mock))).rollbackEligible, true);

    mock.state.domains = [{ id: "domain-1", hostname: "www.wetbulb35.com", service: "wetbulb35-weather-production", environment: "production", status: "pending" }];
    assert.equal((await runReleaseChecks(optionsFor(mock))).rollbackEligible, true);
  } finally { mock.server.close(); }
});

test("custom-domain selection fails closed on duplicates, other services, or disabled records", () => {
  const exact = { id: "domain-1", hostname: "www.wetbulb35.com", service: "wetbulb35-weather-production", environment: "production", status: "active" };
  assert.equal(selectCustomDomainBinding([exact]).healthy, true);
  for (const domains of [[], [{ ...exact, status: "pending" }], [{ ...exact, service: "another-worker" }], [exact, { ...exact, id: "domain-2" }]]) {
    assert.equal(selectCustomDomainBinding(domains).healthy, false);
  }
});

test("weather failures warn without rollback while page failures are rollback eligible", async () => {
  const mock = await fixture();
  try {
    mock.state.failWeather = true;
    const weather = await runReleaseChecks({ ...optionsFor(mock), weather: true });
    assert.equal(weather.status, "healthy");
    assert.ok(weather.warnings.some((warning) => warning.startsWith("weather_")));
    mock.state.failWeather = false;
    mock.state.failBrowse = true;
    const failed = await runReleaseChecks(optionsFor(mock));
    assert.equal(failed.status, "critical_failure");
    assert.equal(failed.rollbackEligible, true);
  } finally { mock.server.close(); }
});

test("rollback changes only the Worker version and verifies the existing custom domain", async () => {
  const mock = await fixture();
  try {
    mock.state.failBrowse = true;
    const result = await recoverRelease(optionsFor(mock), {
      rollback: async (version) => { assert.equal(version, ROLLBACK); mock.state.activeVersion = version; mock.state.failBrowse = false; },
    });
    assert.equal(result.status, "recovered");
    assert.equal(mock.state.activeVersion, ROLLBACK);
    assert.equal(mock.state.domains.length, 1);
    assert.equal(mock.state.requests.some((request) => request.includes("/workers/routes")), false);
  } finally { mock.server.close(); }
});

test("stale monitors refuse rollback and weather-only monitor cycles do not recover", async () => {
  const mock = await fixture();
  try {
    mock.state.activeVersion = "33333333-3333-4333-8333-333333333333";
    let mutations = 0;
    assert.equal((await recoverRelease(optionsFor(mock), { rollback: async () => mutations++ })).status, "superseded");
    assert.equal(mutations, 0);
    mock.state.activeVersion = EXPECTED;
    mock.state.failWeather = true;
    let rolledBack = false;
    const monitor = newMonitorState({ expectedVersion: EXPECTED, rollbackVersion: ROLLBACK, releaseSha: "a".repeat(40), now: new Date("2026-09-15T00:00:00Z") });
    const state = await advanceMonitor(monitor, { save: async () => {}, notify: async () => {}, now: () => new Date("2026-09-15T00:00:00Z"), options: optionsFor(mock), checks: (args) => confirmedChecks(args, { sleep: async () => {} }), recover: async () => { rolledBack = true; } });
    assert.equal(state.status, "active");
    assert.equal(rolledBack, false);
  } finally { mock.server.close(); }
});

test("production deploy wrapper and config only use the custom-domain config", () => {
  const script = fs.readFileSync(path.join(root, "scripts/deploy-production-release.sh"), "utf8");
  const deployCommands = script.split("\n").filter((line) => line.includes("wrangler deploy"));
  assert.deepEqual(deployCommands, ["./node_modules/.bin/wrangler deploy --config wrangler.weather-production-domain.toml"]);
  assert.match(script, /--approved-existing-custom-domain-deploy/);
  const refusal = spawnSync("bash", [path.join(root, "scripts/deploy-production-release.sh")], { cwd: root, encoding: "utf8" });
  assert.equal(refusal.status, 2);
  assert.match(refusal.stderr, /custom-domain-deploy/);

  const config = fs.readFileSync(path.join(root, "wrangler.weather-production-domain.toml"), "utf8");
  assert.doesNotThrow(() => validateProductionConfig(config));
  assert.throws(() => validateProductionConfig(config.replace("custom_domain = true", "custom_domain = false")));
  assert.throws(() => validateProductionConfig(config + "\nroute = \"www.wetbulb35.com/*\"\n"));
  assert.throws(() => validateProductionConfig(config.replace("www.wetbulb35.com", "*.wetbulb35.com")));
});

test("polling schedule and indexing guards retain bounded release behavior", () => {
  const startedAt = "2026-09-15T00:00:00Z";
  assert.equal(pollingPhase({ startedAt, lastCheckedAt: null, now: new Date(startedAt) }).intervalMinutes, 2);
  assert.equal(pollingPhase({ startedAt, lastCheckedAt: startedAt, now: new Date("2026-09-15T01:30:00Z") }).due, true);
  assert.equal(pollingPhase({ startedAt, lastCheckedAt: startedAt, now: new Date("2026-09-16T00:00:00Z") }).expired, true);
  assert.equal(indexable('<meta name="robots" content="noindex">', new Response()), false);
  assert.equal(robotsAllowPublicPages("User-agent: *\nDisallow: /api/\nAllow: /", ["/", "/wetbulb-temperature/"]), true);
});

test("shell rollback entry point performs no domain mutation and verifies recovery", async () => {
  const mock = await fixture();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "release-shell-rehearsal-"));
  try {
    const hook = path.join(temp, "mock-fetch.mjs");
    fs.writeFileSync(hook, `const original = globalThis.fetch; globalThis.fetch = (input, options) => { const url = new URL(input); return original(new URL(url.pathname + url.search, ${JSON.stringify(mock.origin)}), options); };`);
    const npx = path.join(temp, "npx");
    fs.writeFileSync(npx, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== ${JSON.stringify(`--yes wrangler@4.129.1 rollback ${ROLLBACK} --name wetbulb35-weather-production --message Confirmed production release failure --yes`)}) process.exit(9);\nconst response = await fetch(${JSON.stringify(mock.origin + "/test/rollback")}, {method:'POST'}); if (!response.ok) process.exit(8);\n`);
    fs.chmodSync(npx, 0o755);
    const env = { ...process.env, PATH: `${temp}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, NODE_OPTIONS: `--import=${hook}`, CLOUDFLARE_API_TOKEN: "test-only", CLOUDFLARE_ACCOUNT_ID: "account-1" };
    mock.state.failBrowse = true;
    const result = await execute("bash", ["scripts/execute-production-rollback.sh", EXPECTED, ROLLBACK], { cwd: root, env });
    assert.equal(JSON.parse(result.stdout).status, "recovered");
    assert.equal(mock.state.rollbackCalls, 1);
    assert.equal(mock.state.requests.some((request) => request.includes("/workers/routes")), false);
  } finally {
    mock.server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
