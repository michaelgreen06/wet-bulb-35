import assert from "node:assert/strict";
import test from "node:test";
import { weatherKey, weatherResponse } from "../workers/weather-edge.mjs";

const URL = "https://www.wetbulb35.com/api/weather?lat=1&lon=2";
const payload = { location: { name: "Test", lat: 1, lng: 2 }, weather: { temperature: 26, humidity: 50, wetBulb: 19, timestamp: 100_000 } };
const validEnvelope = (freshUntil, staleUntil) => ({ v: 1, key: weatherKey({ lat: 1, lon: 2 }), payload,
  fetchedAt: Date.now() - 100_000, storedAt: Date.now() - 100_000, freshUntil, staleUntil });
function cacheFor(value) { return { default: { async match() { return value ? Response.json(value) : null; }, async put() {} } }; }
function env(gate, extra = {}) { return { WEATHER_TURNSTILE_MODE: "enforce", WEATHER_TURNSTILE_SITE_KEY: "test-public-site-key",
  WEATHER_TURNSTILE_SECRET_KEY: "test-secret", WEATHER_TURNSTILE_HOSTNAME: "www.wetbulb35.com",
  WEATHER_GATE: { idFromName() { return "WeatherGate"; }, get() { return { fetch: gate }; } }, OBSERVABILITY_DISABLED: "true", ...extra }; }
async function isolated(cacheValue, verifier, fn) {
  const oldCaches = globalThis.caches;
  const oldFetch = globalThis.fetch;
  const requests = [];
  globalThis.caches = cacheFor(cacheValue);
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return verifier(url, options); };
  try { return await fn(requests); } finally { globalThis.caches = oldCaches; globalThis.fetch = oldFetch; }
}
const request = (token) => new Request(URL, { headers: token === undefined ? {} : { "x-weather-turnstile": token } });

test("a cold cache requires verification without spending provider budget or calling Siteverify", async () => {
  let gateCalls = 0;
  await isolated(null, () => { throw Error("must not verify"); }, async (requests) => {
    const response = await weatherResponse(request(), env(() => { gateCalls++; throw Error("must not refresh"); }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { code: "verification_required", sitekey: "test-public-site-key" });
    assert.equal(gateCalls, 0);
    assert.equal(requests.length, 0);
  });
});

test("fresh and stale cache stay public; stale reads do not trigger unverified background refresh", async () => {
  let gateCalls = 0;
  const gate = () => { gateCalls++; throw Error("must not refresh"); };
  await isolated(validEnvelope(Date.now() + 60_000, Date.now() + 120_000), () => { throw Error("must not verify"); }, async () => {
    assert.equal((await weatherResponse(request(), env(gate))).status, 200);
  });
  await isolated(validEnvelope(Date.now() - 10_000, Date.now() + 120_000), () => { throw Error("must not verify"); }, async () => {
    assert.equal((await weatherResponse(request(), env(gate), { waitUntil() {} })).status, 200);
  });
  assert.equal(gateCalls, 0);
});

test("valid single-use token, site hostname and action are required before refresh", async () => {
  let gateCalls = 0;
  let verified = { success: true, hostname: "www.wetbulb35.com", action: "weather_refresh" };
  const gate = async () => { gateCalls++; return Response.json(validEnvelope(Date.now() + 60_000, Date.now() + 120_000)); };
  await isolated(null, (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.secret, "test-secret");
    assert.equal(body.response, "token-once");
    assert.equal(body.remoteip, undefined);
    return Response.json(verified);
  }, async (requests) => {
    for (verified of [
      { success: false },
      { success: true, hostname: "evil.example", action: "weather_refresh" },
      { success: true, hostname: "www.wetbulb35.com", action: "other" },
    ]) {
      const response = await weatherResponse(request("token-once"), env(gate));
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { code: "verification_failed" });
    }
    verified = { success: true, hostname: "www.wetbulb35.com", action: "weather_refresh" };
    assert.equal((await weatherResponse(request("token-once"), env(gate))).status, 200);
    assert.equal(requests.length, 4);
    assert.equal(gateCalls, 1);
  });
});

test("bad tokens, Siteverify outages, and incomplete enforcement config fail closed", async () => {
  let gateCalls = 0;
  const gate = () => { gateCalls++; throw Error("must not refresh"); };
  await isolated(null, () => { throw Error("siteverify unavailable"); }, async (requests) => {
    assert.equal((await weatherResponse(request("x".repeat(2049)), env(gate))).status, 403);
    assert.equal(requests.length, 0);
    assert.equal((await weatherResponse(request("valid-sized-token"), env(gate))).status, 403);
    assert.equal((await weatherResponse(request(), env(gate, { WEATHER_TURNSTILE_SECRET_KEY: "" }))).status, 503);
    assert.equal((await weatherResponse(request(), env(gate, { WEATHER_TURNSTILE_MODE: "typo" }))).status, 503);
    assert.equal(gateCalls, 0);
  });
});

test("known bots are skipped before verification and the disabled mode retains original behavior", async () => {
  let gateCalls = 0;
  const gate = async () => { gateCalls++; return Response.json(validEnvelope(Date.now() + 60_000, Date.now() + 120_000)); };
  await isolated(null, () => { throw Error("must not verify"); }, async () => {
    assert.equal((await weatherResponse(new Request(URL, { headers: { "user-agent": "Googlebot" } }), env(gate))).status, 204);
    assert.equal((await weatherResponse(request(), env(gate, { WEATHER_TURNSTILE_MODE: "off" }))).status, 200);
    assert.equal(gateCalls, 1);
  });
});

test("Siteverify HTTP errors fail closed and observability never logs token, coordinates, or error body", async () => {
  let gateCalls = 0;
  const events = [];
  const { createObservability } = await import("../workers/weather-edge.mjs");
  const observer = createObservability({ logger: (event) => events.push(event), hashCanonicalKey: async () => null });
  await isolated(null, () => new Response("private provider details", { status: 503 }), async () => {
    const response = await weatherResponse(request("sensitive-one-time-token"), env(() => { gateCalls++; }, { OBSERVABILITY: observer }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: "verification_failed" });
  });
  assert.equal(gateCalls, 0);
  assert.deepEqual(events.filter((event) => event.event === "weather_turnstile_failure"), [
    { event: "weather_turnstile_failure", deployment_version: "unknown", cache_state: "miss" },
  ]);
  assert.equal(JSON.stringify(events).includes("sensitive-one-time-token"), false);
  assert.equal(JSON.stringify(events).includes("private provider details"), false);
  assert.equal(JSON.stringify(events).includes("lat:1"), false);
});
