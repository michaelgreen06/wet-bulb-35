import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  combinePinnedForecast,
  isWetBulbForecast,
  normalizeOpenMeteoForecast,
  resolveModelInitialization,
  type PinnedDailyForecast,
  type WetBulbForecast,
} from "../lib/forecast/open-meteo.ts";
import { createHotspotSnapshot } from "../lib/hotspots/snapshot.ts";
import { forecastKey, forecastResponse, refreshForecast } from "../workers/forecast-edge.ts";
import { createHonoPageRenderer } from "../workers/hono-page-renderer.mjs";

const location = {
  path: "/wetbulb-temperature/united-states/texas/houston/",
  name: "Houston, Texas, United States",
  latitude: 29.7604,
  longitude: -95.3698,
};
// Houston local time 10:00 on 2026-09-20 (fixed UTC-5 provider offset).
const NOW = Date.parse("2026-09-20T15:00:00Z");
const RUN = "2026-09-20T00:00:00Z";
const PINNED_RUN = "2026-09-19T18:00:00Z";

function upstream(firstDay = 20) {
  const time: string[] = [];
  const temperature_2m: number[] = [];
  const dew_point_2m: number[] = [];
  const surface_pressure: number[] = [];
  for (let day = firstDay; day < firstDay + 5; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      time.push(`2026-09-${day}T${String(hour).padStart(2, "0")}:00`);
      temperature_2m.push(25 + hour / 10);
      dew_point_2m.push(20 - hour / 20);
      surface_pressure.push(1005);
    }
  }
  return {
    latitude: 29.75, longitude: -95.375, elevation: 12, utc_offset_seconds: -18_000, timezone: "America/Chicago",
    hourly_units: { time: "iso8601", temperature_2m: "°C", dew_point_2m: "°C", surface_pressure: "hPa" },
    hourly: { time, temperature_2m, dew_point_2m, surface_pressure },
  };
}

const metadata = (availableAt: string) => ({
  last_run_initialisation_time: Date.parse(RUN) / 1_000,
  last_run_availability_time: Date.parse(availableAt) / 1_000,
});

function pinned(dates: string[]): PinnedDailyForecast {
  return {
    initialization: PINNED_RUN,
    retrievedAt: "2026-09-20T02:10:00Z",
    timezone: "America/Chicago",
    utcOffsetSeconds: -18_000,
    days: dates.map((date) => ({ date, maximumWetBulbC: 29.5, peakLocalTime: `${date}T15:00` })),
  };
}

function fakeStorage() {
  const values = new Map<string, unknown>();
  type Storage = {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    transaction<T>(callback: (transaction: Storage) => Promise<T>): Promise<T>;
  };
  const storage: Storage = {
    async get(key: string) { return values.get(key); },
    async put(key: string, value: unknown) { values.set(key, value); },
    async transaction<T>(callback: (transaction: Storage) => Promise<T>) { return callback(storage); },
  };
  return { storage, values };
}

const gateEnv = { FORECAST_DAILY_ATTEMPT_LIMIT: "2000", OPEN_METEO_API_MODE: "public-noncommercial" };

function stubProvider(meta: () => Response = () => Response.json(metadata("2026-09-20T07:30:00Z")), body = () => Response.json(upstream())) {
  const calls = { forecast: 0, metadata: 0 };
  vi.stubGlobal("fetch", async (input: URL | RequestInfo) => {
    if (String(input).includes("/static/meta.json")) { calls.metadata += 1; return meta(); }
    calls.forecast += 1;
    return body();
  });
  return calls;
}

async function latestEnvelope() {
  const { storage } = fakeStorage();
  stubProvider();
  return refreshForecast(storage, gateEnv, { key: forecastKey(location.path), location, state: "miss" });
}

function gateFrom(responder: () => Response) {
  const calls = { count: 0 };
  return {
    calls,
    env: { WEATHER_GATE: { idFromName: () => "WeatherGate", get: () => ({ fetch: async () => { calls.count += 1; return responder(); } }) } },
  };
}

class FakeCache {
  values = new Map<string, Response>();
  async match(key: string | Request) { return this.values.get(typeof key === "string" ? key : key.url)?.clone(); }
  async put(key: string | Request, response: Response) { this.values.set(typeof key === "string" ? key : key.url, response.clone()); }
}

