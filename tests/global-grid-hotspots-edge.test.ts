import { describe, expect, it } from "vitest";
import { globalGridHotspotApiResponse, readGlobalGridHotspotSnapshot } from "../workers/global-grid-hotspots-edge";

function snapshot() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-22T00:30:00Z",
    validFrom: "2026-09-22T01:00:00Z",
    validTo: "2026-09-23T01:00:00Z",
    method: {
      name: "Romps thermodynamic liquid-water method",
      version: "1",
      phase: "liquid",
      inputs: ["temperature_2m", "dew_point_2m", "surface_pressure"],
    },
    model: {
      source: "ECMWF IFS Open Data",
      initialization: "2026-09-22T00:00:00Z",
      interval: "three-hourly",
      resolution: "0.25°",
      steps: [0, 3, 6, 9, 12, 15, 18, 21, 24],
    },
    counts: { gridCells: 130_000, evaluatedWarmCells: 1_000, published: 2 },
    hotspots: [
      { rank: 1, latitude: 23.75, longitude: 90.5, maximumWetBulbC: 30.4, peakTime: "2026-09-22T15:00:00Z", airTemperatureC: 34.2, dewPointC: 29.1, surfacePressureHpa: 1002, peakStep: 15 },
      { rank: 2, latitude: 25.25, longitude: 91, maximumWetBulbC: 30.1, peakTime: "2026-09-22T18:00:00Z", airTemperatureC: 33.9, dewPointC: 28.9, surfacePressureHpa: 1003, peakStep: 18 },
    ],
  };
}

class FakeCache {
  value?: Response;
  async match() { return this.value?.clone(); }
  async put(_request: Request, response: Response) { this.value = response.clone(); }
}

function envWith(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    GLOBAL_GRID_HOTSPOT_FEATURE_MODE: "enabled",
    GLOBAL_GRID_HOTSPOT_SNAPSHOT_ASSET_PATH: "/global-grid-hotspots.json",
    ASSETS: {
      async fetch(request: Request) {
        expect(new URL(request.url).pathname).toBe("/global-grid-hotspots.json");
        return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  };
}

describe("global-grid hotspot snapshot edge delivery", () => {
  it("normalizes the offline Python generator document", async () => {
    const raw = {
      schemaVersion: 1,
      method: "romps-thermodynamic-liquid",
      methodVersion: "2026-heatindex-0.0.2",
      model: {
        source: "ecmwf-ifs-0.25",
        initialization: "2026-09-21T12:00:00Z",
        validTimeBounds: { start: "2026-09-22T03:00:00Z", end: "2026-09-23T06:00:00Z" },
        steps: [15, 18, 21, 24, 27, 30, 33, 36, 39, 42],
        grid: { latitudeCount: 721, longitudeCount: 1440 },
        evaluatedCellCount: 783_744,
      },
      cells: [{
        latitude: 27.25, longitude: 50.25, wetBulbC: 30.73, temperatureC: 34.01,
        dewPointC: 29.88, pressurePa: 100_681.5, peakStep: 36, peakTime: "2026-09-23T00:00:00Z",
      }],
    };
    const result = await readGlobalGridHotspotSnapshot(envWith(raw), new FakeCache());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.counts).toEqual({ gridCells: 1_038_240, evaluatedWarmCells: 783_744, published: 1 });
      expect(result.snapshot.validTo).toBe("2026-09-23T09:00:00.000Z");
      expect(result.snapshot.hotspots[0]).toMatchObject({ rank: 1, maximumWetBulbC: 30.73, surfacePressureHpa: 1006.815 });
    }
  });

  it("reads and strictly validates only the configured static asset", async () => {
    const result = await readGlobalGridHotspotSnapshot(envWith(snapshot()), new FakeCache());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.counts.gridCells).toBe(130_000);

    const response = await globalGridHotspotApiResponse(new Request("https://example.test/api/global-grid-hotspots"), envWith(snapshot()), new FakeCache());
    expect(response.status).toBe(200);
    expect((await response.json()).hotspots).toHaveLength(2);
    expect(response.headers.get("etag")).toContain("global-grid-hotspots-1-");
  });

  it("reads the production snapshot from the shared R2 binding", async () => {
    const value = JSON.stringify(snapshot());
    const result = await readGlobalGridHotspotSnapshot({
      GLOBAL_GRID_HOTSPOT_FEATURE_MODE: "enabled",
      HOTSPOT_SNAPSHOTS: {
        async get(key: string) {
          expect(key).toBe("global-grid-hotspots/v1/latest.json");
          return { size: value.length, async text() { return value; } };
        },
      },
    }, new FakeCache());
    expect(result.ok).toBe(true);
  });

  it("fails closed when disabled, unconfigured, malformed, or structurally inconsistent", async () => {
    expect((await readGlobalGridHotspotSnapshot({}, new FakeCache())).ok).toBe(false);
    expect((await readGlobalGridHotspotSnapshot({ GLOBAL_GRID_HOTSPOT_FEATURE_MODE: "enabled" }, new FakeCache())).ok).toBe(false);

    const malformed = snapshot();
    malformed.counts.published = 1;
    const response = await globalGridHotspotApiResponse(new Request("https://example.test/api/global-grid-hotspots"), envWith(malformed), new FakeCache());
    expect(response.status).toBe(503);
  });
});
