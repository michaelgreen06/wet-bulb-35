import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import worker, {
  ADMIN_HEADERS,
  adminConfig,
  collectBudgets,
  handleAdminRequest,
  verifyAccessJwt,
} from "../workers/admin-dashboard.mjs";
import {
  classifyTop50Snapshot,
  evaluatePanel,
  nextUtcMidnight,
  panelKey,
  projectPanel,
} from "../lib/admin/status-contract.mjs";
import { WeatherGate, createObservability } from "../workers/weather-edge.mjs";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const FIXTURES = JSON.parse(fs.readFileSync(new URL("./fixtures/admin-status/panels.fresh.json", import.meta.url), "utf8"));
const TEAM = "wetbulb35-test.cloudflareaccess.com";
const AUD = "a".repeat(64);
const ALLOWED = "approved@example.test";
const HOST = "admin.example.test";
const PROVIDER_HOSTS = /googleapis|google\.com|openweathermap|open-meteo|ecmwf/i;

const clone = (value) => JSON.parse(JSON.stringify(value));
const b64url = (value) => Buffer.from(value).toString("base64url");

const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const otherPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "kid-1" };

async function jwt(claims = {}, { kid = "kid-1", key = keyPair.privateKey, alg = "RS256" } = {}) {
  const header = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: `https://${TEAM}`, aud: [AUD], email: ALLOWED, exp: NOW / 1000 + 600, nbf: NOW / 1000 - 10, ...claims,
  }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

function fetchSpy() {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [publicJwk] });
    throw new Error(`unexpected outbound fetch ${url}`);
  };
  return { calls, impl };
}

function kv(initial = {}) {
  const values = new Map(Object.entries(initial).map(([id, doc]) => [panelKey(id), JSON.stringify(doc)]));
  const reads = [];
  const writes = [];
  return {
    values, reads, writes,
    async get(key, type) { reads.push(key); const raw = values.get(key); return raw === undefined ? null : type === "json" ? JSON.parse(raw) : raw; },
    async put(key, value) { writes.push(key); values.set(key, value); },
  };
}

function env(overrides = {}) {
  const { _comment, ...panels } = FIXTURES;
  return {
    ADMIN_HOSTNAME: HOST, ADMIN_ACCESS_TEAM_DOMAIN: TEAM, ADMIN_ACCESS_AUD: AUD, ADMIN_ALLOWED_EMAILS: `${ALLOWED}, second@example.test`,
    ADMIN_STATUS: kv(panels),
    WEATHER_GATE: { idFromName() { throw new Error("page views must not touch WeatherGate"); }, get() { throw new Error("page views must not touch WeatherGate"); } },
    ...overrides,
  };
}

async function get(path, { token, host = HOST, scheme = "https", method = "GET", environment = env(), spy = fetchSpy() } = {}) {
  const headers = token ? { "cf-access-jwt-assertion": token } : {};
  const response = await handleAdminRequest(new Request(`${scheme}://${host}${path}`, { method, headers }), environment, { now: NOW, fetchImpl: spy.impl });
  return { response, body: await response.text(), spy };
}

function assertPrivateHeaders(response) {
  for (const [name, value] of Object.entries(ADMIN_HEADERS)) assert.equal(response.headers.get(name), value, name);
}

test("configuration fails closed unless hostname, Access team, audience and approved allowlist are all set", () => {
  assert.ok(adminConfig(env()));
  for (const missing of ["ADMIN_HOSTNAME", "ADMIN_ACCESS_TEAM_DOMAIN", "ADMIN_ACCESS_AUD", "ADMIN_ALLOWED_EMAILS"]) {
    assert.equal(adminConfig(env({ [missing]: "" })), null, missing);
  }
  assert.equal(adminConfig(env({ ADMIN_ACCESS_TEAM_DOMAIN: "evil.example.com" })), null);
  assert.equal(adminConfig(env({ ADMIN_ALLOWED_EMAILS: "not-an-email" })), null);
});

