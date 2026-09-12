import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_CACHE_CONTROL,
  WeatherGate,
  canonicalNumber,
  parseWeatherCoordinates,
  transformOpenWeather,
  weatherKey,
  weatherResponse,
} from "../workers/weather-edge.mjs";

const NOW = 1_700_000_000_000;
const upstreamPayload = {
  name: "Test",
  coord: { lat: 1, lon: 2 },
  main: { temp: 300, humidity: 50 },
  dt: 100,
};
const transformedPayload = {
  location: { name: "Test", lat: 1, lng: 2 },
  weather: { temperature: 26.85, humidity: 50, wetBulb: 19.59, timestamp: 100_000 },
};

class FakeCache {
  constructor() { this.values = new Map(); this.puts = []; }
  async match(key) { return this.values.get(String(key))?.clone(); }
  async put(key, response) {
    this.puts.push({ key: String(key), response: response.clone() });
    this.values.set(String(key), response.clone());
  }
}

function storageWith(initial = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async transaction(callback) { return callback(storage); },
  };
  return { storage, values };
}

function fakeGate(handler) {
  return {
    idFromName(name) { assert.equal(name, "WeatherGate"); return name; },
    get() { return { fetch: handler }; },
  };
}

function edgeEnv(handler) { return { WEATHER_GATE: fakeGate(handler) }; }
function request(path, options) { return new Request(`https://test${path}`, options); }
function gateRequest(body, path = "/refresh") {
  return request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function envelope({ key = weatherKey({ lat: 1, lon: 2 }), payload = transformedPayload, storedAt = NOW - 400_000, freshUntil = NOW - 100_000, staleUntil = NOW + 200_000 } = {}) {
  return { v: 1, key, payload, fetchedAt: storedAt, storedAt, freshUntil, staleUntil };
}
function gateEnv(overrides = {}) {
  return {
    OPENWEATHER_API_KEY: "test-secret",
    WEATHER_DAILY_ATTEMPT_LIMIT: "5",
    WEATHER_FRESH_SECONDS: "300",
    WEATHER_STALE_SECONDS: "600",
    WEATHER_TIMEOUT_MS: "5000",
    ...overrides,
  };
}
async function withGlobals(values, callback) {
  const originals = new Map();
  for (const [key, value] of Object.entries(values)) {
    originals.set(key, globalThis[key]);
    globalThis[key] = value;
  }
  try { return await callback(); }
  finally {
    for (const [key, value] of originals) globalThis[key] = value;
  }
}

test("weather contract preserves exact route, methods, bot skip, strict coordinates, and Number keys", async () => {
  const cache = new FakeCache();
  let gateCalls = 0;
  const env = edgeEnv(async () => { gateCalls += 1; return Response.json(envelope()); });
  await withGlobals({ caches: { default: cache } }, async () => {
    for (const method of ["HEAD", "OPTIONS", "POST", "PUT"]) {
      const response = await weatherResponse(request("/api/weather?lat=1&lon=2", { method }), env);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET");
    }
    for (const path of [
      "/api/weather?lon=2",
      "/api/weather?lat=&lon=2",
      "/api/weather?lat=%20&lon=2",
      "/api/weather?lat=NaN&lon=2",
      "/api/weather?lat=Infinity&lon=2",
      "/api/weather?lat=91&lon=2",
      "/api/weather?lat=1&lon=-181",
    ]) assert.equal((await weatherResponse(request(path), env)).status, 400, path);
    assert.equal((await weatherResponse(request("/api/weather", { headers: { "user-agent": "Googlebot" } }), env)).status, 204);
  });
  const app = (await import("../workers/hono-page-renderer.mjs")).createHonoPageRenderer();
  assert.equal((await app.fetch(request("/api/weather/"), env)).status, 404);
  assert.equal(gateCalls, 0);
  assert.equal(canonicalNumber(-0), "0");
  assert.equal(weatherKey({ lat: -0, lon: 2 }), weatherKey({ lat: 0, lon: 2 }));
  assert.deepEqual(parseWeatherCoordinates(new URL("https://x/?lat=1e0&lon=-0").searchParams), { lat: 1, lon: -0 });
});

test("Cache API stores only a validated versioned envelope with cacheable TTL; browser remains no-store", async () => {
  const cache = new FakeCache();
  const key = weatherKey({ lat: 1, lon: 2 });
  const malformed = { payload: transformedPayload, storedAt: NOW, freshUntil: NOW + 300_000, staleUntil: NOW + 600_000 };
  cache.values.set("https://test/__weather_cache__/" + encodeURIComponent(key), Response.json(malformed));
  let calls = 0;
  let received;
  const good = envelope({ storedAt: Date.now(), freshUntil: Date.now() + 300_000, staleUntil: Date.now() + 600_000 });
  const env = edgeEnv(async (_url, init) => { calls += 1; received = JSON.parse(init.body); return Response.json(good); });

  await withGlobals({ caches: { default: cache } }, async () => {
    const response = await weatherResponse(request("/api/weather?lon=2&lat=1&extra=ignored"), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), BROWSER_CACHE_CONTROL);
    assert.deepEqual(await response.json(), transformedPayload);
    assert.deepEqual(received, { key, lat: 1, lon: 2, state: "miss" });
    assert.equal(calls, 1, "invalid cache envelope must be ignored");

    assert.equal(cache.puts.length, 1);
    assert.equal(cache.puts[0].response.headers.get("cache-control"), "public, max-age=600");
    assert.notEqual(cache.puts[0].response.headers.get("cache-control"), BROWSER_CACHE_CONTROL);
    assert.deepEqual(await cache.puts[0].response.json(), good);

    await weatherResponse(request("/api/weather?lat=1.0&lon=2"), env);
    assert.equal(calls, 1, "equivalent parsed Numbers must share the internal key");
  });
});

