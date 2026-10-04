import { describe, expect, it } from "vitest";
import {
  HOTSPOT_PINNED_FORECAST_HOURS,
  buildPinnedDailyForecastUrl,
  normalizePinnedDailyForecastResponse,
  type HotspotCandidate,
} from "../lib/hotspots/open-meteo.ts";
import { attachPinnedFiveDay, createHotspotSnapshot, validateHotspotSnapshot } from "../lib/hotspots/snapshot.ts";
import {
  addPinnedFiveDay,
  applyDownloadTiming,
  generateHotspotSnapshot,
} from "../scripts/generate-inhabited-hotspot-snapshot.ts";

const RUN = "2026-10-04T06:00:00Z";
const bangkok: HotspotCandidate = {
  path: "/wetbulb-temperature/thailand/bangkok/bangkok/",
  name: "Bangkok",
  state: "Bangkok",
  country: "Thailand",
  latitude: 13.75,
  longitude: 100.5,
  selectionReason: "discovery",
  grid: { cellId: "13.7500:100.5000", latitude: 13.75, longitude: 100.5 },
};

/** Mirrors the observed Single Runs response: local times from the run start, nulls after +144 h. */
function singleRun(offsetSeconds: number, timezone: string, coveredHours = HOTSPOT_PINNED_FORECAST_HOURS) {
  const startMs = Date.parse(RUN);
  const time = Array.from({ length: HOTSPOT_PINNED_FORECAST_HOURS }, (_, hour) => new Date(startMs + hour * 3_600_000 + offsetSeconds * 1_000).toISOString().slice(0, 16));
  const value = (hour: number, fill: number) => (hour < coveredHours ? fill : null);
  return {
    latitude: 13.75, longitude: 100.5, elevation: 9, timezone, utc_offset_seconds: offsetSeconds,
    hourly_units: { time: "iso8601", temperature_2m: "°C", dew_point_2m: "°C", surface_pressure: "hPa" },
    hourly: {
      time,
      temperature_2m: time.map((stamp, hour) => value(hour, stamp.endsWith("T14:00") ? 35 : 29)),
      dew_point_2m: time.map((stamp, hour) => value(hour, stamp.endsWith("T14:00") ? 27 : 24)),
      surface_pressure: time.map((_, hour) => value(hour, 1006)),
    },
  };
}

function snapshot() {
  return createHotspotSnapshot({
    generatedAt: "2026-10-04T13:40:00Z",
    corpusCount: 10,
    discovery: { source: "ecmwf-ifs-0.25", initialization: RUN, steps: [6, 9], marginC: 1.5, thresholdC: 27, dilationRings: 1, globalLandMaximumC: 31, retrievedAt: "2026-10-04T13:30:00Z", firstSeenReadyAt: "2026-10-04T13:25:00Z" },
    refinements: [{
      candidate: bangkok,
      modelCell: { cellId: "13.7500:100.5000", latitude: 13.75, longitude: 100.5, elevationM: 9 },
      maximumWetBulbC: 29.4, peakTime: "2026-10-05T07:00:00Z", airTemperatureC: 35, dewPointC: 27, surfacePressureHpa: 1006,
      validFrom: "2026-10-04T14:00:00Z", validTo: "2026-10-05T14:00:00Z",
    }],
  });
}

