import { describe, expect, it } from "vitest";
import {
  generateHotspotSnapshot,
  parseCandidateDocument,
  selectExcludedControls,
} from "../scripts/generate-inhabited-hotspot-snapshot";

const candidateDocument = {
  schemaVersion: 1,
  method: "romps-liquid",
  methodVersion: "2026-heatindex-0.0.2",
  discoveryBoundary: "candidate-only",
  model: { source: "ecmwf-ifs-0.25", initialization: "2026-09-22T00:00:00Z", steps: [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33], grid: { latitudeCount: 721, longitudeCount: 1440 } },
  selection: { marginC: 2, thresholdC: 26, dilationRings: 1 },
  globalLandMaximum: { wetBulbC: 32.4 },
  cities: [{
    path: "/wetbulb-temperature/pakistan/sindh/jacobabad/",
    name: "Jacobabad",
    state: "Sindh",
    country: "Pakistan",
    latitude: 28.281,
    longitude: 68.437,
    gridCell: { latitude: 28.25, longitude: 68.5 },
  }],
};
const cityManifest = [
  { path: "/wetbulb-temperature/pakistan/sindh/jacobabad/", name: "Jacobabad", state: "Sindh", country: "Pakistan", latitude: 28.281, longitude: 68.437 },
  { path: "/wetbulb-temperature/india/west-bengal/kolkata/", name: "Kolkata", state: "West Bengal", country: "India", latitude: 22.5726, longitude: 88.3639 },
  { path: "/wetbulb-temperature/bangladesh/dhaka-division/dhaka/", name: "Dhaka", state: "Dhaka Division", country: "Bangladesh", latitude: 23.7104, longitude: 90.4074 },
];

function responseFor(url: string | URL): Response {
  const request = new URL(String(url));
  const latitudes = request.searchParams.get("latitude")!.split(",").map(Number);
  const longitudes = request.searchParams.get("longitude")!.split(",").map(Number);
  const start = request.searchParams.get("run") ?? request.searchParams.get("start_hour") ?? "2026-09-22T00:00";
  const startMs = Date.parse(`${start}:00Z`);
  const hours = Number(request.searchParams.get("forecast_hours") ?? 24);
  const payloads = latitudes.map((latitude, locationIndex) => {
    const time = Array.from({ length: hours }, (_, hour) => new Date(startMs + hour * 3_600_000).toISOString().slice(0, 16));
    return {
      latitude,
      longitude: longitudes[locationIndex],
      elevation: 10 + locationIndex,
      timezone: "GMT",
      utc_offset_seconds: 0,
      hourly_units: { time: "iso8601", temperature_2m: "°C", dew_point_2m: "°C", surface_pressure: "hPa" },
      hourly: {
        time,
        temperature_2m: time.map((_, hour) => (hour === 15 ? 38 - locationIndex : 30)),
        dew_point_2m: time.map((_, hour) => (hour === 15 ? 28 - locationIndex : 24)),
        surface_pressure: time.map(() => 1000),
      },
    };
  });
  return new Response(JSON.stringify(payloads), { status: 200 });
}

describe("hotspot generation pipeline", () => {
  it("parses discovery output and selects a stable excluded-location control sample", () => {
    const parsed = parseCandidateDocument(candidateDocument);
    const first = selectExcludedControls(cityManifest, parsed.candidates, parsed.discovery.initialization, 1);
    const second = selectExcludedControls(cityManifest, parsed.candidates, parsed.discovery.initialization, 1);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0].selectionReason).toBe("excluded-control");
    expect(first[0].grid).toBeNull();
    expect(first[0].path).not.toBe(parsed.candidates[0].path);
  });

  it("refines all discovered and control cities and emits one complete immutable snapshot", async () => {
    const snapshot = await generateHotspotSnapshot({
      candidateDocument,
      cityManifest,
      batchSize: 50,
      dailyLocationLimit: 10,
      excludedControlSampleSize: 1,
      fetchImplementation: async (url) => responseFor(url),
      options: {},
      generatedAt: "2026-09-22T00:30:00Z",
    });
    expect(snapshot.counts).toMatchObject({ corpus: 3, discoveredCandidates: 1, excludedControls: 1, candidates: 2, refined: 2 });
    expect(snapshot.hotspots).toHaveLength(2);
    expect(snapshot.validation.excludedControlSample).toBe(1);
  });

  it("fails rather than silently truncating when the candidate budget is exceeded", async () => {
    await expect(generateHotspotSnapshot({
      candidateDocument,
      cityManifest,
      batchSize: 50,
      dailyLocationLimit: 1,
      excludedControlSampleSize: 1,
      fetchImplementation: async (url) => responseFor(url),
      options: {},
    })).rejects.toThrow(/exceeds/);
  });

  it("rejects discovery data that does not cover the fixed refinement window", async () => {
    const staleDiscovery = structuredClone(candidateDocument);
    staleDiscovery.model.steps = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27];
    await expect(generateHotspotSnapshot({
      candidateDocument: staleDiscovery,
      cityManifest,
      batchSize: 50,
      dailyLocationLimit: 10,
      excludedControlSampleSize: 0,
      fetchImplementation: async (url) => responseFor(url),
      options: {},
      generatedAt: "2026-09-22T00:30:00Z",
    })).rejects.toThrow(/does not cover/);
  });
});