test("unconfigured Worker returns 503 with no dashboard data", async () => {
  const { response, body } = await get("/", { token: await jwt(), environment: env({ ADMIN_ALLOWED_EMAILS: "" }) });
  assert.equal(response.status, 503);
  assertPrivateHeaders(response);
  assert.doesNotMatch(body, /fixture|Top-50|clicks/i);
});

test("unauthenticated and invalid Access tokens are denied for HTML, JSON, assets and robots", async () => {
  const bad = [
    undefined,
    "not.a.jwt",
    await jwt({ aud: ["b".repeat(64)] }),
    await jwt({ iss: "https://other.cloudflareaccess.com" }),
    await jwt({ exp: NOW / 1000 - 120 }),
    await jwt({ nbf: NOW / 1000 + 600 }),
    await jwt({ email: "someone-else@example.test" }),
    await jwt({}, { key: otherPair.privateKey }),
    await jwt({}, { kid: "unknown-kid" }),
    await jwt({}, { alg: "HS256" }),
  ];
  for (const token of bad) {
    for (const path of ["/", "/api/status", "/robots.txt", "/assets/app.css", "/favicon.ico"]) {
      const { response, body, spy } = await get(path, { token });
      assert.equal(response.status, 403, `${path} ${String(token).slice(0, 20)}`);
      assertPrivateHeaders(response);
      assert.doesNotMatch(body, /fixture|Top-50|clicks|sessions/i);
      assert.ok(spy.calls.every((url) => url === `https://${TEAM}/cdn-cgi/access/certs`));
    }
  }
});

test("alternate hostnames and plain HTTP never serve data, even with a valid token", async () => {
  const token = await jwt();
  for (const host of ["wetbulb35-admin-dashboard.example.workers.dev", "preview.admin.example.test", "www.example.test"]) {
    const { response, body } = await get("/api/status", { token, host });
    assert.equal(response.status, 404);
    assertPrivateHeaders(response);
    assert.doesNotMatch(body, /fixture|sessions/i);
  }
  const { response, body } = await get("/api/status?x=1", { token, scheme: "http" });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), `https://${HOST}/api/status?x=1`);
  assert.equal(body, "");
});