describe("pinned Top-50 five-day data", () => {
  it("requests the same pinned run in local time for published locations only", () => {
    const url = buildPinnedDailyForecastUrl([bangkok], { modelInitialization: RUN });
    expect(url.origin + url.pathname).toBe("https://single-runs-api.open-meteo.com/v1/forecast");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      run: "2026-10-04T06:00", forecast_hours: "145", timezone: "auto", models: "ecmwf_ifs025",
      hourly: "temperature_2m,dew_point_2m,surface_pressure",
    });
    expect(() => buildPinnedDailyForecastUrl([bangkok], { modelInitialization: RUN, baseUrl: "https://api.open-meteo.com/v1/forecast" })).toThrow(/Single Runs/);
  });

  it("keeps only complete local dates inside the pinned run's coverage", () => {
    const [daily] = normalizePinnedDailyForecastResponse(singleRun(25_200, "Asia/Bangkok"), [bangkok], RUN, "2026-10-04T13:45:00Z");
    // 06Z = 13:00 local on Oct 4 (partial); +144 h = 13:00 local on Oct 10 (partial).
    expect(daily.days.map((day) => day.date)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(daily.days[0].peakLocalTime).toBe("2026-10-05T14:00");
    expect(daily).toMatchObject({ initialization: RUN, timezone: "Asia/Bangkok", utcOffsetSeconds: 25_200 });
  });

  it("drops late dates when trailing steps are missing", () => {
    const [daily] = normalizePinnedDailyForecastResponse(singleRun(25_200, "Asia/Bangkok", 90), [bangkok], RUN, "2026-10-04T13:45:00Z");
    expect(daily.days.map((day) => day.date)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
  });

  it("rejects responses that do not start at the pinned initialization", () => {
    const shifted = singleRun(25_200, "Asia/Bangkok");
    shifted.hourly.time = shifted.hourly.time.map((stamp) => new Date(Date.parse(`${stamp}:00Z`) + 3_600_000).toISOString().slice(0, 16));
    expect(() => normalizePinnedDailyForecastResponse(shifted, [bangkok], RUN, "2026-10-04T13:45:00Z")).toThrow(/pinned initialization/);
  });

  it("schema-validates pinned days against the snapshot's own initialization", () => {
    const [daily] = normalizePinnedDailyForecastResponse(singleRun(25_200, "Asia/Bangkok"), [bangkok], RUN, "2026-10-04T13:45:00Z");
    const published = attachPinnedFiveDay(snapshot(), [daily]);
    expect(published.hotspots[0].fiveDay?.days).toHaveLength(5);
    expect(published.discovery).toMatchObject({ retrievedAt: "2026-10-04T13:30:00Z", firstSeenReadyAt: "2026-10-04T13:25:00Z" });

    const otherRun = { ...published, hotspots: [{ ...published.hotspots[0], fiveDay: { ...published.hotspots[0].fiveDay!, initialization: "2026-10-04T00:00:00Z" } }] };
    expect(validateHotspotSnapshot(otherRun).success).toBe(false);
    const gap = { ...published, hotspots: [{ ...published.hotspots[0], fiveDay: { ...published.hotspots[0].fiveDay!, days: [daily.days[0], daily.days[2]] } }] };
    expect(validateHotspotSnapshot(gap).success).toBe(false);
    // A local date beginning before the run initialization cannot be complete.
    const early = { ...published, hotspots: [{ ...published.hotspots[0], fiveDay: { ...published.hotspots[0].fiveDay!, days: [{ date: "2026-10-04", maximumWetBulbC: 28, peakLocalTime: "2026-10-04T14:00" }, ...daily.days] } }] };
    expect(validateHotspotSnapshot(early).success).toBe(false);
  });

  it("is warning-only: a provider failure publishes the ranking without pinned days", async () => {
    const warnings: string[] = [];
    const result = await addPinnedFiveDay({
      snapshot: snapshot(),
      fetchImplementation: async () => new Response("busy", { status: 500 }),
      options: {},
      attempts: 2,
      retryDelayMs: 1,
      warn: (message) => warnings.push(message),
    });
    expect(result.hotspots[0].fiveDay).toBeUndefined();
    expect(validateHotspotSnapshot(result).success).toBe(true);
    expect(warnings[0]).toMatch(/Pinned five-day refinement skipped/);
  });

  it("records retrieval and first-ready times only for the matching initialization", () => {
    const discovery = snapshot().discovery;
    expect(applyDownloadTiming(discovery, { initialization: RUN, retrievedAt: "2026-10-04T13:30:00Z", firstSeenReadyAt: null })).toMatchObject({ firstSeenReadyAt: null });
    expect(() => applyDownloadTiming(discovery, { initialization: "2026-10-04T00:00:00Z", retrievedAt: "2026-10-04T13:30:00Z" })).toThrow(/does not match/);
  });

  it("adds pinned days in the full generation path with one extra request for published locations", async () => {
    const requests: URL[] = [];
    const candidateDocument = {
      schemaVersion: 1,
      model: { source: "ecmwf-ifs-0.25", initialization: RUN, steps: Array.from({ length: 24 }, (_, index) => index + 8) },
      selection: { marginC: 1.5, thresholdC: 27, dilationRings: 1 },
      globalLandMaximum: { wetBulbC: 31 },
      cities: [{ ...bangkok, gridCell: { latitude: 13.75, longitude: 100.5 }, selectionReason: undefined, grid: undefined }].map(({ selectionReason: _s, grid: _g, ...city }) => city),
    };
    const fetchImplementation = async (input: string | URL) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.searchParams.get("timezone") === "auto") return Response.json(singleRun(25_200, "Asia/Bangkok"));
      const hours = Number(url.searchParams.get("forecast_hours"));
      const time = Array.from({ length: hours }, (_, hour) => new Date(Date.parse(RUN) + hour * 3_600_000).toISOString().slice(0, 16));
      return Response.json({
        latitude: 13.75, longitude: 100.5, elevation: 9, timezone: "GMT", utc_offset_seconds: 0,
        hourly_units: { time: "iso8601", temperature_2m: "°C", dew_point_2m: "°C", surface_pressure: "hPa" },
        hourly: { time, temperature_2m: time.map(() => 33), dew_point_2m: time.map(() => 26), surface_pressure: time.map(() => 1006) },
      });
    };
    const result = await generateHotspotSnapshot({
      candidateDocument,
      cityManifest: [{ path: bangkok.path, name: bangkok.name, state: bangkok.state, country: bangkok.country, latitude: bangkok.latitude, longitude: bangkok.longitude }],
      batchSize: 100,
      dailyLocationLimit: 10,
      excludedControlSampleSize: 0,
      interBatchDelayMs: 0,
      fetchImplementation,
      options: {},
      generatedAt: "2026-10-04T13:40:00Z",
      downloadMetadata: { initialization: RUN, retrievedAt: "2026-10-04T13:30:00Z", firstSeenReadyAt: "2026-10-04T13:25:00Z" },
      pinnedFiveDay: true,
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((url) => url.searchParams.get("run") === "2026-10-04T06:00")).toBe(true);
    expect(result.hotspots[0].fiveDay?.initialization).toBe(RUN);
    expect(result.discovery.firstSeenReadyAt).toBe("2026-10-04T13:25:00Z");
  });
});