test("malformed Durable Object envelopes are never cached or served", async () => {
  const cache = new FakeCache();
  const env = edgeEnv(async () => Response.json({ v: 1, key: weatherKey({ lat: 1, lon: 2 }), payload: { bad: true }, storedAt: NOW, freshUntil: NOW + 1, staleUntil: NOW + 2 }));
  await withGlobals({ caches: { default: cache } }, async () => {
    const response = await weatherResponse(request("/api/weather?lat=1&lon=2"), env);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Failed to refresh weather data." });
    assert.equal(cache.puts.length, 0);
  });
});

test("WeatherGate rejects malformed or mismatched strict coordinate keys before provider access", async () => {
  const { storage } = storageWith();
  const gate = new WeatherGate({ storage }, gateEnv());
  let providerCalls = 0;
  await withGlobals({ fetch: async () => { providerCalls += 1; return Response.json(upstreamPayload); } }, async () => {
    for (const body of [
      { key: "weather:v1:lat:2:lon:2", lat: 1, lon: 2, state: "miss" },
      { key: weatherKey({ lat: 1, lon: 2 }), lat: 91, lon: 2, state: "miss" },
      { key: weatherKey({ lat: 1, lon: 2 }), lat: 1, lon: 2, state: "other" },
      { key: weatherKey({ lat: 1, lon: 2 }), lat: "1", lon: 2, state: "miss" },
    ]) assert.equal((await gate.fetch(gateRequest(body))).status, 400);
    assert.equal((await gate.fetch(gateRequest({ key: weatherKey({ lat: 1, lon: 2 }), lat: 1, lon: 2 }, "/wrong"))).status, 404);
  });
  assert.equal(providerCalls, 0);
});

test("daily provider-attempt limit is transactional, fail-closed, and returns controlled 500 semantics", async () => {
  const { storage, values } = storageWith();
  const gate = new WeatherGate({ storage }, gateEnv({ WEATHER_DAILY_ATTEMPT_LIMIT: "1" }));
  let providerCalls = 0;
  await withGlobals({ fetch: async () => { providerCalls += 1; return Response.json(upstreamPayload); } }, async () => {
    const first = await gate.fetch(gateRequest({ key: weatherKey({ lat: 1, lon: 2 }), lat: 1, lon: 2, state: "miss" }));
    assert.equal(first.status, 200);
    const denied = await gate.fetch(gateRequest({ key: weatherKey({ lat: 3, lon: 4 }), lat: 3, lon: 4, state: "miss" }));
    assert.equal(denied.status, 500);
    assert.deepEqual(await denied.json(), { error: "Failed to refresh weather data." });
  });
  assert.equal(providerCalls, 1);
  assert.equal(values.get(`attempts:${new Date().toISOString().slice(0, 10)}`), 1);

  const disabled = new WeatherGate({ storage: storageWith().storage }, gateEnv({ WEATHER_DAILY_ATTEMPT_LIMIT: "0" }));
  await withGlobals({ fetch: async () => { throw new Error("must not call provider"); } }, async () => {
    assert.equal((await disabled.fetch(gateRequest({ key: weatherKey({ lat: 5, lon: 6 }), lat: 5, lon: 6, state: "miss" }))).status, 500);
  });
});

test("provider timeout aborts its sole attempt and never retries", async () => {
  const { storage, values } = storageWith();
  const gate = new WeatherGate({ storage }, gateEnv({ WEATHER_TIMEOUT_MS: "5" }));
  let providerCalls = 0;
  let aborted = false;
  await withGlobals({ fetch: async (_url, init) => {
    providerCalls += 1;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true }));
  } }, async () => {
    const response = await gate.fetch(gateRequest({ key: weatherKey({ lat: 1, lon: 2 }), lat: 1, lon: 2, state: "miss" }));
    assert.equal(response.status, 500);
  });
  assert.equal(providerCalls, 1);
  assert.equal(aborted, true);
  assert.equal(values.get(`attempts:${new Date().toISOString().slice(0, 10)}`), 1);
});

