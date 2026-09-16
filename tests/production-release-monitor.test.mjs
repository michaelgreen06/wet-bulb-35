import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { pollingPhase, runReleaseChecks } from "../scripts/production-release-monitor.mjs";
import { restoreProductionRoute, selectRouteAction } from "../scripts/restore-production-worker-route.mjs";
import { indexable, robotsAllowPublicPages } from "../scripts/release-indexing-checks.mjs";
import { advanceMonitor, confirmedChecks, recoverRelease, newMonitorState } from "../scripts/production-monitor-control.mjs";
import { issueStore, monitorJob } from "../scripts/run-production-monitor.mjs";
import { validateProductionConfig } from "../scripts/validate-production-release-config.mjs";

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
      return send(200, "application/json", JSON.stringify({ success: true, result: { deployments: [
        // Oldest first, like the live API history: the monitor must pick the newest, not index 0.
        { id: "deployment-0", created_on: "2026-09-01T00:00:00Z", versions: [{ version_id: "00000000-0000-4000-8000-000000000000", percentage: 100 }] },
        { id: "deployment-1", created_on: "2026-09-15T00:00:00Z", versions: [{ version_id: fixtureState.activeVersion, percentage: 100 }] },
      ] } }));
    }
    if (url.pathname === "/client/v4/zones" && request.method === "GET") {
      return send(200, "application/json", JSON.stringify({ success: true, result: [{ id: "zone-1", name: "wetbulb35.com", status: "active" }] }));
    }
    if (url.pathname === "/client/v4/zones/zone-1/workers/routes" && request.method === "GET") {
      return send(200, "application/json", JSON.stringify({ success: true, result: fixtureState.routes }));
    }
    if (url.pathname === "/client/v4/zones/zone-1/workers/routes" && request.method === "POST") {
      if (fixtureState.failRoutePost) return send(503, "application/json", JSON.stringify({ success: false }));
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const route = JSON.parse(body);
        fixtureState.routes.push({ id: "route-restored", ...route });
        send(200, "application/json", JSON.stringify({ success: true, result: fixtureState.routes.at(-1) }));
      });
      return;
    }
    if (url.pathname === "/test/rollback" && request.method === "POST") {
      fixtureState.rollbackCalls = (fixtureState.rollbackCalls || 0) + 1;
      fixtureState.activeVersion = ROLLBACK;
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
    if (url.pathname === "/wetbulb-temperature/united-states/texas/houston/") return send(200, "text/html", canonical(url.pathname));
    if (url.pathname === "/wetbulb-temperature/singapore/singapore/singapore/" || url.pathname === "/wetbulb-temperature/hong-kong/hong-kong/hong-kong/") return send(200, "text/html", canonical(url.pathname));
    if (url.pathname === "/assets/app.js") return send(200, "text/javascript", "maps.googleapis.com/maps/api/js fetchWeather");
    if (url.pathname === "/assets/locations.json") return send(200, "application/json", "[]");
    if (url.pathname === "/robots.txt") return send(200, "text/plain", "Sitemap: https://www.wetbulb35.com/sitemap.xml");
    if (url.pathname === "/sitemap.xml") {
      const members = Array.from({ length: fixtureState.activeVersion === ROLLBACK ? 227 : 228 }, (_, index) => `<sitemap><loc>https://www.wetbulb35.com/sitemaps/sitemap-${index}.xml</loc></sitemap>`).join("");
      return send(200, "application/xml", `<sitemapindex>${members}</sitemapindex>`);
    }
    if (url.pathname === "/api/weather") return fixtureState.failWeather
      ? send(500, "application/json", JSON.stringify({ error: "provider unavailable" }))
      : send(200, "application/json", JSON.stringify({ location: { name: "Test", lat: 30, lng: 10 }, weather: { temperature: 30, humidity: 70, wetBulb: 25, timestamp: Date.now() } }));
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
    const weatherFailure = await runReleaseChecks(options);
    assert.equal(weatherFailure.status, "healthy");
    assert.equal(weatherFailure.rollbackEligible, false);
    assert.ok(weatherFailure.warnings.some((warning) => warning.startsWith("weather_")));
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

const startedAt = "2026-09-15T00:00:00Z";
const newState = () => newMonitorState({ expectedVersion: EXPECTED, rollbackVersion: ROLLBACK, releaseSha: "a".repeat(40), now: new Date(startedAt) });
const healthy = () => ({ status: "healthy", rollbackEligible: false, criticalFailures: [], weatherRequests: 0 });
const failure = (name = "browse:500") => ({ status: "critical_failure", rollbackEligible: true, criticalFailures: [name], weatherRequests: 0 });
const optionsFor = (mock) => ({ origin: mock.origin, apiBase: mock.apiBase, token: "test-token", accountId: "account-1", expectedVersion: EXPECTED, rollbackVersion: ROLLBACK });

test("robots rules honor crawler groups, wildcards, specificity and Allow ties", () => {
  const paths = ["/", "/wetbulb-temperature/united-states/texas/houston/"];
  for (const rules of ["User-agent: *\nDisallow: /", "User-agent: Googlebot\nDisallow: /\nUser-agent: *\nAllow: /", "User-agent: bingbot\nDisallow: /wetbulb-temperature/*$"]) {
    assert.equal(robotsAllowPublicPages(rules, paths), false, rules);
  }
  assert.equal(robotsAllowPublicPages("User-agent: *\nDisallow: /api/\nAllow: /", paths), true);
  assert.equal(robotsAllowPublicPages("User-agent: *\nDisallow: /\nAllow: /", paths), true);
  assert.equal(robotsAllowPublicPages("User-agent: googlebot\nAllow: /\nUser-agent: bingbot\nAllow: /", paths), true);
});

test("deployment guard rejects extra routes even when the exact approved pattern is present", () => {
  const valid = fs.readFileSync(path.join(root, "wrangler.weather-production-route.toml"), "utf8");
  assert.doesNotThrow(() => validateProductionConfig(valid));
  assert.throws(() => validateProductionConfig(valid.replace('zone_name = "wetbulb35.com" }]', 'zone_name = "wetbulb35.com" }, { pattern = "*.wetbulb35.com/*" }]')));
  assert.throws(() => validateProductionConfig(valid + '\nroute = "wetbulb35.com/*"\n'));
  assert.throws(() => validateProductionConfig(valid + '\n[[routes]]\npattern = "other.example/*"\n'));
  assert.throws(() => validateProductionConfig(valid.replace('www.wetbulb35.com/*', '*.wetbulb35.com/*')));
});

test("meta and HTTP noindex directives are rejected across quoting and attribute order", () => {
  for (const html of ['<meta name="robots" content="noindex, follow">', "<META CONTENT='none' NAME='Googlebot'>", '<meta name=bingbot content=noindex>']) {
    assert.equal(indexable(html, new Response()), false, html);
  }
  assert.equal(indexable("", new Response(null, { headers: { "X-Robots-Tag": "googlebot: noindex" } })), false);
  assert.equal(indexable('<meta name="robots" content="index,follow">', new Response()), true);
});

test("route guards reject widened scope, overrides and exclusions without mutating them", async () => {
  const exact = { pattern: "www.wetbulb35.com/*", script: "wetbulb35-weather-production" };
  for (const extra of [
    { pattern: "*.wetbulb35.com/*", script: exact.script },
    { pattern: "www.wetbulb35.com/private/*", script: "another-worker" },
    { pattern: "https://www.wetbulb35.com/api/*", script: null },
    { pattern: "wetbulb35.com/*", script: exact.script },
  ]) assert.equal(selectRouteAction([exact, extra]).action, "refuse");
  assert.equal(selectRouteAction([exact, { pattern: "other.wetbulb35.com/*", script: "another-worker" }]).action, "none");
  const mock = await fixture();
  try {
    mock.state.routes.push({ pattern: "*.wetbulb35.com/*", script: exact.script });
    const result = await runReleaseChecks(optionsFor(mock));
    assert.ok(result.criticalFailures.some((item) => item.startsWith("production_route:")));
    const restored = await restoreProductionRoute({ ...optionsFor(mock), apply: true });
    assert.equal(restored.status, "refused");
    assert.equal(mock.state.routes.length, 2);
  } finally { mock.server.close(); }
});

test("live-shaped health fixture with Disallow or noindex is never healthy", async () => {
  const mock = await fixture();
  try {
    for (const mode of ["robots", "meta", "header"]) {
      const fetchImpl = async (url, options) => {
        const response = await fetch(url, options);
        if (mode === "robots" && new URL(url).pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\nSitemap: https://www.wetbulb35.com/sitemap.xml");
        if (new URL(url).pathname === "/" && mode !== "robots") return new Response((await response.text()) + (mode === "meta" ? '<meta name="robots" content="noindex">' : ""), { headers: mode === "header" ? { "x-robots-tag": "noindex" } : {} });
        return response;
      };
      const result = await runReleaseChecks({ ...optionsFor(mock), fetchImpl });
      assert.equal(result.status, "critical_failure", mode);
    }
  } finally { mock.server.close(); }
});

test("sitemap outage aborts within its deadline with bounded requests", async () => {
  const mock = await fixture();
  try {
    let attempts = 0;
    const fetchImpl = (url, options) => {
      if (!new URL(url).pathname.startsWith("/sitemaps/")) return fetch(url, options);
      attempts++;
      return new Promise((resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    };
    const before = Date.now();
    const result = await runReleaseChecks({ ...optionsFor(mock), fetchImpl, fullSitemaps: true, sitemapTimeoutMs: 25 });
    assert.ok(Date.now() - before < 2_000);
    assert.ok(attempts <= 4, `attempts=${attempts}`);
    assert.equal(result.rollbackEligible, true);
  } finally { mock.server.close(); }
});

test("confirmed critical pages bypass the expensive sitemap crawl", async () => {
  const mock = await fixture();
  try {
    mock.state.failBrowse = true;
    let sitemapCalls = 0;
    const fetchImpl = (url, options) => { if (new URL(url).pathname.startsWith("/sitemaps/")) sitemapCalls++; return fetch(url, options); };
    assert.equal((await runReleaseChecks({ ...optionsFor(mock), fetchImpl, fullSitemaps: true })).rollbackEligible, true);
    assert.equal(sitemapCalls, 0);
  } finally { mock.server.close(); }
});

test("confirmation requires matching failures and never suppresses supersession or missing control", async () => {
  const sequences = [
    [[failure(), failure()], "critical_failure"],
    [[failure(), healthy()], "healthy"],
    [[failure(), failure("home:500")], "unconfirmed_failure"],
    [[{ ...failure(), status: "control_unavailable", rollbackEligible: false }, failure()], "unconfirmed_failure"],
    [[failure(), { ...healthy(), status: "superseded" }], "superseded"],
    [[failure(), { ...healthy(), status: "control_unavailable" }], "control_unavailable"],
  ];
  for (const [sequence, expected] of sequences) {
    let sleeps = 0;
    const result = await confirmedChecks({}, { check: async () => sequence.shift(), sleep: async (ms) => { assert.equal(ms, 20_000); sleeps++; } });
    assert.equal(result.status, expected);
    assert.equal(sleeps, 1);
  }
  const result = await confirmedChecks({ weatherBudget: 2 }, {
    check: async ({ weather }) => weather ? failure("weather_houston:500") : healthy(), sleep: async () => {},
  });
  assert.equal(result.status, "unconfirmed_failure");
  assert.equal(result.weatherRequests, 2);
});

test("rollback version with broken route or page continues recovery checks", async () => {
  const mock = await fixture();
  try {
    mock.state.activeVersion = ROLLBACK;
    mock.state.routes = [];
    mock.state.failBrowse = true;
    const result = await runReleaseChecks(optionsFor(mock));
    assert.equal(result.status, "recovery_failure");
    assert.ok(result.criticalFailures.some((item) => item.startsWith("browse:")));
    assert.ok(result.criticalFailures.some((item) => item.startsWith("production_route:")));
  } finally { mock.server.close(); }
});

test("end-to-end recovery persists failure, resumes on a new runner and rolls back only once", async () => {
  const mock = await fixture();
  try {
    mock.state.failBrowse = true;
    mock.state.routes = [];
    let saved;
    let rollbacks = 0;
    let restoreAttempts = 0;
    const messages = [];
    const options = optionsFor(mock);
    const dependencies = {
      rollback: async (version) => { assert.equal(saved.status, "recovering"); assert.equal(version, ROLLBACK); rollbacks++; mock.state.activeVersion = version; mock.state.failBrowse = false; },
      restore: async (args) => { if (++restoreAttempts === 1) throw new Error("temporary route API failure"); return restoreProductionRoute(args); },
    };
    const runner = {
      save: async (value) => { saved = structuredClone(value); }, notify: async (message) => messages.push(message), now: () => new Date(startedAt), options,
      checks: (args) => confirmedChecks(args, { sleep: async () => {} }),
      recover: (args) => recoverRelease(args, dependencies),
    };
    await advanceMonitor(newState(), runner);
    assert.equal(saved.status, "recovering");
    assert.ok(messages.at(-1).includes("CRITICAL"));
    await advanceMonitor(structuredClone(saved), runner);
    assert.equal(saved.status, "recovered");
    assert.equal(mock.state.routes.length, 1);
    assert.equal(rollbacks, 1);
    assert.ok(messages.at(-1).includes("verified"));
  } finally { mock.server.close(); }
});

test("new deployment between detection and rollback refuses both rollback and route restoration", async () => {
  const mock = await fixture();
  try {
    let mutations = 0;
    mock.state.activeVersion = "33333333-3333-4333-8333-333333333333";
    const result = await recoverRelease(optionsFor(mock), { rollback: async () => mutations++, restore: async () => mutations++ });
    assert.equal(result.status, "superseded");
    assert.equal(mutations, 0);
  } finally { mock.server.close(); }
});

test("weather failure warns the operator but never rolls back", async () => {
  const mock = await fixture();
  try {
    mock.state.failWeather = true;
    const notices = [];
    let rolledBack = false;
    const result = await advanceMonitor(newState(), {
      save: async () => {}, notify: async (message) => notices.push(message), now: () => new Date(startedAt), options: optionsFor(mock),
      checks: (args) => confirmedChecks(args, { sleep: async () => {} }),
      recover: (args) => recoverRelease(args, { rollback: async () => { rolledBack = true; } }),
    });
    assert.equal(result.status, "active");
    assert.equal(rolledBack, false);
    assert.equal(mock.state.activeVersion, EXPECTED);
    assert.ok(notices.some((message) => /^WARNING: weather_/.test(message)));
  } finally { mock.server.close(); }
});

test("weather budget counts retries and remains capped across runner restarts", async () => {
  let state = newState();
  let actualRequests = 0;
  for (let minute = 0; minute < 24 * 60; minute += 10) {
    state = await advanceMonitor(structuredClone(state), {
      save: async () => {}, notify: async () => {}, now: () => new Date(Date.parse(startedAt) + minute * 60_000),
      checks: async ({ weatherBudget }) => {
        const requests = Math.min(weatherBudget, 2);
        actualRequests += requests;
        return { ...healthy(), weatherRequests: requests };
      },
    });
  }
  assert.equal(actualRequests, 58);
  assert.equal(state.weatherRequests, 58);
});

test("expiry never claims success for an unresolved recovery and never mutates production", async () => {
  const state = { ...newState(), status: "recovering" };
  const messages = [];
  let calls = 0;
  await advanceMonitor(state, { save: async () => {}, notify: async (message) => messages.push(message), now: () => new Date("2026-09-16T00:00:00Z"), recover: async () => calls++ });
  assert.equal(state.status, "expired_unhealthy");
  assert.equal(calls, 0);
  assert.ok(messages[0].includes("without verified health"));
});

test("operator stop is rechecked before recovery after detection", async () => {
  let stopped = false;
  let recoveries = 0;
  await advanceMonitor(newState(), {
    save: async () => {}, notify: async () => {}, now: () => new Date(startedAt), authorized: async () => !stopped,
    checks: async () => { stopped = true; return failure(); }, recover: async () => { recoveries++; },
  });
  assert.equal(recoveries, 0);
});

function memoryStore(initial = null) {
  let issue = initial ? { number: 7, state: "open", body: JSON.stringify(initial) } : null;
  const messages = [];
  return { messages,
    active: async () => issue?.state === "open" ? structuredClone(issue) : null,
    create: async (state) => { issue = { number: 7, state: "open", body: JSON.stringify(state) }; return 7; },
    read: async () => structuredClone(issue),
    save: async (number, state) => { issue.body = JSON.stringify(state); },
    close: async () => { issue.state = "closed"; },
    notify: async (number, message) => messages.push(message),
  };
}

test("hosted runner start, first-hour checkpoint, scheduled resumption and stop share durable state", async () => {
  const store = memoryStore();
  let time = Date.parse(startedAt);
  let cycles = 0;
  const clock = () => new Date(time);
  const step = (state, args) => advanceMonitor(state, { ...args, checks: async () => { cycles++; return healthy(); } });
  const result = await monitorJob({ action: "start", store, versions: newState(), control: async () => ({ activeVersion: EXPECTED }), now: clock, sleep: async (ms) => { time += ms; }, step });
  assert.equal(result.firstHourComplete, "2026-09-15T01:00:00.000Z");
  assert.equal(cycles, 31);
  time += 30 * 60_000;
  await monitorJob({ action: "check", store, now: clock, step });
  assert.equal(cycles, 32);
  await monitorJob({ action: "stop", store, now: clock, step });
  assert.equal((await store.read()).state, "closed");
  assert.equal((await monitorJob({ action: "check", store, now: clock, step })).status, "inactive");
});

test("stop CLI always identifies its repository and works outside a checkout", async () => {
  const calls = [];
  const store = issueStore("owner/repo", async (bin, args) => {
    calls.push(args);
    return { stdout: args[0] === "issue" ? '[{"number":7,"body":"{}"}]' : '{}' };
  });
  assert.equal((await monitorJob({ action: "stop", store })).status, "stopped");
  assert.deepEqual(calls[0].slice(0, 4), ["issue", "list", "--repo", "owner/repo"]);
  assert.ok(calls.some((args) => args.includes("repos/owner/repo/issues/7") && args.includes("state=closed")));
});

test("shell rollback entry point resumes after failed route restoration using simulated Cloudflare and Wrangler", async () => {
  const mock = await fixture();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "release-shell-rehearsal-"));
  try {
    // Intercept every fetch in child Node processes. This rehearsal cannot
    // contact Cloudflare or the public site, even if a test path changes.
    const hook = path.join(temp, "mock-fetch.mjs");
    fs.writeFileSync(hook, `const original = globalThis.fetch; globalThis.fetch = (input, options) => { const url = new URL(input); return original(new URL(url.pathname + url.search, ${JSON.stringify(mock.origin)}), options); };`);
    const npx = path.join(temp, "npx");
    fs.writeFileSync(npx, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== ${JSON.stringify(`--yes wrangler@4.129.1 rollback ${ROLLBACK} --name wetbulb35-weather-production --message Confirmed production release failure --yes`)}) process.exit(9);\nfetch(${JSON.stringify(mock.origin + "/test/rollback")}, {method:'POST'}).then(r => {if (!r.ok) process.exit(8);});\n`);
    fs.chmodSync(npx, 0o755);
    const env = { ...process.env, PATH: `${temp}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
      NODE_OPTIONS: `--import=${hook}`, CLOUDFLARE_API_TOKEN: "test-only", CLOUDFLARE_ACCOUNT_ID: "account-1" };
    const run = async () => {
      try { return { ...(await promisify(execFile)("bash", ["scripts/execute-production-rollback.sh", EXPECTED, ROLLBACK], { cwd: root, env })), code: 0 }; }
      catch (error) { return error; }
    };
    mock.state.routes = [];
    mock.state.failRoutePost = true;
    const first = await run();
    assert.equal(first.code, 5);
    assert.equal(JSON.parse(first.stdout).status, "recovery_failure");
    assert.equal(mock.state.activeVersion, ROLLBACK);
    mock.state.failRoutePost = false;
    const second = await run();
    assert.equal(second.code, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).status, "recovered");
    assert.equal(mock.state.rollbackCalls, 1);
    assert.equal(mock.state.routes.length, 1);
  } finally {
    mock.server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
