import { describe, expect, it } from "vitest";
import { createHotspotSnapshot } from "../lib/hotspots/snapshot";
import { hotspotApiResponse, readHotspotSnapshot } from "../workers/hotspots-edge";

function snapshot() {
  return createHotspotSnapshot({
    generatedAt: "2026-09-22T00:30:00Z",
    corpusCount: 130_686,
    discovery: {
      source: "ecmwf-ifs-0.25",
      initialization: "2026-09-22T00:00:00Z",
      steps: [0, 3, 6, 9, 12, 15, 18, 21, 24],
      marginC: 2,
      thresholdC: 26,
      dilationRings: 1,
      globalLandMaximumC: 31.2,
    },
    refinements: [{
      candidate: {
        path: "/wetbulb-temperature/bangladesh/dhaka-division/dhaka/",
        name: "Dhaka",
        state: "Dhaka Division",
        country: "Bangladesh",
        latitude: 23.7104,
        longitude: 90.4074,
        selectionReason: "discovery",
        grid: { cellId: "23.7500:90.5000", latitude: 23.75, longitude: 90.5 },
      },
      modelCell: { cellId: "23.7500:90.5000", latitude: 23.75, longitude: 90.5, elevationM: 8 },
      maximumWetBulbC: 30.4,
      peakTime: "2026-09-22T15:00:00Z",
      airTemperatureC: 34.2,
      dewPointC: 29.1,
      surfacePressureHpa: 1002,
      validFrom: "2026-09-22T01:00:00Z",
      validTo: "2026-09-23T01:00:00Z",
    }],
  });
}

class FakeCache {
  value?: Response;
  puts = 0;
  async match() { return this.value?.clone(); }
  async put(_request: Request, response: Response) { this.puts += 1; this.value = response.clone(); }
}

function envWith(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    HOTSPOT_FEATURE_MODE: "enabled",
    HOTSPOT_SNAPSHOTS: {
      async get(key: string) {
        expect(key).toBe("inhabited-hotspots/v1/latest.json");
        return { size: new TextEncoder().encode(text).byteLength, async text() { return text; } };
      },
    },
  };
}

describe("hotspot snapshot edge delivery", () => {
  it("reads, validates, caches, and serves the fixed R2 object", async () => {
    const cache = new FakeCache();
    const first = await readHotspotSnapshot(envWith(snapshot()), cache);
    expect(first.ok).toBe(true);
    expect(cache.puts).toBe(1);
    const second = await readHotspotSnapshot({ HOTSPOT_FEATURE_MODE: "enabled", HOTSPOT_SNAPSHOTS: { async get() { throw new Error("cache should be used"); } } }, cache);
    expect(second.ok).toBe(true);

    const response = await hotspotApiResponse(new Request("https://example.test/api/inhabited-hotspots"), envWith(snapshot()), new FakeCache());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=300");
    expect(["current", "expired"]).toContain(response.headers.get("x-hotspot-snapshot-status"));
    const etag = response.headers.get("etag");
    expect(etag).toContain("hotspots-1-");
    const notModified = await hotspotApiResponse(new Request("https://example.test/api/inhabited-hotspots", { headers: { "if-none-match": etag! } }), envWith(snapshot()), new FakeCache());
    expect(notModified.status).toBe(304);
  });

  it("fails closed for missing, malformed, disabled, and unsupported requests", async () => {
    const missing = await hotspotApiResponse(new Request("https://example.test/api/inhabited-hotspots"), {
      HOTSPOT_FEATURE_MODE: "enabled",
      HOTSPOT_SNAPSHOTS: { async get() { return null; } },
    }, new FakeCache());
    expect(missing.status).toBe(503);

    const malformed = await hotspotApiResponse(new Request("https://example.test/api/inhabited-hotspots"), envWith("{bad"), new FakeCache());
    expect(malformed.status).toBe(503);

    const disabled = await readHotspotSnapshot({}, new FakeCache());
    expect(disabled.ok).toBe(false);

    const post = await hotspotApiResponse(new Request("https://example.test/api/inhabited-hotspots", { method: "POST" }), envWith(snapshot()), new FakeCache());
    expect(post.status).toBe(405);
  });

  it("supports a validated static snapshot asset for isolated staging", async () => {
    const text = JSON.stringify(snapshot());
    const result = await readHotspotSnapshot({
      HOTSPOT_FEATURE_MODE: "enabled",
      HOTSPOT_SNAPSHOT_ASSET_PATH: "/hotspot-snapshot.json",
      ASSETS: { async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/hotspot-snapshot.json");
        return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
      } },
    }, new FakeCache());
    expect(result.ok).toBe(true);
  });
});