const request = () => new Request("https://test/api/forecast?path=" + encodeURIComponent(location.path));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("explicit IFS run attribution", () => {
  it("confirms a run only when it settled before the forecast request began", () => {
    expect(resolveModelInitialization(metadata("2026-09-20T07:30:00Z"), NOW)).toBe(RUN);
    // Available five minutes before the request: redundant servers may still answer from the prior run.
    expect(resolveModelInitialization(metadata("2026-09-20T14:55:00Z"), NOW)).toBeNull();
    expect(resolveModelInitialization({ last_run_initialisation_time: "x" }, NOW)).toBeNull();
    expect(resolveModelInitialization(null, NOW)).toBeNull();
  });

  it("keeps the forecast but leaves the run unconfirmed when metadata fails, without spending budget", async () => {
    const { storage, values } = fakeStorage();
    const calls = stubProvider(() => new Response("down", { status: 503 }));
    const envelope = await refreshForecast(storage, gateEnv, { key: forecastKey(location.path), location, state: "miss" });
    expect(envelope.payload.runs[0]).toMatchObject({ id: "latest", model: "ecmwf_ifs025", initialization: null });
    expect(calls).toEqual({ forecast: 1, metadata: 1 });
    expect(values.get("forecast-attempts:2026-09-20")).toBe(1);
  });

  it("rejects earlier best_match payloads instead of silently reverting models", async () => {
    const { payload } = await latestEnvelope();
    expect(isWetBulbForecast(payload)).toBe(true);
    expect(isWetBulbForecast({ ...payload, providerModel: "best_match" })).toBe(false);
    expect(isWetBulbForecast({ ...payload, schemaVersion: 2 })).toBe(false);
  });
});

describe("five-day local-date freshness", () => {
  it("rejects a lagging provider response that starts on a past local date", () => {
    expect(() => normalizeOpenMeteoForecast(upstream(19), location, NOW)).toThrow(/current local date/);
    expect(normalizeOpenMeteoForecast(upstream(20), location, NOW).hourly).toHaveLength(120);
  });

  it("does not serve a TTL-fresh forecast after the local date rolls over", async () => {
    const envelope = await latestEnvelope();
    const cache = new FakeCache();
    const gate = gateFrom(() => Response.json(envelope));
    expect((await forecastResponse(request(), gate.env, undefined, async () => location, cache)).status).toBe(200);
    expect(gate.calls.count).toBe(1);

    // 00:30 local on 2026-09-21: still inside the three-hour fresh TTL but day one has passed.
    vi.setSystemTime(Date.parse("2026-09-21T05:30:00Z"));
    const gateFailing = gateFrom(() => new Response(null, { status: 500 }));
    const rolled = await forecastResponse(request(), gateFailing.env, undefined, async () => location, cache);
    expect(gateFailing.calls.count).toBe(1);
    expect(rolled.status).toBe(500);
    expect(await rolled.json()).toEqual({ error: "Forecast is temporarily unavailable." });
  });

  it("stops serving stale data at the existing twelve-hour bound", async () => {
    const envelope = await latestEnvelope();
    const cache = new FakeCache();
    await forecastResponse(request(), gateFrom(() => Response.json(envelope)).env, undefined, async () => location, cache);

    vi.setSystemTime(NOW + 4 * 3_600_000);
    const stale = gateFrom(() => new Response(null, { status: 500 }));
    const waits: Promise<unknown>[] = [];
    const staleResponse = await forecastResponse(request(), stale.env, { waitUntil: (promise) => waits.push(promise) }, async () => location, cache);
    expect(staleResponse.status).toBe(200);
    expect((await staleResponse.json()).retrievedAt).toBe(NOW);
    await Promise.all(waits);

    vi.setSystemTime(NOW + 12 * 3_600_000);
    const expired = await forecastResponse(request(), stale.env, undefined, async () => location, cache);
    expect(expired.status).toBe(500);
  });

  it("returns stale WeatherGate results only while day one is still current", async () => {
    const { storage } = fakeStorage();
    stubProvider();
    const body = { key: forecastKey(location.path), location, state: "miss" as const };
    await refreshForecast(storage, gateEnv, body);
    stubProvider(undefined, () => new Response("down", { status: 503 }));
    vi.setSystemTime(Date.parse("2026-09-20T22:00:00Z"));
    await expect(refreshForecast(storage, gateEnv, body)).resolves.toMatchObject({ fetchedAt: NOW });
    vi.setSystemTime(Date.parse("2026-09-21T05:30:00Z"));
    await expect(refreshForecast(storage, gateEnv, body)).rejects.toThrow();
  });
});

