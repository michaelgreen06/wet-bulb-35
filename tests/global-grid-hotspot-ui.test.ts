import { describe, expect, it } from "vitest";
import { renderGlobalGridHotspotPage } from "../lib/page-renderer.mjs";
import { createHonoPageRenderer } from "../workers/hono-page-renderer.mjs";

function snapshot() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-22T00:30:00Z",
    validFrom: "2026-09-22T01:00:00Z",
    validTo: "2026-09-23T01:00:00Z",
    method: { name: "Romps thermodynamic liquid-water method", version: "1", phase: "liquid", inputs: ["temperature_2m", "dew_point_2m", "surface_pressure"] },
    model: { source: "ECMWF IFS Open Data", initialization: "2026-09-22T00:00:00Z", interval: "three-hourly", resolution: "0.25°", steps: [0, 3, 6, 9, 12, 15, 18, 21, 24] },
    counts: { gridCells: 130_000, evaluatedWarmCells: 1_000, published: 1 },
    hotspots: [{ rank: 1, latitude: 23.75, longitude: 90.5, maximumWetBulbC: 30.4, peakTime: "2026-09-22T15:00:00Z", airTemperatureC: 34.2, dewPointC: 29.1, surfacePressureHpa: 1002, peakStep: 15 }],
  };
}

function env() {
  const text = JSON.stringify(snapshot());
  return {
    GLOBAL_GRID_HOTSPOT_FEATURE_MODE: "enabled",
    GLOBAL_GRID_HOTSPOT_SNAPSHOT_ASSET_PATH: "/global-grid-hotspots.json",
    CANONICAL_ORIGIN: "https://www.wetbulb35.com",
    GOOGLE_ANALYTICS_ID: "",
    ASSETS: { async fetch() { return new Response(text, { headers: { "content-type": "application/json" } }); } },
  };
}

describe("global-grid hotspot page", () => {
  it("renders grid-only ECMWF rankings and safe Google Maps coordinate links", () => {
    const html = renderGlobalGridHotspotPage(snapshot(), { siteUrl: "https://www.wetbulb35.com", googleAnalyticsId: "" });
    expect(html).toContain("Global ECMWF grid-cell wet bulb forecast hotspots");
    expect(html).toContain("global ECMWF 0.25° three-hourly model grid cells including land and ocean");
    expect(html).toContain("no inhabited-location filter");
    expect(html).toContain('href="https://www.google.com/maps/search/?api=1&amp;query=23.75%2C90.5"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).not.toContain("hourly ECMWF");
    expect(html).not.toMatch(/highest on Earth/i);
    expect(html).toContain('<link rel="canonical" href="https://www.wetbulb35.com/wetbulb-temperature/forecast/global-grid-hotspots/">');
  });

  it("serves the asset-backed canonical page and API with a trailing-slash redirect", async () => {
    const app = createHonoPageRenderer();
    const page = await app.fetch(new Request("https://example.test/wetbulb-temperature/forecast/global-grid-hotspots/"), env());
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("30.4°C");

    const redirect = await app.fetch(new Request("https://example.test/wetbulb-temperature/forecast/global-grid-hotspots"), env());
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("https://example.test/wetbulb-temperature/forecast/global-grid-hotspots/");

    const api = await app.fetch(new Request("https://example.test/api/global-grid-hotspots"), env());
    expect(api.status).toBe(200);

    const hidden = await app.fetch(new Request("https://example.test/wetbulb-temperature/forecast/global-grid-hotspots/"), {});
    expect(hidden.status).toBe(404);
  });
});
