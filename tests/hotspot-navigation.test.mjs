import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderGlobalGridHotspotPage, renderHotspotUnavailablePage } from "../lib/page-renderer.mjs";
import { createHonoPageRenderer } from "../workers/hono-page-renderer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureAssets = path.join(root, "tests/fixtures/hono-binding-assets");
const NAV_LINK = '<a href="/wetbulb-temperature/forecast/global-hotspots/"';
const PAGES = [
  ["home", "/"],
  ["directory", "/wetbulb-temperature/"],
  ["country", "/wetbulb-temperature/andorra/"],
  ["state", "/wetbulb-temperature/andorra/encamp/"],
  ["city", "/wetbulb-temperature/andorra/encamp/vila/"],
];

function assets() {
  return {
    async fetch(request) {
      const diskPath = path.join(fixtureAssets, new URL(request.url).pathname);
      if (!diskPath.startsWith(fixtureAssets) || !fs.existsSync(diskPath)) return new Response("missing", { status: 404 });
      return new Response(fs.readFileSync(diskPath), { status: 200 });
    },
  };
}

function cache() {
  const entries = new Map();
  return {
    async match(request) { return entries.get(request.url)?.clone(); },
    async put(request, response) { entries.set(request.url, response.clone()); },
  };
}

async function render(pathname, env, userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)") {
  const app = createHonoPageRenderer({ cache, cacheVersion: () => `nav-${env.HOTSPOT_FEATURE_MODE ?? "off"}` });
  const response = await app.fetch(new Request(`https://www.wetbulb35.com${pathname}`, { headers: { "user-agent": userAgent } }), env);
  return { response, body: await response.text() };
}

function withoutProviderCalls(callback) {
  return async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => { throw new Error(`Unexpected provider request: ${input}`); };
    try { await callback(); } finally { globalThis.fetch = original; }
  };
}

test("every rendered page carries a crawler-visible Top 50 link while the inhabited product is enabled", withoutProviderCalls(async () => {
  const env = { ASSETS: assets(), HOTSPOT_FEATURE_MODE: "enabled", OPEN_METEO_API_MODE: "public-noncommercial", OBSERVABILITY_DISABLED: "true" };
  for (const [label, pathname] of PAGES) {
    for (const userAgent of ["Googlebot/2.1 (+http://www.google.com/bot.html)", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"]) {
      const { response, body } = await render(pathname, env, userAgent);
      assert.equal(response.status, 200, `${label} ${userAgent}`);
      assert.ok(body.includes('<nav aria-label="Forecast hotspots"'), `${label} lacks the hotspot navigation landmark`);
      assert.ok(body.includes(`${NAV_LINK} class=`), `${label} lacks the link`);
      assert.ok(body.includes(">Top 50 inhabited hotspots</a>"), `${label} lacks the accessible link name`);
      assert.ok(body.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'), `${label} lacks the mobile viewport`);
      const canonical = pathname === "/" ? "https://www.wetbulb35.com/" : `https://www.wetbulb35.com${pathname}`;
      assert.ok(body.includes(`<link rel="canonical" href="${canonical}">`), `${label} canonical changed`);
    }
  }
}));

test("navigation is omitted while the inhabited product gate is off, so it never points to a 404", withoutProviderCalls(async () => {
  const env = { ASSETS: assets(), OPEN_METEO_API_MODE: "public-noncommercial", OBSERVABILITY_DISABLED: "true" };
  for (const [label, pathname] of PAGES) {
    const { response, body } = await render(pathname, env);
    assert.equal(response.status, 200, label);
    assert.ok(!body.includes("/wetbulb-temperature/forecast/global-hotspots/"), `${label} links to a disabled product`);
  }
  const { response } = await render("/wetbulb-temperature/forecast/global-hotspots/", env);
  assert.equal(response.status, 404);
}));

test("an enabled but unpublished product keeps navigation pointed at an accessible unavailable page", withoutProviderCalls(async () => {
  const env = {
    ASSETS: assets(),
    HOTSPOT_FEATURE_MODE: "enabled",
    HOTSPOT_SNAPSHOT_ASSET_PATH: "/missing-hotspots.json",
    GLOBAL_GRID_HOTSPOT_FEATURE_MODE: "enabled",
    GLOBAL_GRID_HOTSPOT_SNAPSHOT_ASSET_PATH: "/missing-global-grid.json",
    OBSERVABILITY_DISABLED: "true",
  };
  const inhabited = await render("/wetbulb-temperature/forecast/global-hotspots/", env);
  assert.equal(inhabited.response.status, 503);
  assert.match(inhabited.body, /data-hotspot-unavailable="unpublished"/);
  assert.match(inhabited.body, /aria-current="page" class=/);
  assert.match(inhabited.body, /href="\/wetbulb-temperature\/forecast\/global-grid-hotspots\/">Unfiltered global grid-cell hotspots/);

  const grid = await render("/wetbulb-temperature/forecast/global-grid-hotspots/", env);
  assert.equal(grid.response.status, 503);
  assert.ok(grid.body.includes(NAV_LINK));
  assert.match(grid.body, /Top 50 inhabited hotspots: the separate hourly ranking/);
}));

test("hotspot pages respect each product's independent gate", () => {
  const snapshot = {
    validFrom: "2099-01-01T00:00:00Z",
    validTo: "2099-01-02T00:00:00Z",
    method: { name: "Romps", version: "1" },
    model: { source: "ECMWF", initialization: "2098-12-31T18:00:00Z", interval: "hourly-interpolated", resolution: "0.25°" },
    counts: { gridCells: 10, evaluatedWarmCells: 5, published: 1 },
    hotspots: [{ rank: 1, latitude: 1, longitude: 2, maximumWetBulbC: 30, peakTime: "2099-01-01T06:00:00Z", airTemperatureC: 33, dewPointC: 28 }],
  };
  const gridOnly = renderGlobalGridHotspotPage(snapshot, { hotspotEnabled: false, globalGridHotspotEnabled: true });
  assert.ok(!gridOnly.includes("/wetbulb-temperature/forecast/global-hotspots/"));
  assert.ok(!renderHotspotUnavailablePage("inhabited", {}, { hotspotEnabled: true, globalGridHotspotEnabled: false }).includes("global-grid-hotspots"));
});