describe("Top-50 pinned-run reuse", () => {
  const fullDates = ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"];

  it("does not reuse precomputed Top-50 days; city views now require an exact-run request", async () => {
    const gate = gateFrom(() => new Response(null, { status: 500 }));
    const response = await forecastResponse(request(), gate.env, undefined, async () => location, new FakeCache(), async () => pinned(fullDates));
    expect(response.status).toBe(500);
    expect(gate.calls.count).toBe(1);
  });

  it("does not mix a precomputed pinned run with latest data", async () => {
    const envelope = await latestEnvelope();
    const gate = gateFrom(() => Response.json(envelope));
    const response = await forecastResponse(request(), gate.env, undefined, async () => location, new FakeCache(), async () => pinned(fullDates.slice(1)));
    const payload = await response.json() as WetBulbForecast;
    expect(gate.calls.count).toBe(1);
    expect(payload.days.map((day) => day.runId)).toEqual(["latest", "latest", "latest", "latest", "latest"]);
    expect(payload.runs).toHaveLength(1);
    expect(isWetBulbForecast(payload)).toBe(true);
  });

  it("fails closed rather than truncating when neither run covers the remaining horizon", async () => {
    const gate = gateFrom(() => new Response(null, { status: 500 }));
    const response = await forecastResponse(request(), gate.env, undefined, async () => location, new FakeCache(), async () => pinned(fullDates.slice(1)));
    expect(response.status).toBe(500);
    expect(combinePinnedForecast(location, pinned(fullDates.slice(1)), null, NOW)).toBeNull();
  });

  it("never joins runs with different fixed offsets and ignores past pinned dates", async () => {
    const { payload } = await latestEnvelope();
    const shifted = { ...pinned(fullDates), utcOffsetSeconds: -21_600 };
    expect(combinePinnedForecast(location, shifted, payload, NOW)).toEqual(payload);
    const old = pinned(["2026-09-18", "2026-09-19"]);
    expect(combinePinnedForecast(location, old, payload, NOW)).toEqual(payload);
  });

  it("reads the published snapshot only while the hotspot gate is on and the window is current", async () => {
    const envelope = await latestEnvelope();
    const snapshot = createHotspotSnapshot({
      generatedAt: "2026-09-20T02:20:00Z",
      corpusCount: 2,
      discovery: { source: "ecmwf-ifs-0.25", initialization: PINNED_RUN, steps: [6, 9], marginC: 1.5, thresholdC: 27, dilationRings: 1, globalLandMaximumC: 30 },
      refinements: [{
        candidate: { ...location, name: "Houston", state: "Texas", country: "United States", selectionReason: "discovery", grid: { cellId: "29.7500:-95.2500", latitude: 29.75, longitude: -95.25 } },
        modelCell: { cellId: "29.7500:-95.2500", latitude: 29.75, longitude: -95.25, elevationM: 12 },
        maximumWetBulbC: 28, peakTime: "2026-09-20T20:00:00Z", airTemperatureC: 33, dewPointC: 26, surfacePressureHpa: 1005,
        validFrom: "2026-09-20T03:00:00Z", validTo: "2026-09-21T03:00:00Z",
      }],
    });
    const published = { ...snapshot, hotspots: [{ ...snapshot.hotspots[0], fiveDay: { ...pinned(fullDates), days: pinned(fullDates).days } }] };
    const text = JSON.stringify(published);
    const assets = {
      async fetch(assetRequest: Request) {
        const { pathname } = new URL(assetRequest.url);
        if (pathname === "/locations/route-manifest.json") {
          return Response.json({ v: 1, countries: [{ country: "United States", countrySlug: "united-states", file: "united-states.json", count: 1, states: [{ slug: "texas", name: "Texas", count: 1 }] }] });
        }
        if (pathname === "/locations/shards/united-states.json") return Response.json({ v: 1, r: [["Houston", "Texas", location.latitude, location.longitude, "houston"]] });
        return new Response("missing", { status: 404 });
      },
    };
    let gateCalls = 0;
    const baseEnv = {
      OPEN_METEO_API_MODE: "public-noncommercial",
      ASSETS: assets,
      HOTSPOT_SNAPSHOTS: { async get() { return { size: text.length, async text() { return text; } }; } },
      WEATHER_GATE: { idFromName: () => "WeatherGate", get: () => ({ fetch: async () => { gateCalls += 1; return Response.json(envelope); } }) },
    };
    const app = createHonoPageRenderer({ cache: () => new FakeCache() });
    const url = "https://test/api/forecast?path=" + encodeURIComponent(location.path);

    const pinnedResponse = await app.fetch(new Request(url), { ...baseEnv, HOTSPOT_FEATURE_MODE: "enabled" });
    expect(pinnedResponse.status).toBe(503);
    expect(gateCalls).toBe(1);

    const disabled = await app.fetch(new Request(url), baseEnv);
    expect((await disabled.json()).runs[0].id).toBe("latest");
    expect(gateCalls).toBe(2);

    vi.setSystemTime(Date.parse("2026-09-21T03:00:00Z"));
    // Local date is still 2026-09-20 (22:00), but the snapshot window has ended.
    const expired = await app.fetch(new Request(url), { ...baseEnv, HOTSPOT_FEATURE_MODE: "enabled" });
    expect(expired.status).toBe(503);
    expect(gateCalls).toBe(2);
  });
});