test("WeatherGate serves unexpired stale Durable Object data on budget or provider failure without extending it", async () => {
  const key = weatherKey({ lat: 1, lon: 2 });
  const stale = envelope();
  const dayKey = `attempts:${new Date().toISOString().slice(0, 10)}`;

  const budgetStore = storageWith({ [`weather:${key}`]: stale, [dayKey]: 1 });
  const budgetGate = new WeatherGate({ storage: budgetStore.storage }, gateEnv({ WEATHER_DAILY_ATTEMPT_LIMIT: "1" }));
  let providerCalls = 0;
  await withGlobals({ Date: class extends Date { static now() { return NOW; } }, fetch: async () => { providerCalls += 1; throw new Error("unexpected"); } }, async () => {
    const response = await budgetGate.fetch(gateRequest({ key, lat: 1, lon: 2, state: "miss" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), stale);
  });
  assert.equal(providerCalls, 0);

  const failureStore = storageWith({ [`weather:${key}`]: stale });
  const failureGate = new WeatherGate({ storage: failureStore.storage }, gateEnv());
  await withGlobals({ Date: class extends Date { static now() { return NOW; } }, fetch: async () => { providerCalls += 1; return new Response("unavailable", { status: 503 }); } }, async () => {
    const response = await failureGate.fetch(gateRequest({ key, lat: 1, lon: 2, state: "miss" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), stale);
  });
  assert.equal(providerCalls, 1);
  assert.deepEqual(failureStore.values.get(`weather:${key}`), stale, "failed refresh must not extend stale timestamps");
});

test("edge serves stale immediately and retains it when background refresh fails", async () => {
  const cache = new FakeCache();
  const key = weatherKey({ lat: 1, lon: 2 });
  const stale = envelope({ storedAt: Date.now() - 400_000, freshUntil: Date.now() - 1, staleUntil: Date.now() + 200_000 });
  cache.values.set("https://test/__weather_cache__/" + encodeURIComponent(key), Response.json(stale, { headers: { "cache-control": "public, max-age=200" } }));
  let refreshCalls = 0;
  const waits = [];
  await withGlobals({ caches: { default: cache } }, async () => {
    const response = await weatherResponse(request("/api/weather?lat=1&lon=2"), edgeEnv(async () => {
      refreshCalls += 1;
      return Response.json({ error: "Failed to refresh weather data." }, { status: 500 });
    }), { waitUntil(promise) { waits.push(promise); } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), transformedPayload);
    await Promise.all(waits);
  });
  assert.equal(refreshCalls, 1);
  assert.equal(cache.puts.length, 0);
});

test("provider transformation matches source and forwards exact parsed Number coordinates", async () => {
  assert.deepEqual(transformOpenWeather(upstreamPayload), transformedPayload);
  const lat = 12.345678901234;
  const lon = -45.678901234567;
  const key = weatherKey({ lat, lon });
  const { storage } = storageWith();
  const gate = new WeatherGate({ storage }, gateEnv());
  let providerUrl;
  await withGlobals({ fetch: async (url) => {
    providerUrl = new URL(url);
    return Response.json({ ...upstreamPayload, coord: { lat, lon } });
  } }, async () => {
    assert.equal((await gate.fetch(gateRequest({ key, lat, lon, state: "miss" }))).status, 200);
  });
  assert.equal(providerUrl.searchParams.get("lat"), String(lat));
  assert.equal(providerUrl.searchParams.get("lon"), String(lon));
});

test("same-key concurrent misses coalesce inside one WeatherGate instance", async () => {
  const { storage } = storageWith();
  const gate = new WeatherGate({ storage }, gateEnv());
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let providerCalls = 0;
  await withGlobals({ fetch: async () => { providerCalls += 1; await blocked; return Response.json(upstreamPayload); } }, async () => {
    const body = { key: weatherKey({ lat: 1, lon: 2 }), lat: 1, lon: 2, state: "miss" };
    const first = gate.fetch(gateRequest(body));
    const second = gate.fetch(gateRequest(body));
    await new Promise((resolve) => setImmediate(resolve));
    release();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
  });
  assert.equal(providerCalls, 1);
});

test("HTML rendering performs zero weather provider calls", async () => {
  const { createHonoPageRenderer } = await import("../workers/hono-page-renderer.mjs");
  let gateCalls = 0;
  const app = createHonoPageRenderer();
  const response = await app.fetch(request("/"), {
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
    WEATHER_GATE: fakeGate(async () => { gateCalls += 1; return Response.json(envelope()); }),
  });
  assert.equal(response.status, 200);
  assert.equal(gateCalls, 0);
});
