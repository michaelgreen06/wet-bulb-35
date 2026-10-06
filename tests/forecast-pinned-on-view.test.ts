import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forecastKey, forecastResponse, refreshForecast, SNAPSHOT_FORECAST_UNAVAILABLE } from "../workers/forecast-edge.ts";
import { buildPinnedOpenMeteoForecastUrl, isCurrentForecast, normalizePinnedOpenMeteoForecast } from "../lib/forecast/open-meteo.ts";

const RUN = "2026-10-05T00:00:00Z";
const NOW = Date.parse("2026-10-05T12:30:00Z");
const ranked = { path: "/wetbulb-temperature/united-states/texas/houston/", name: "Houston", latitude: 29.7604, longitude: -95.3698 };
const ordinary = { path: "/wetbulb-temperature/united-states/texas/beaumont/", name: "Beaumont", latitude: 30.0802, longitude: -94.1266 };

function source(offsetSeconds = -18000, hours = 193) {
  return {
    latitude: ranked.latitude, longitude: ranked.longitude, elevation: 20,
    timezone: offsetSeconds === -18000 ? "America/Chicago" : "Asia/Kolkata", utc_offset_seconds: offsetSeconds,
    hourly_units: { time: "iso8601", temperature_2m: "°C", dew_point_2m: "°C", surface_pressure: "hPa" },
    hourly: {
      time: Array.from({ length: hours }, (_, i) => new Date(Date.parse(RUN) + i * 3600000 + offsetSeconds * 1000).toISOString().slice(0, 16)),
      temperature_2m: Array(hours).fill(30), dew_point_2m: Array(hours).fill(25), surface_pressure: Array(hours).fill(1005),
    },
  };
}
function storage() {
  const records = new Map<string, unknown>();
  type Storage = { get(key: string): Promise<unknown>; put(key: string, val: unknown): Promise<void>; transaction<T>(callback: (transaction: Storage) => Promise<T>): Promise<T> };
  const api: Storage = { async get(key: string) { return records.get(key); }, async put(key: string, val: unknown) { records.set(key, val); }, async transaction<T>(callback: (transaction: Storage) => Promise<T>) { return callback(api); } };
  return { api, records };
}
class Cache {
  records = new Map<string, Response>();
  async match(key: string) { return this.records.get(key)?.clone(); }
  async put(key: string, response: Response) { this.records.set(key, response.clone()); }
}
const env = { OPEN_METEO_API_MODE: "public-noncommercial", FORECAST_DAILY_ATTEMPT_LIMIT: "5" };
const request = (path: string, userAgent = "Mozilla/5.0") => new Request(`https://test/api/forecast?path=${encodeURIComponent(path)}`, { headers: { "user-agent": userAgent } });

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("on-view snapshot-run equality", () => {
  it("uses one exact-run request per viewed city, caches by run, and never calls the provider for crawlers", async () => {
    const { api, records } = storage();
    const cache = new Cache();
    const urls: URL[] = [];
    vi.stubGlobal("fetch", async (input: URL | RequestInfo) => { urls.push(new URL(String(input))); return Response.json(source()); });
    let gateCalls = 0;
    const gate = { WEATHER_GATE: { idFromName: () => "WeatherGate", get: () => ({ fetch: async (_url: string, options: RequestInit) => {
      gateCalls++;
      const body = JSON.parse(String(options.body));
      return Response.json(await refreshForecast(api, env, body));
    } }) } };
    const resolver = async (path: string) => [ranked, ordinary].find((city) => city.path === path) ?? null;
    const pinned = async () => RUN;
    const bot = await forecastResponse(request(ranked.path, "Googlebot"), gate, undefined, resolver, cache, pinned);
    expect(bot.status).toBe(204);
    expect(gateCalls).toBe(0);
    for (const city of [ranked, ordinary]) {
      const first = await forecastResponse(request(city.path), gate, undefined, resolver, cache, pinned);
      expect(first.status).toBe(200);
      const forecast = await first.json();
      expect(forecast.providerModel).toBe("ecmwf_ifs025");
      expect(forecast.runs).toEqual([{ id: "snapshot-pinned", model: "ecmwf_ifs025", initialization: RUN, retrievedAt: NOW }]);
      expect(forecast.days).toHaveLength(5);
      expect(forecast.days.map((day: { date: string }) => day.date)).toEqual([
        "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09",
      ]);
      expect((await forecastResponse(request(city.path), gate, undefined, resolver, cache, pinned)).status).toBe(200);
    }
    expect(urls).toHaveLength(2);
    expect(gateCalls).toBe(2);
    for (const url of urls) {
      expect(url.origin + url.pathname).toBe("https://single-runs-api.open-meteo.com/v1/forecast");
      expect(url.searchParams.get("models")).toBe("ecmwf_ifs025");
      expect(url.searchParams.get("run")).toBe("2026-10-05T00:00");
      expect(url.searchParams.get("forecast_hours")).toBe("193");
      expect(url.searchParams.get("latitude")?.includes(",")).toBe(false);
    }
    expect(records.get("forecast-attempts:2026-10-05")).toBe(2);
    expect(forecastKey(ranked.path, RUN)).not.toBe(forecastKey(ranked.path, "2026-10-05T06:00:00Z"));
  });

  it("rejects a missing simultaneous hour and supports half-hour offsets", () => {
    const halfHour = source(19800);
    expect(normalizePinnedOpenMeteoForecast(halfHour, ranked, NOW, RUN).days[0].peakLocalTime).toMatch(/:30$/);
    const incomplete = source();
    incomplete.hourly.surface_pressure[16] = null as unknown as number;
    expect(() => normalizePinnedOpenMeteoForecast(incomplete, ranked, NOW, RUN)).toThrow(/today’s remaining hours/);
  });

  it("shows only remaining hours today, then four complete local days; a passed peak invalidates the cached value", () => {
    const hourly = source();
    hourly.hourly.temperature_2m[10] = 45; // 05:00 local, already passed at 07:30.
    hourly.hourly.temperature_2m[16] = 31; // 11:00 local, still ahead.
    const result = normalizePinnedOpenMeteoForecast(hourly, ranked, NOW, RUN);
    expect(result.days).toHaveLength(5);
    expect(result.days[0].date).toBe("2026-10-05");
    expect(result.days[0].peakLocalTime).toBe("2026-10-05T11:00");
    expect(isCurrentForecast(result, NOW)).toBe(true);
    expect(isCurrentForecast(result, Date.parse("2026-10-05T16:00:00Z"))).toBe(false);
  });

  it("recalculates today's high when the displayed peak becomes passed, without changing the pinned run", async () => {
    const { api } = storage(); const cache = new Cache();
    const fixture = source(); fixture.hourly.temperature_2m[16] = 31;
    let providerCalls = 0;
    vi.stubGlobal("fetch", async () => { providerCalls += 1; return Response.json(fixture); });
    const gate = { WEATHER_GATE: { idFromName: () => "WeatherGate", get: () => ({ fetch: async (_url: string, options: RequestInit) => {
      return Response.json(await refreshForecast(api, env, JSON.parse(String(options.body))));
    } }) } };
    const resolver = async () => ranked;
    const first = await forecastResponse(request(ranked.path), gate, undefined, resolver, cache, async () => RUN);
    expect((await first.json()).days[0].peakLocalTime).toBe("2026-10-05T11:00");
    expect(providerCalls).toBe(1);
    vi.setSystemTime(Date.parse("2026-10-05T16:00:00Z")); // Peak hour is now marked passed.
    const second = await forecastResponse(request(ranked.path), gate, undefined, resolver, cache, async () => RUN);
    expect(second.status).toBe(200);
    const updated = await second.json();
    expect(updated.days[0].peakLocalTime).toBe("2026-10-05T12:00");
    expect(updated.runs[0].initialization).toBe(RUN);
    expect(providerCalls).toBe(2);
  });

  it("keeps today's fifth-day slot honest when every hourly peak has passed", () => {
    const endOfDay = Date.parse("2026-10-06T04:59:00Z"); // 23:59 local in Houston.
    const result = normalizePinnedOpenMeteoForecast(source(), ranked, endOfDay, RUN);
    expect(result.days.map((day) => day.date)).toEqual([
      "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09",
    ]);
    expect(result.days[0]).toMatchObject({ maximumWetBulbC: null, peakLocalTime: null });
    expect(isCurrentForecast(result, endOfDay)).toBe(true);
    expect(isCurrentForecast(result, Date.parse("2026-10-06T05:00:00Z"))).toBe(false);
  });

  it("keeps today and four complete future local dates for east-offset cities near snapshot expiry", () => {
    const late = Date.parse("2026-10-06T20:59:00Z");
    const eastOffset = 4 * 3600;
    expect(() => normalizePinnedOpenMeteoForecast(source(eastOffset, 169), ranked, late, RUN)).toThrow(/full run horizon/);
    const url = buildPinnedOpenMeteoForecastUrl(ranked, RUN);
    expect(url.searchParams.get("forecast_hours")).toBe("193");
    const result = normalizePinnedOpenMeteoForecast(source(eastOffset, 193), ranked, late, RUN);
    expect(result.days.map((day) => day.date)).toEqual([
      "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11",
    ]);
  });

  it("rejects a mismatched gate payload and an expired snapshot without a latest-run fallback", async () => {
    const wrongRun = normalizePinnedOpenMeteoForecast(source(), ranked, NOW, RUN);
    const key = forecastKey(ranked.path, RUN);
    const envelope = { v: 1, key, payload: { ...wrongRun, runs: [{ ...wrongRun.runs[0], initialization: "2026-10-05T06:00:00Z" }] }, fetchedAt: NOW, storedAt: NOW, freshUntil: NOW + 10800000, staleUntil: NOW + 43200000 };
    let calls = 0;
    const gate = { WEATHER_GATE: { idFromName: () => "WeatherGate", get: () => ({ fetch: async () => { calls++; return Response.json(envelope); } }) } };
    const bad = await forecastResponse(request(ranked.path), gate, undefined, async () => ranked, new Cache(), async () => RUN);
    expect(bad.status).toBe(503);
    expect(calls).toBe(1);
    const expired = await forecastResponse(request(ranked.path), gate, undefined, async () => ranked, new Cache(), async () => SNAPSHOT_FORECAST_UNAVAILABLE);
    expect(expired.status).toBe(503);
    expect(calls).toBe(1);
  });
});
