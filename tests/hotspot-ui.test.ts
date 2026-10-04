import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const ACTIVE_NOW = Date.parse("2026-09-22T12:00:00Z");
const EXPIRED_NOW = Date.parse("2026-09-24T00:00:00Z");

describe("global hotspot page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ACTIVE_NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("server-renders ranking values, city links, provenance, and crawlable metadata", () => {
    const html = renderHotspotPage(snapshot(), { siteUrl: "https://www.wetbulb35.com", googleAnalyticsId: "" });
    expect(html).toContain("Top 50 inhabited wet bulb forecast hotspots");
    expect(html).toContain("30.4°C");
    expect(html).toContain("/wetbulb-temperature/bangladesh/dhaka-division/dhaka/");
    expect(html).toContain("130,686");
    expect(html).toContain("ECMWF Open Data (CC BY 4.0) and Open-Meteo");
    expect(html).toContain("ECMWF IFS run initialized");
    // The window is fixed at publication; nothing describes it as a rolling "next 24 hours".
    expect(html).not.toMatch(/during the next 24 hours|next-24-hour forecast/i);
    expect(html).toContain('<link rel="canonical" href="https://www.wetbulb35.com/wetbulb-temperature/forecast/global-hotspots/">');
    expect(html).not.toContain("data-hotspot-api");
  });

  it("adds a browse-page link only while the hotspot feature is enabled", () => {
    const siteData = { countries: [], popularCities: [] };
    expect(renderBrowsePage(siteData, { hotspotEnabled: true })).toContain("/wetbulb-temperature/forecast/global-hotspots/");
    expect(renderBrowsePage(siteData, { hotspotEnabled: false })).not.toContain("/wetbulb-temperature/forecast/global-hotspots/");
  });

  it("labels an upcoming window by its fixed bounds", () => {
    const html = renderHotspotPage(snapshot(), { now: Date.parse("2026-09-22T00:45:00Z") });
    expect(html).toContain('data-hotspot-window-state="upcoming"');
    expect(html).toContain("It begins at Sep 22, 2026, 1:00 AM UTC");
    expect(html).not.toContain("(passed)");
  });

  it("labels a partially elapsed window as the original window and never calls a passed peak upcoming", () => {
    const html = renderHotspotPage(snapshot(), { now: Date.parse("2026-09-22T14:00:00Z") });
    expect(html).toContain('data-hotspot-window-state="active"');
    expect(html).toContain("original fixed forecast window Sep 22, 2026, 1:00 AM UTC – Sep 23, 2026, 1:00 AM UTC");
    expect(html).toContain("not a rolling next-24-hours forecast");
    const asmaraRow = html.slice(html.indexOf(">Asmara<"));
    expect(asmaraRow.slice(0, asmaraRow.indexOf("</tr>"))).toContain("(passed)");
    const dhakaRow = html.slice(html.indexOf(">Dhaka<"));
    expect(dhakaRow.slice(0, dhakaRow.indexOf("</tr>"))).not.toContain("(passed)");
  });

  it("stops presenting an expired ranking and keeps only its original window bounds", () => {
    const html = renderHotspotPage(snapshot(), { now: EXPIRED_NOW, hotspotEnabled: true });
    expect(html).toContain("No current forecast ranking is available");
    expect(html).toContain('data-hotspot-unavailable="expired"');
    expect(html).toContain("Sep 23, 2026, 1:00 AM UTC) has ended");
    expect(html).not.toContain("30.4°C");
    expect(html).not.toContain("/wetbulb-temperature/bangladesh/dhaka-division/dhaka/");
    expect(html).toContain('<link rel="canonical" href="https://www.wetbulb35.com/wetbulb-temperature/forecast/global-hotspots/">');
  });

  it("links to the unfiltered grid page only while that product is enabled", () => {
    const enabled = renderHotspotPage(snapshot(), { globalGridHotspotEnabled: true });
    expect(enabled).toContain('href="/wetbulb-temperature/forecast/global-grid-hotspots/"');
    expect(enabled).toContain("Unfiltered global grid-cell hotspots");
    expect(enabled).toContain("not a ranking of inhabited locations");
    expect(renderHotspotPage(snapshot(), { globalGridHotspotEnabled: false })).not.toContain("/wetbulb-temperature/forecast/global-grid-hotspots/");
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

  it("keeps the URL with an unavailable state for expired and unpublished snapshots", async () => {
    const app = createHonoPageRenderer({ cache: () => new FakeCache() });
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((message) => { warnings.push(String(message)); });
    vi.setSystemTime(EXPIRED_NOW);
    const expired = await app.fetch(new Request("https://example.test/wetbulb-temperature/forecast/global-hotspots/"), env());
    expect(expired.status).toBe(503);
    expect(expired.headers.get("retry-after")).toBe("900");
    expect(expired.headers.get("cache-control")).toBe("no-store");
    const expiredHtml = await expired.text();
    expect(expiredHtml).toContain("No current forecast ranking is available");
    expect(expiredHtml).not.toContain("30.4°C");
    expect(expiredHtml).toContain('aria-current="page"');
    const expiredApi = await app.fetch(new Request("https://example.test/api/inhabited-hotspots"), env());
    expect(expiredApi.status).toBe(503);
    expect(await expiredApi.json()).toMatchObject({ status: "expired", validTo: "2026-09-23T01:00:00Z" });
    expect(warnings.some((line) => line.includes("hotspot_snapshot_expired"))).toBe(true);
    warn.mockRestore();

    const unpublished = await app.fetch(new Request("https://example.test/wetbulb-temperature/forecast/global-hotspots/"), {
      ...env(),
      HOTSPOT_SNAPSHOTS: { async get() { return null; } },
    });
    expect(unpublished.status).toBe(503);
    expect(await unpublished.text()).toContain('data-hotspot-unavailable="unpublished"');
  });
});
