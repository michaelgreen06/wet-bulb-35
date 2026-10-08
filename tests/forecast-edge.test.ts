import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FORECAST_BROWSER_CACHE_CONTROL,
  forecastKey,
  forecastResponse,
  forecastTunables,
  refreshForecast,
  validForecastGateRequest,
} from "../workers/forecast-edge.ts";
import { createHonoPageRenderer } from "../workers/hono-page-renderer.mjs";
import { createObservability, WeatherGate } from "../workers/weather-edge.mjs";
import { hasPass, issuePass } from "../workers/weather-turnstile.ts";

const location = {
  path: "/wetbulb-temperature/united-states/texas/houston/",
  name: "Houston, Texas, United States",
  latitude: 29.7604,
  longitude: -95.3698,
};
const ordinaryLocation = {
  path: "/wetbulb-temperature/united-states/texas/beaumont/",
  name: "Beaumont, Texas, United States",
  latitude: 30.0802,
  longitude: -94.1266,
};

function upstreamFixture() {
  const time: string[] = [];
  const temperature_2m: number[] = [];
  const dew_point_2m: number[] = [];
  const surface_pressure: number[] = [];
  for (let day = 20; day <= 24; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      time.push(`2026-09-${day}T${String(hour).padStart(2, "0")}:00`);
      temperature_2m.push(25 + hour / 10);
      dew_point_2m.push(20 - hour / 20);
      surface_pressure.push(1005);
    }
  }
  return {
    latitude: 29.75,
    longitude: -95.375,
    elevation: 12,
    utc_offset_seconds: -18_000,
    timezone: "America/Chicago",
    hourly_units: {
      time: "iso8601",
      temperature_2m: "°C",
      dew_point_2m: "°C",
      surface_pressure: "hPa",
    },
    hourly: { time, temperature_2m, dew_point_2m, surface_pressure },
  };
}

type FakeStorage = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  transaction<T>(callback: (transaction: FakeStorage) => Promise<T>): Promise<T>;
};

function fakeStorage(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: FakeStorage = {
    async get(key: string) { return values.get(key); },
    async put(key: string, value: unknown) { values.set(key, value); },
    async transaction<T>(callback: (transaction: FakeStorage) => Promise<T>) { return callback(storage); },
  };
  return { storage, values };
}

class FakeCache {
  values = new Map<string, Response>();
  puts: string[] = [];
  async match(key: string) { return this.values.get(String(key))?.clone(); }
  async put(key: string, response: Response) {
    this.puts.push(String(key));
    this.values.set(String(key), response.clone());
  }
}

const gateBody = () => ({ key: forecastKey(location.path), location, state: "miss" as const });
const gateEnv = (overrides = {}) => ({
  FORECAST_FRESH_SECONDS: "10800",
  FORECAST_STALE_SECONDS: "43200",
  FORECAST_TIMEOUT_MS: "5000",
  FORECAST_DAILY_ATTEMPT_LIMIT: "2000",
  OPEN_METEO_API_MODE: "public-noncommercial",
  OBSERVABILITY: { weather() {}, forecast() {} },
  ...overrides,
});

// Houston local time 10:00 on 2026-09-20, the first fixture date.
const NOW = Date.parse("2026-09-20T15:00:00Z");
const RUN_INITIALIZATION = "2026-09-20T00:00:00Z";
const modelMetadata = (availableAt = "2026-09-20T07:30:00Z") => ({
  last_run_initialisation_time: Date.parse(RUN_INITIALIZATION) / 1_000,
  last_run_availability_time: Date.parse(availableAt) / 1_000,
  update_interval_seconds: 21_600,
});
let metadataCalls = 0;
let metadataResponse: () => Response = () => Response.json(modelMetadata());