test("authorized viewer gets noindex, no-store HTML with every card's source, window, timestamp and fixture banner", async () => {
  const { response, body, spy } = await get("/", { token: await jwt() });
  assert.equal(response.status, 200);
  assertPrivateHeaders(response);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(body, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(body, /FIXTURE DATA/);
  for (const title of ["Site health", "Top-50 forecast health", "Weather call budgets", "Search health", "GA4 health"]) assert.match(body, new RegExp(title));
  assert.equal((body.match(/<dt>Source<\/dt>/g) || []).length, 5);
  assert.equal((body.match(/<dt>Window<\/dt>/g) || []).length, 5);
  assert.equal((body.match(/<dt>Last updated<\/dt>/g) || []).length, 5);
  assert.match(body, /internal safeguards, not vendor-reported quota/);
  assert.match(body, /not a vendor reset time/);
  assert.match(body, /not a sitewide indexed-page count/);
  assert.match(body, /2026-10-01 \(Search Console metadata\)\. Days without rows count as zero\./);
  assert.match(body, /<dt>Latest day with any search data<\/dt><dd>2026-10-01<\/dd>/);
  assert.match(body, /not global uptime/);
  assert.match(body, /\(partial\)/);
  assert.doesNotMatch(body, /<script|googletagmanager|gtag\(/i);
  assert.ok(spy.calls.every((url) => url === `https://${TEAM}/cdn-cgi/access/certs`));
});

test("JSON status exposes only allowlisted projected fields", async () => {
  const tainted = clone(FIXTURES);
  tainted.search.data.rawQueries = ["secret query"];
  tainted.search.data.sample.results[0].rawPayload = { inspectionResult: {} };
  tainted.ga4.data.credentials = "service-account";
  tainted.budgets.data.currentConditions.lastError.body = "provider said: invalid key abc";
  tainted.site.data.checks[0].path = "https://evil.example/?token=1";
  const { _comment, ...panels } = tainted;
  const { response, body } = await get("/api/status", { token: await jwt(), environment: env({ ADMIN_STATUS: kv(panels) }) });
  assert.equal(response.status, 200);
  assert.doesNotMatch(body, /secret query|rawPayload|service-account|invalid key|evil\.example/);
  const summary = JSON.parse(body);
  assert.equal(summary.panels.site.doc.data.checks[0].path, null);
  assert.equal(summary.panels.budgets.doc.data.currentConditions.lastError.upstreamStatus, 429);
});

test("fresh, stale, failed and missing panels are labeled distinctly", () => {
  const fresh = projectPanel("site", FIXTURES.site);
  assert.equal(evaluatePanel("site", fresh, NOW).state, "ok");

  const old = projectPanel("site", { ...FIXTURES.site, collectedAt: "2026-10-04T10:00:00Z" });
  assert.deepEqual([evaluatePanel("site", old, NOW).state, evaluatePanel("site", old, NOW).stale], ["stale", true]);

  const failed = projectPanel("search", { ...FIXTURES.search, lastAttempt: { at: "2026-10-04T11:00:00Z", outcome: "failed", reason: "permission_denied" } });
  const failedEvaluation = evaluatePanel("search", failed, NOW);
  assert.equal(failedEvaluation.state, "stale");
  assert.equal(failedEvaluation.failedSince, true);

  const neverCollected = projectPanel("search", { schemaVersion: 1, panel: "search", status: "unknown", reason: "credential_not_configured", collectedAt: null, lastAttempt: { at: "2026-10-04T11:00:00Z", outcome: "failed", reason: "credential_not_configured" }, data: {} });
  assert.equal(evaluatePanel("search", neverCollected, NOW).state, "unknown");
  const unavailable = projectPanel("ga4", { ...neverCollected, panel: "ga4", status: "unavailable", reason: "upstream_unavailable" });
  assert.equal(evaluatePanel("ga4", unavailable, NOW).state, "unavailable");
  assert.equal(evaluatePanel("ga4", null, NOW).state, "not_collected");
  assert.equal(projectPanel("ga4", { ...FIXTURES.ga4, schemaVersion: 2 }), null);
  assert.equal(projectPanel("ga4", { ...FIXTURES.ga4, panel: "site" }), null);
});

test("stale and failed panels keep last values but render as not live; zero stays distinct from unknown", async () => {
  const panels = clone(FIXTURES);
  delete panels._comment;
  panels.search.lastAttempt = { at: "2026-10-04T11:00:00Z", outcome: "failed", reason: "permission_denied" };
  panels.ga4 = { schemaVersion: 1, panel: "ga4", status: "unknown", reason: "credential_not_configured", collectedAt: null, lastAttempt: { at: "2026-10-04T11:00:00Z", outcome: "failed", reason: "credential_not_configured" }, data: {} };
  delete panels.budgets;
  const { body } = await get("/", { token: await jwt(), environment: env({ ADMIN_STATUS: kv(panels) }) });
  assert.match(body, /Search health <span class="badge stale">Stale<\/span>/);
  assert.match(body, /showing the last successful result; it is not live/);
  assert.match(body, /failed \(permission_denied\)/);
  assert.match(body, /GA4 health <span class="badge unknown">Unknown<\/span>/);
  assert.match(body, /values are unknown, not zero/);
  assert.match(body, /Weather call budgets <span class="badge not_collected">Not collected<\/span>/);
  assert.match(body, /n\/a \(prior 0\)/);
});

test("Top-50 snapshots are classified at view time and an expired ranking is never current", async () => {
  const inhabited = FIXTURES.top50.data.products.inhabited;
  assert.equal(classifyTop50Snapshot(inhabited, NOW).state, "in_window");
  assert.equal(classifyTop50Snapshot(FIXTURES.top50.data.products.unfiltered, NOW).state, "upcoming");
  assert.deepEqual(classifyTop50Snapshot(inhabited, Date.parse(inhabited.validTo)), { state: "expired", current: false });
  assert.equal(classifyTop50Snapshot(inhabited, Date.parse("2026-10-05T19:00:00Z"), { maxInitializationAgeHours: 36 }).state, "expired");
  assert.equal(classifyTop50Snapshot({ ...inhabited, validTo: "2026-10-07T00:00:00Z" }, Date.parse("2026-10-05T19:00:01Z"), { maxInitializationAgeHours: 36 }).state, "behind");
  assert.equal(classifyTop50Snapshot({ ...inhabited, validFrom: inhabited.validTo }, NOW).state, "invalid");
  assert.equal(classifyTop50Snapshot({ availability: "not_published" }, NOW).state, "not_published");

  // A fresh collector cannot keep an expired snapshot current: expiry is evaluated at render time.
  const panels = clone(FIXTURES);
  delete panels._comment;
  panels.top50.collectedAt = "2026-10-05T11:30:00Z";
  panels.top50.lastAttempt.at = "2026-10-05T11:30:00Z";
  const later = Date.parse("2026-10-05T11:45:00Z");
  const response = await handleAdminRequest(new Request(`https://${HOST}/api/status`, { headers: { "cf-access-jwt-assertion": await jwt({ exp: later / 1000 + 600 }) } }),
    env({ ADMIN_STATUS: kv(panels) }), { now: later, fetchImpl: fetchSpy().impl });
  const summary = await response.json();
  assert.equal(summary.panels.top50.evaluation.products.inhabited.state, "expired");
  assert.equal(summary.panels.top50.evaluation.state, "down");

  // A failed latest cycle reported by the collector is not hidden by a still-valid snapshot.
  const degraded = clone(FIXTURES);
  delete degraded._comment;
  degraded.top50.status = "degraded";
  const degradedSummary = await (await handleAdminRequest(new Request(`https://${HOST}/api/status`, { headers: { "cf-access-jwt-assertion": await jwt() } }),
    env({ ADMIN_STATUS: kv(degraded) }), { now: NOW, fetchImpl: fetchSpy().impl })).json();
  assert.equal(degradedSummary.panels.top50.evaluation.state, "degraded");

  // Missing or inconsistent run metadata is never inferred as current (Hermes review of #59).
  assert.deepEqual(classifyTop50Snapshot({ ...inhabited, initialization: null }, NOW), { state: "run_unknown", current: false });
  assert.deepEqual(classifyTop50Snapshot({ ...inhabited, initialization: "2026-10-04T11:30:00Z" }, NOW), { state: "invalid", current: false });
  assert.deepEqual(classifyTop50Snapshot({ ...inhabited, validFrom: "2026-10-04T13:00:00Z", initialization: "2026-10-04T12:30:00Z" }, NOW), { state: "invalid", current: false });
  assert.equal(classifyTop50Snapshot({ ...inhabited, initialization: null }, Date.parse(inhabited.validTo)).state, "expired");
  const missingRun = clone(FIXTURES);
  delete missingRun._comment;
  missingRun.top50.data.products.unfiltered.initialization = null;
  const missingEnv = env({ ADMIN_STATUS: kv(missingRun) });
  const missingSummary = await (await handleAdminRequest(new Request(`https://${HOST}/api/status`, { headers: { "cf-access-jwt-assertion": await jwt() } }),
    missingEnv, { now: NOW, fetchImpl: fetchSpy().impl })).json();
  assert.deepEqual(missingSummary.panels.top50.evaluation.products.unfiltered, { state: "run_unknown", current: false });
  assert.equal(missingSummary.panels.top50.evaluation.state, "degraded");
  const missingHtml = await (await handleAdminRequest(new Request(`https://${HOST}/`, { headers: { "cf-access-jwt-assertion": await jwt() } }),
    missingEnv, { now: NOW, fetchImpl: fetchSpy().impl })).text();
  assert.match(missingHtml, /Run metadata missing — not shown as current · IFS init unknown/);

  // The overdue-cycle threshold is adaptable for #50's 6-hourly cadence.
  const sixHourly = { maxInitializationAgeHours: 15 };
  assert.equal(classifyTop50Snapshot(inhabited, Date.parse("2026-10-04T21:00:01Z"), sixHourly).state, "behind");
});

test("budget collector reads only WeatherGate /budget and preserves the prior result on failure", async () => {
  const store = kv();
  const requests = [];
  const gate = (handler) => ({ idFromName: (name) => name, get: () => ({ fetch: async (url, init) => { requests.push([url, init.method]); return handler(); } }) });
  await collectBudgets({ ADMIN_STATUS: store, WEATHER_GATE: gate(() => Response.json({
    v: 1, day: "2026-10-04", resetAt: "2026-10-05T00:00:00.000Z",
    weather: { used: 1800, limit: 2000, lastError: null }, forecast: { used: 0, limit: 2000, lastError: { at: "2026-10-04T01:00:00.000Z", outcome: "timeout", upstreamStatus: null } },
  })) }, { now: NOW });
  assert.deepEqual(requests, [["https://weather-gate/budget", "POST"]]);
  const first = JSON.parse(store.values.get(panelKey("budgets")));
  assert.equal(first.status, "degraded");
  assert.equal(first.data.fiveDay.lastError.outcome, "timeout");

  await collectBudgets({ ADMIN_STATUS: store, WEATHER_GATE: gate(() => new Response("provider body must not leak", { status: 500 })) }, { now: NOW + 600_000 });
  const second = JSON.parse(store.values.get(panelKey("budgets")));
  assert.equal(second.collectedAt, first.collectedAt);
  assert.equal(second.data.currentConditions.used, 1800);
  assert.deepEqual(second.lastAttempt, { at: new Date(NOW + 600_000).toISOString(), outcome: "failed", reason: "upstream_unavailable" });
  assert.doesNotMatch(store.values.get(panelKey("budgets")), /provider body/);
  assert.equal(evaluatePanel("budgets", projectPanel("budgets", second), NOW + 600_000).state, "stale");

  assert.deepEqual(await collectBudgets({}, { now: NOW }), { written: false, reason: "not_configured" });
});

test("WeatherGate /budget is read-only, provider-free and records only sanitized provider errors", async () => {
  const values = new Map();
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async transaction(callback) { return callback(storage); },
  };
  const day = new Date().toISOString().slice(0, 10);
  values.set(`attempts:${day}`, 7);
  values.set(`forecast-attempts:${day}`, 3);
  const gateEnv = { OPENWEATHER_API_KEY: "test-secret", WEATHER_DAILY_ATTEMPT_LIMIT: "50", FORECAST_DAILY_ATTEMPT_LIMIT: "60", OBSERVABILITY: createObservability({ logger: () => {} }) };
  const gate = new WeatherGate({ storage }, gateEnv);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("budget path must not call a provider"); };
  try {
    const before = new Map(values);
    const response = await gate.fetch(new Request("https://weather-gate/budget", { method: "POST", body: "{}" }));
    const summary = await response.json();
    assert.deepEqual(new Map(values), before);
    assert.equal(summary.day, day);
    assert.equal(summary.resetAt, nextUtcMidnight(Date.now()));
    assert.deepEqual(summary.weather, { used: 7, limit: 50, lastError: null });
    assert.deepEqual(summary.forecast, { used: 3, limit: 60, lastError: null });
    assert.equal((await gate.fetch(new Request("https://weather-gate/budget", { method: "GET" }))).status, 404);

    globalThis.fetch = async () => new Response("upstream secret body", { status: 401, statusText: "invalid appid abc" });
    await gate.fetch(new Request("https://weather-gate/refresh", { method: "POST", body: JSON.stringify({ key: "weather:v1:lat:1:lon:2", lat: 1, lon: 2, state: "miss" }) }));
    const recorded = values.get("provider-error:weather");
    assert.deepEqual(Object.keys(recorded).sort(), ["at", "outcome", "upstreamStatus"]);
    assert.equal(recorded.outcome, "upstream_http");
    assert.equal(recorded.upstreamStatus, 401);
    assert.doesNotMatch(JSON.stringify(recorded), /secret|appid/);
    const after = await (await gate.fetch(new Request("https://weather-gate/budget", { method: "POST", body: "{}" }))).json();
    assert.equal(after.weather.used, 8);
    assert.equal(after.weather.lastError.outcome, "upstream_http");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("page views make no provider, Google or WeatherGate calls; default export wires fetch and scheduled", async () => {
  const outbound = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    outbound.push(String(url));
    if (String(url).startsWith(`https://${TEAM}/`)) return Response.json({ keys: [publicJwk] });
    throw new Error("unexpected");
  };
  try {
    const environment = env();
    for (const path of ["/", "/api/status", "/robots.txt"]) {
      const token = await jwt({ exp: Math.floor(Date.now() / 1000) + 600, nbf: Math.floor(Date.now() / 1000) - 10 });
      const response = await worker.fetch(new Request(`https://${HOST}${path}`, { headers: { "cf-access-jwt-assertion": token } }), environment);
      assert.equal(response.status, 200, path);
    }
    assert.equal(environment.ADMIN_STATUS.writes.length, 0);
    assert.ok(outbound.every((url) => !PROVIDER_HOSTS.test(url)));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(typeof worker.scheduled, "function");
});

test("admin Worker config is not routable and no public surface links to the admin host", () => {
  const toml = fs.readFileSync(new URL("../wrangler.admin-dashboard.toml", import.meta.url), "utf8");
  const active = toml.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.match(active, /^workers_dev = false$/m);
  assert.match(active, /^preview_urls = false$/m);
  assert.doesNotMatch(active, /^\s*routes\s*=|^\s*route\s*=|custom_domain|\[\[routes\]\]/m);
  assert.doesNotMatch(active, /\[\[kv_namespaces\]\]/);
  assert.doesNotMatch(active, /ADMIN_ALLOWED_EMAILS/, "allowlist is a secret, never a committed var");
  assert.doesNotMatch(toml, /[^\s@`]+@[^\s@`]+\.[a-z]{2,}/i, "no email addresses in Git");
  assert.match(active, /^ADMIN_ACCESS_AUD = ""$/m);

  for (const file of fs.readdirSync(new URL("..", import.meta.url)).filter((name) => /^wrangler\..*\.toml$/.test(name) && name !== "wrangler.admin-dashboard.toml")) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), /admin-dashboard|admin\.wetbulb35/, file);
  }
  for (const file of ["../workers/hono-page-renderer.mjs", "../lib/page-renderer.mjs", "../workers/weather-edge.mjs", "../public/sitemap.xml", "../public/robots.txt"]) {
    const url = new URL(file, import.meta.url);
    if (fs.existsSync(url)) assert.doesNotMatch(fs.readFileSync(url, "utf8"), /admin\.wetbulb35|admin-dashboard|lib\/admin\//, file);
  }
  const sitemapDir = new URL("../public/sitemaps/", import.meta.url);
  if (fs.existsSync(sitemapDir)) {
    for (const name of fs.readdirSync(sitemapDir)) assert.doesNotMatch(fs.readFileSync(new URL(name, sitemapDir), "utf8"), /admin\.wetbulb35/, name);
  }
});

test("Access JWKS fetch is bounded to the configured team domain", async () => {
  const config = adminConfig(env());
  const spy = fetchSpy();
  assert.equal(await verifyAccessJwt(await jwt(), config, { now: NOW, fetchImpl: spy.impl }), ALLOWED);
  assert.ok(spy.calls.length <= 1);
  assert.equal(await verifyAccessJwt(await jwt(), config, { now: NOW, fetchImpl: async () => { throw new Error("down"); } }), ALLOWED, "cached keys survive a certs outage");
});
