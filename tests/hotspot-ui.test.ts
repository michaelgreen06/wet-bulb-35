import { describe, expect, it } from "vitest";
import { createHotspotSnapshot } from "../lib/hotspots/snapshot";
import { renderBrowsePage, renderHotspotPage } from "../lib/page-renderer.mjs";
import { createHonoPageRenderer } from "../workers/hono-page-renderer.mjs";

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
    refinements: [
      {
        candidate: { path: "/wetbulb-temperature/bangladesh/dhaka-division/dhaka/", name: "Dhaka", state: "Dhaka Division", country: "Bangladesh", latitude: 23.7104, longitude: 90.4074, selectionReason: "discovery", grid: { cellId: "23.7500:90.5000", latitude: 23.75, longitude: 90.5 } },
        modelCell: { cellId: "23.7500:90.5000", latitude: 23.75, longitude: 90.5, elevationM: 8 },
        maximumWetBulbC: 30.4, peakTime: "2026-09-22T15:00:00Z", airTemperatureC: 34.2, dewPointC: 29.1, surfacePressureHpa: 1002,
        validFrom: "2026-09-22T01:00:00Z", validTo: "2026-09-23T01:00:00Z",
      },
      {
        candidate: { path: "/wetbulb-temperature/eritrea/maekel/asmara/", name: "Asmara", state: "Maekel", country: "Eritrea", latitude: 15.3381, longitude: 38.9327, selectionReason: "discovery", grid: { cellId: "15.2500:39.0000", latitude: 15.25, longitude: 39 } },
        modelCell: { cellId: "15.2500:39.0000", latitude: 15.25, longitude: 39, elevationM: 2325 },
        maximumWetBulbC: 28.2, peakTime: "2026-09-22T13:00:00Z", airTemperatureC: 31, dewPointC: 25, surfacePressureHpa: 770,
        validFrom: "2026-09-22T01:00:00Z", validTo: "2026-09-23T01:00:00Z",
      },
    ],
  });
}

class FakeCache {
  entries = new Map<string, Response>();
  async match(request: Request) { return this.entries.get(request.url)?.clone(); }
  async put(request: Request, response: Response) { this.entries.set(request.url, response.clone()); }
}

function env() {
  const text = JSON.stringify(snapshot());
  return {
    HOTSPOT_FEATURE_MODE: "enabled",
    HOTSPOT_SNAPSHOTS: { async get() { return { size: text.length, async text() { return text; } }; } },
    CANONICAL_ORIGIN: "https://www.wetbulb35.com",
    GOOGLE_ANALYTICS_ID: "",
  };
}

describe("global hotspot page", () => {
  it("server-renders ranking values, city links, provenance, and crawlable metadata", () => {
    const html = renderHotspotPage(snapshot(), { siteUrl: "https://www.wetbulb35.com", googleAnalyticsId: "" });
    expect(html).toContain("Global inhabited wet bulb forecast hotspots");
    expect(html).toContain("30.4°C");
    expect(html).toContain("/wetbulb-temperature/bangladesh/dhaka-division/dhaka/");
    expect(html).toContain("130,686");
    expect(html).toContain("ECMWF Open Data and Open-Meteo");
    expect(html).toContain('<link rel="canonical" href="https://www.wetbulb35.com/wetbulb-temperature/forecast/global-hotspots/">');
    expect(html).not.toContain("data-hotspot-api");
  });

  it("adds a browse-page link only while the hotspot feature is enabled", () => {
    const siteData = { countries: [], popularCities: [] };
    expect(renderBrowsePage(siteData, { hotspotEnabled: true })).toContain("/wetbulb-temperature/forecast/global-hotspots/");
    expect(renderBrowsePage(siteData, { hotspotEnabled: false })).not.toContain("/wetbulb-temperature/forecast/global-hotspots/");
  });

  it("clearly labels an expired last-known-good snapshot", () => {
    const html = renderHotspotPage(snapshot(), { now: Date.parse("2026-09-24T00:00:00Z") });
    expect(html).toContain("This archived forecast window ended");
    expect(html).toContain("not a current next-24-hour forecast");
  });

  it("serves the canonical HTML and JSON routes without any weather-provider call", async () => {
    const cache = new FakeCache();
    const app = createHonoPageRenderer({ cache: () => cache });
    const page = await app.fetch(new Request("https://example.test/wetbulb-temperature/forecast/global-hotspots/"), env());
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("30.4°C");

    const redirect = await app.fetch(new Request("https://example.test/wetbulb-temperature/forecast/global-hotspots"), env());
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("https://example.test/wetbulb-temperature/forecast/global-hotspots/");

    const api = await app.fetch(new Request("https://example.test/api/inhabited-hotspots"), env());
    expect(api.status).toBe(200);
    expect((await api.json()).hotspots).toHaveLength(2);

    const hidden = await app.fetch(new Request("https://example.test/wetbulb-temperature/forecast/global-hotspots/"), {});
    expect(hidden.status).toBe(404);
  });
});