/** Routes Open-Meteo's static model metadata separately from weighted forecast calls. */
function stubProvider(handler: (input: URL | RequestInfo) => Promise<Response>) {
  vi.stubGlobal("fetch", async (input: URL | RequestInfo) => {
    if (String(input).includes("/data/ecmwf_ifs025/static/meta.json")) {
      metadataCalls += 1;
      return metadataResponse();
    }
    return handler(input);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  metadataCalls = 0;
  metadataResponse = () => Response.json(modelMetadata());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("forecast edge and WeatherGate integration", () => {
  it("uses the reviewed 2,000-attempt site-wide forecast safety limit", () => {
    expect(forecastTunables(gateEnv()).dailyAttempts).toBe(2000);
  });

  it("validates method, bots, canonical paths, and resolved city identity before gate access", async () => {
    let resolverCalls = 0;
    let gateCalls = 0;
    const resolver = async () => { resolverCalls += 1; return location; };
    const env = {
      WEATHER_GATE: {
        idFromName: () => "WeatherGate",
        get: () => ({ fetch: async () => { gateCalls += 1; return new Response(null, { status: 500 }); } }),
      },
    };
    expect((await forecastResponse(new Request("https://test/api/forecast", { method: "POST" }), env, undefined, resolver)).status).toBe(405);
    expect((await forecastResponse(new Request("https://test/api/forecast", { headers: { "user-agent": "Googlebot" } }), env, undefined, resolver)).status).toBe(204);
    expect((await forecastResponse(new Request("https://test/api/forecast?path=bad"), env, undefined, resolver)).status).toBe(400);
    expect(resolverCalls).toBe(0);
    expect(gateCalls).toBe(0);

    const unavailable = await forecastResponse(
      new Request("https://test/api/forecast?path=" + encodeURIComponent(location.path)),
      env,
      undefined,
      async () => null,
    );
    expect(unavailable.status).toBe(404);
    expect(gateCalls).toBe(0);
  });

  it("uses one exact Open-Meteo request, stores raw and calculated data separately, and reuses both caches", async () => {
    const { storage, values } = fakeStorage();
    let providerCalls = 0;
    let requestedUrl: URL | null = null;
    stubProvider(async (input: URL | RequestInfo) => {
      providerCalls += 1;
      requestedUrl = new URL(String(input));
      return Response.json(upstreamFixture());
    });

    const first = await refreshForecast(storage, gateEnv(), gateBody());
    const second = await refreshForecast(storage, gateEnv(), gateBody());
    expect(providerCalls).toBe(1);
    expect(first).toEqual(second);
    expect(first.payload.days).toHaveLength(5);
    const verifiedUrl = requestedUrl as URL | null;
    expect(verifiedUrl).not.toBeNull();
    expect(verifiedUrl?.searchParams.get("hourly")).toBe("temperature_2m,dew_point_2m,surface_pressure");
    expect(verifiedUrl?.searchParams.get("forecast_days")).toBe("5");
    expect(verifiedUrl?.searchParams.get("models")).toBe("ecmwf_ifs025");
    // New current-day result keys never collide with the old future-only cache.
    expect([...values.keys()].some((key) => key.startsWith("forecast-source:open-meteo:v4:"))).toBe(true);
    expect([...values.keys()].some((key) => key.startsWith("forecast-result:forecast:v5:"))).toBe(true);
    expect(first.payload.providerModel).toBe("ecmwf_ifs025");
    expect(first.payload.runs).toEqual([{ id: "latest", model: "ecmwf_ifs025", initialization: RUN_INITIALIZATION, retrievedAt: NOW }]);
    expect(metadataCalls).toBe(1);
    const day = new Date().toISOString().slice(0, 10);
    expect(values.get(`forecast-attempts:${day}`)).toBe(1);
    expect(values.has(`attempts:${day}`)).toBe(false);
  });

  it("uses the licensed customer endpoint when an API-key secret is configured", async () => {
    const { storage } = fakeStorage();
    let requestedUrl: URL | null = null;
    stubProvider(async (input: URL | RequestInfo) => {
      requestedUrl = new URL(String(input));
      return Response.json(upstreamFixture());
    });
    await refreshForecast(storage, gateEnv({ OPEN_METEO_API_MODE: "customer-commercial", OPEN_METEO_API_KEY: "secret-test-key" }), gateBody());
    expect((requestedUrl as URL | null)?.hostname).toBe("customer-api.open-meteo.com");
    expect((requestedUrl as URL | null)?.searchParams.get("apikey")).toBe("secret-test-key");
  });

  it("serves a validated forecast through a private browser response and Cache API envelope", async () => {
    const { storage } = fakeStorage();
    stubProvider(async () => Response.json(upstreamFixture()));
    const envelope = await refreshForecast(storage, gateEnv(), gateBody());
    const cache = new FakeCache();
    let gateCalls = 0;
    const env = {
      WEATHER_GATE: {
        idFromName(name: string) { expect(name).toBe("WeatherGate"); return name; },
        get: () => ({ fetch: async () => { gateCalls += 1; return Response.json(envelope); } }),
      },
    };
    const request = new Request("https://test/api/forecast?path=" + encodeURIComponent(location.path));
    const response = await forecastResponse(request, env, undefined, async () => location, cache);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(FORECAST_BROWSER_CACHE_CONTROL);
    expect((await response.json()).days).toHaveLength(5);
    expect(gateCalls).toBe(1);
    expect(cache.puts).toHaveLength(1);

    const cached = await forecastResponse(request, env, undefined, async () => location, cache);
    expect(cached.status).toBe(200);
    expect(gateCalls).toBe(1);
  });

  it("challenges an uncached forecast before invoking the provider gate", async () => {
    let gateCalls = 0;
    const guarded = {
      WEATHER_TURNSTILE_MODE: "enforce", WEATHER_TURNSTILE_SITE_KEY: "public-test-key",
      WEATHER_TURNSTILE_SECRET_KEY: "private-test-secret", WEATHER_TURNSTILE_HOSTNAME: "www.wetbulb35.com",
      WEATHER_GATE: { idFromName: () => "WeatherGate", get: () => ({ fetch: async (url: string) => { if (url.endsWith("/forecast-peek")) return new Response(null, { status: 404 }); gateCalls++; return new Response(null, { status: 500 }); } }) },
    };
    const request = new Request("https://www.wetbulb35.com/api/forecast?path=" + encodeURIComponent(location.path));
    const response = await forecastResponse(request, guarded, undefined, async () => location, new FakeCache());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "verification_required", sitekey: "public-test-key" });
    expect(gateCalls).toBe(0);
  });

  it("accepts one Siteverify token and shares the signed pass with current conditions", async () => {
    const { storage } = fakeStorage();
    stubProvider(async () => Response.json(upstreamFixture()));
    const envelope = await refreshForecast(storage, gateEnv(), gateBody());
    const calls: string[] = [];
    const env = {
      WEATHER_TURNSTILE_MODE: "enforce", WEATHER_TURNSTILE_SITE_KEY: "public-test-key",
      WEATHER_TURNSTILE_SECRET_KEY: "private-test-secret", WEATHER_TURNSTILE_HOSTNAME: "www.wetbulb35.com",
      WEATHER_GATE: { idFromName: () => "WeatherGate", get: () => ({ fetch: async (url: string) => {
        calls.push(url);
        return url.endsWith("/forecast-peek") ? new Response(null, { status: 404 }) : Response.json(envelope);
      } }) },
    };
    const url = "https://www.wetbulb35.com/api/forecast?path=" + encodeURIComponent(location.path);
    const tokenRequest = () => new Request(url, { headers: { "x-weather-turnstile": "one-use-token" } });
    for (const verification of [{ success: false }, { success: true, hostname: "other.example", action: "weather_refresh" }, { success: true, hostname: "www.wetbulb35.com", action: "other" }]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(verification)));
      const response = await forecastResponse(tokenRequest(), env, undefined, async () => location, new FakeCache());
      expect(response.status).toBe(403);
      expect(calls.every((call) => call.endsWith("/forecast-peek"))).toBe(true);
    }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, hostname: "www.wetbulb35.com", action: "weather_refresh" })));
    const accepted = await forecastResponse(tokenRequest(), env, undefined, async () => location, new FakeCache());
    expect(accepted.status).toBe(200);
    const cookie = accepted.headers.get("set-cookie")!;
    expect(cookie).toMatch(/; Path=\/api; Secure; HttpOnly; SameSite=Lax$/);
    expect(await hasPass(new Request("https://www.wetbulb35.com/api/weather", { headers: { cookie: cookie.split(";")[0] } }), env)).toBe(true);
    const withPass = await forecastResponse(new Request(url, { headers: { cookie: cookie.split(";")[0] } }), env, undefined, async () => location, new FakeCache());
    expect(withPass.status).toBe(200);
    expect(calls.filter((call) => call.endsWith("/forecast"))).toHaveLength(2);
    const tampered = cookie.split(";")[0].slice(0, -1) + (cookie.split(";")[0].endsWith("0") ? "1" : "0");
    expect(await hasPass(new Request("https://www.wetbulb35.com/api/weather", { headers: { cookie: tampered } }), env)).toBe(false);
    expect(await hasPass(new Request("https://www.wetbulb35.com/api/weather", { headers: { cookie: `${tampered}; ${cookie.split(";")[0]}` } }), env)).toBe(true);
  });

  it("serves stale forecasts without an unverified background provider refresh", async () => {
    const { storage } = fakeStorage();
    stubProvider(async () => {
      const fixture = upstreamFixture();
      fixture.hourly.temperature_2m[20] = 40;
      fixture.hourly.dew_point_2m[20] = 33;
      return Response.json(fixture);
    });
    const envelope = await refreshForecast(storage, gateEnv(), gateBody());
    const cache = new FakeCache();
    const gateUrls: string[] = [];
    const env = {
      WEATHER_TURNSTILE_MODE: "enforce", WEATHER_TURNSTILE_SITE_KEY: "public-test-key",
      WEATHER_TURNSTILE_SECRET_KEY: "private-test-secret", WEATHER_TURNSTILE_HOSTNAME: "www.wetbulb35.com",
      WEATHER_GATE: { idFromName: () => "WeatherGate", get: () => ({ fetch: async (url: string) => { gateUrls.push(url); return Response.json(envelope); } }) },
    };
    const url = "https://www.wetbulb35.com/api/forecast?path=" + encodeURIComponent(location.path);
    expect((await forecastResponse(new Request(url), { ...env, WEATHER_TURNSTILE_MODE: "off" }, undefined, async () => location, cache)).status).toBe(200);
    gateUrls.length = 0;
    vi.setSystemTime(NOW + 4 * 60 * 60 * 1_000);
    const waitUntil = vi.fn();
    const stale = await forecastResponse(new Request(url), env, { waitUntil }, async () => location, cache);
    expect(stale.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(gateUrls).toHaveLength(0);
    const cookie = (await issuePass(env)).split(";")[0];
    const authorized = await forecastResponse(new Request(url, { headers: { cookie } }), env, { waitUntil }, async () => location, cache);
    expect(authorized.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    expect(gateUrls).toEqual(["https://weather-gate/forecast"]);
  });

  it("fails closed on misconfigured enforcement before any provider call", async () => {
    const gate = vi.fn(async () => new Response(null, { status: 500 }));
    const env = { WEATHER_TURNSTILE_MODE: "enforce", WEATHER_GATE: { idFromName: () => "WeatherGate", get: () => ({ fetch: gate }) } };
    const url = "https://www.wetbulb35.com/api/forecast?path=" + encodeURIComponent(location.path);
    const response = await forecastResponse(new Request(url), env, undefined, async () => location, new FakeCache());
    expect(response.status).toBe(503);
    expect(gate).not.toHaveBeenCalled();
  });

  it("reads the global forecast gate without challenge when another POP cached the same run", async () => {
    const { storage, values } = fakeStorage();
    stubProvider(async () => Response.json(upstreamFixture()));
    const envelope = await refreshForecast(storage, gateEnv(), gateBody());
    const gate = new WeatherGate({ storage }, gateEnv());
    const calls: string[] = [];
    const env = {
      WEATHER_TURNSTILE_MODE: "enforce", WEATHER_TURNSTILE_SITE_KEY: "public-test-key",
      WEATHER_TURNSTILE_SECRET_KEY: "private-test-secret", WEATHER_TURNSTILE_HOSTNAME: "www.wetbulb35.com",
      WEATHER_GATE: { idFromName: () => "WeatherGate", get: () => ({ fetch: async (url: string, init?: RequestInit) => {
        calls.push(url); return gate.fetch(new Request(url, init));
      } }) },
    };
    const url = "https://www.wetbulb35.com/api/forecast?path=" + encodeURIComponent(location.path);
    expect((await forecastResponse(new Request(url), env, undefined, async () => location, new FakeCache())).status).toBe(200);
    expect(calls).toEqual(["https://weather-gate/forecast-peek"]);
    expect(values.get(`forecast-attempts:${new Date().toISOString().slice(0, 10)}`)).toBe(1);
    expect(envelope.payload.days).toHaveLength(5);
  });

  it("fails closed when the independent forecast budget is disabled", async () => {
    const { storage } = fakeStorage();
    let providerCalls = 0;
    stubProvider(async () => { providerCalls += 1; return Response.json(upstreamFixture()); });
    await expect(refreshForecast(storage, gateEnv({ FORECAST_DAILY_ATTEMPT_LIMIT: "0" }), gateBody())).rejects.toThrow();
    expect(providerCalls).toBe(0);
  });

  it("fails closed before budget or provider access when production API mode is disabled", async () => {
    const { storage, values } = fakeStorage();
    let providerCalls = 0;
    stubProvider(async () => { providerCalls += 1; return Response.json(upstreamFixture()); });
    await expect(refreshForecast(storage, gateEnv({ OPEN_METEO_API_MODE: "disabled" }), gateBody())).rejects.toThrow(/not approved/);
    expect(providerCalls).toBe(0);
    expect([...values.keys()].some((key) => key.startsWith("forecast-attempts:"))).toBe(false);
  });

  it("returns stale forecast data without extending it when Open-Meteo fails", async () => {
    vi.useFakeTimers();
    const started = new Date("2026-09-20T12:00:00Z");
    vi.setSystemTime(started);
    const { storage, values } = fakeStorage();
    stubProvider(async () => {
      const fixture = upstreamFixture();
      fixture.hourly.temperature_2m[17] = 40; // 17:00 local, still ahead at the 11:00 stale check.
      fixture.hourly.dew_point_2m[17] = 33;
      return Response.json(fixture);
    });
    const first = await refreshForecast(storage, gateEnv(), gateBody());

    vi.setSystemTime(new Date(started.getTime() + 4 * 60 * 60 * 1_000));
    stubProvider(async () => new Response("unavailable", { status: 503 }));
    const stale = await refreshForecast(storage, gateEnv(), gateBody());
    expect(stale).toEqual(first);
    expect(values.get(`forecast-result:${gateBody().key}`)).toEqual(first);
  });

  it("coalesces concurrent forecast misses inside the existing WeatherGate instance", async () => {
    const { storage } = fakeStorage();
    const gate = new WeatherGate({ storage }, gateEnv());
    let providerCalls = 0;
    let release: ((response: Response) => void) | undefined;
    stubProvider(async () => {
      providerCalls += 1;
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    const request = () => new Request("https://weather-gate/forecast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(gateBody()),
    });
    const first = gate.fetch(request());
    const second = gate.fetch(request());
    await vi.waitFor(() => expect(providerCalls).toBe(1));
    release?.(Response.json(upstreamFixture()));
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(providerCalls).toBe(1);
  });

  it("Hono exposes the endpoint for every exact canonical city path and resolved static coordinates", async () => {
    const { storage } = fakeStorage();
    stubProvider(async () => Response.json(upstreamFixture()));
    const envelope = await refreshForecast(storage, gateEnv(), gateBody());
    const ordinaryEnvelope = await refreshForecast(storage, gateEnv(), {
      key: forecastKey(ordinaryLocation.path),
      location: ordinaryLocation,
      state: "miss",
    });
    let gateBodyReceived: Record<string, unknown> | null = null;
    const assets = {
      async fetch(request: Request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/locations/route-manifest.json") {
          return Response.json({
            v: 1,
            countries: [{
              country: "United States",
              countrySlug: "united-states",
              file: "united-states.json",
              count: 2,
              states: [{ slug: "texas", name: "Texas", count: 2 }],
            }],
          });
        }
        if (pathname === "/locations/shards/united-states.json") {
          return Response.json({ v: 1, r: [
            ["Beaumont", "Texas", ordinaryLocation.latitude, ordinaryLocation.longitude, "beaumont"],
            ["Houston", "Texas", location.latitude, location.longitude, "houston"],
          ] });
        }
        return new Response("missing", { status: 404 });
      },
    };
    const env = {
      OPEN_METEO_API_MODE: "public-noncommercial",
      ASSETS: assets,
      WEATHER_GATE: {
        idFromName: () => "WeatherGate",
        get: () => ({
          fetch: async (_url: string, init?: RequestInit) => {
            gateBodyReceived = JSON.parse(String(init?.body));
            return Response.json(gateBodyReceived?.key === forecastKey(ordinaryLocation.path) ? ordinaryEnvelope : envelope);
          },
        }),
      },
    };
    const app = createHonoPageRenderer();
    const popular = await app.fetch(new Request("https://test/api/forecast?path=" + encodeURIComponent(location.path)), env);
    expect(popular.status).toBe(200);
    expect(gateBodyReceived).toMatchObject({
      location: {
        path: location.path,
        latitude: location.latitude,
        longitude: location.longitude,
      },
    });

    gateBodyReceived = null;
    const ordinary = await app.fetch(new Request("https://test/api/forecast?path=" + encodeURIComponent(ordinaryLocation.path)), env);
    expect(ordinary.status).toBe(200);
    expect(gateBodyReceived).toMatchObject({ location: ordinaryLocation });

    gateBodyReceived = null;
    const unavailable = await app.fetch(new Request("https://test/api/forecast?path=" + encodeURIComponent("/wetbulb-temperature/andorra/encamp/vila/")), env);
    expect(unavailable.status).toBe(404);
    expect(gateBodyReceived).toBeNull();
    expect((await app.fetch(new Request("https://test/api/forecast/"), env)).status).toBe(404);

    const disabledEnv = { ...env, OPEN_METEO_API_MODE: "disabled" };
    expect((await app.fetch(new Request("https://test/api/forecast?path=" + encodeURIComponent(location.path)), disabledEnv)).status).toBe(404);
    const disabledPage = await app.fetch(new Request("https://test" + location.path), disabledEnv);
    expect(await disabledPage.text()).not.toContain("data-forecast-widget");
  });

  it("emits only fixed forecast telemetry fields", () => {
    const events: unknown[] = [];
    const observability = createObservability({ deploymentVersion: "version-1", logger: (event: unknown) => events.push(event) });
    observability.forecast({
      event: "forecast_provider_call",
      outcome: "success",
      upstream_status: 200,
      latency_ms: 12,
      cache_state: "miss",
      reserved_budget_used: 1,
      reserved_budget_limit: 500,
      path: location.path,
      latitude: location.latitude,
    });
    expect(events).toEqual([{
      event: "forecast_provider_call",
      deployment_version: "version-1",
      outcome: "success",
      upstream_status: 200,
      latency_ms: 12,
      cache_state: "miss",
      reserved_budget_used: 1,
      reserved_budget_limit: 500,
    }]);
  });

  it("rejects forged gate keys and arbitrary coordinate requests", () => {
    expect(validForecastGateRequest(gateBody())).toBe(true);
    expect(validForecastGateRequest({ ...gateBody(), key: "forged" })).toBe(false);
    expect(validForecastGateRequest({ ...gateBody(), location: { ...location, latitude: 91 } })).toBe(false);
  });
});
