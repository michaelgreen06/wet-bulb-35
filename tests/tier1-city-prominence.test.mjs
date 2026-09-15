import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createSiteData, pageHtml, renderBrowsePage, renderCountryPage, renderStatePage, routePathForCity, tier1ByCanonicalPath } from "../lib/page-renderer.mjs";
import { createHonoPageRenderer } from "../workers/hono-page-renderer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventory = JSON.parse(fs.readFileSync(path.join(root, "scripts/resolved_cities.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "scripts/tier1-city-manifest.json"), "utf8"));
const site = createSiteData(inventory, manifest);

function hrefsInPopularSection(html) {
  const section = html.match(/<section aria-labelledby="popular-wet-bulb-temperatures"[^>]*>([\s\S]*?)<\/section>/)?.[1] || "";
  return [...section.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
}

test("Tier-1 production manifest is sanitized, complete, and canonical", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cities.length, 200);
  assert.deepEqual(Object.fromEntries(["1A", "1B", "1C"].map((tier) => [tier, manifest.cities.filter((city) => city.tier === tier).length])), { "1A": 50, "1B": 50, "1C": 100 });
  assert.equal(manifest.cities.filter((city) => city.popular).length, 40);
  assert.equal(new Set(manifest.cities.map((city) => city.path)).size, 200);
  for (const city of manifest.cities) assert.deepEqual(Object.keys(city).sort(), ["path", "popular", "rank", "tier"]);
  assert.equal(site.cities.filter((city) => city.tier1).length, 200);
  assert.equal(site.cityRoutes.size, 130686);
});

test("Tier-1 manifest validation fails closed", () => {
  const wrongCount = structuredClone(manifest);
  wrongCount.cities.pop();
  assert.throws(() => tier1ByCanonicalPath(wrongCount), /exactly 200/);

  const duplicateRank = structuredClone(manifest);
  duplicateRank.cities[1].rank = duplicateRank.cities[0].rank;
  assert.throws(() => tier1ByCanonicalPath(duplicateRank), /Duplicate Tier-1 rank/);

  const wrongPopularCount = structuredClone(manifest);
  wrongPopularCount.cities.find((city) => city.popular).popular = false;
  assert.throws(() => tier1ByCanonicalPath(wrongPopularCount), /exactly 40 Popular Cities/);

  const malformedPath = structuredClone(manifest);
  malformedPath.cities[0].path = "/wetbulb-temperature/India/Tamil-Nadu/Chennai/";
  assert.throws(() => tier1ByCanonicalPath(malformedPath), /Invalid Tier-1 canonical path/);
});

test("Singapore and Hong Kong inventory records render their reviewed canonical routes", () => {
  for (const expected of [
    ["Singapore", 1880252, "/wetbulb-temperature/singapore/singapore/singapore/"],
    ["Hong Kong", 1819729, "/wetbulb-temperature/hong-kong/hong-kong/hong-kong/"],
  ]) {
    const [name, geonameid, route] = expected;
    const city = inventory.find((record) => record.geonameid === geonameid);
    assert.equal(city?.name, name);
    assert.equal(routePathForCity(city), route);
    assert.match(pageHtml(city), new RegExp(`<link rel="canonical" href="https://www\\.wetbulb35\\.com${route}">`));
  }
});

test("the browse root has exactly the 40 curated canonical Popular links", () => {
  const html = renderBrowsePage(site);
  assert.match(html, /<h2[^>]*>Popular Wet Bulb Temperatures<\/h2>/);
  const actual = hrefsInPopularSection(html);
  const expected = site.cities.filter((city) => city.tier1?.popular).sort((a, b) => a.name.localeCompare(b.name) || routePathForCity(a).localeCompare(routePathForCity(b))).map(routePathForCity);
  assert.equal(actual.length, 40);
  assert.equal(new Set(actual).size, 40);
  assert.deepEqual(actual, expected);
  assert.doesNotMatch(html, />Singapore, Singapore, Singapore</);
  assert.doesNotMatch(html, />Hong Kong, Hong Kong, Hong Kong</);
});

test("directory pages pin Tier-1 cities and their states without labels or duplicate links", () => {
  const texas = site.states.find((state) => state.countrySlug === "united-states" && state.stateSlug === "texas");
  const texasHtml = renderStatePage(texas);
  const cityLinks = [...texasHtml.matchAll(/href="(\/wetbulb-temperature\/united-states\/texas\/[^"/]+\/)"/g)].map((match) => match[1]);
  const featuredTexas = texas.cities.filter((city) => city.tier1).map(routePathForCity);
  assert.ok(featuredTexas.length > 0);
  assert.deepEqual(cityLinks.slice(0, featuredTexas.length), featuredTexas);
  assert.equal(new Set(cityLinks).size, cityLinks.length);

  const unitedStates = site.countries.find((country) => country.slug === "united-states");
  const countryHtml = renderCountryPage(unitedStates);
  const stateLinks = [...countryHtml.matchAll(/href="(\/wetbulb-temperature\/united-states\/[^"/]+\/)"/g)].map((match) => match[1]);
  const featuredStates = [...unitedStates.states].filter((state) => state.tier1Count).sort((a, b) => b.tier1Count - a.tier1Count || a.name.localeCompare(b.name)).map((state) => `/wetbulb-temperature/united-states/${state.slug}/`);
  assert.deepEqual(stateLinks.slice(0, featuredStates.length), featuredStates);
  assert.equal(new Set(stateLinks).size, stateLinks.length);
});

test("production Worker assets render the same Popular links and new city routes", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "wetbulb35-tier1-assets-"));
  try {
    const testPlacesKey = "test-browser-restricted-places-key";
    execFileSync(process.execPath, [
      path.join(root, "scripts/build-hono-renderer-assets.mjs"),
      `--source=${path.join(root, "scripts/resolved_cities.json")}`,
      `--out=${outDir}`,
    ], { cwd: root, env: { ...process.env, NEXT_PUBLIC_GOOGLE_PLACES_API_KEY: testPlacesKey }, stdio: "pipe" });
    const browserRuntime = fs.readFileSync(path.join(outDir, "assets/app.js"), "utf8");
    assert.match(browserRuntime, /maps\.googleapis\.com\/maps\/api\/js/);
    assert.match(browserRuntime, new RegExp(encodeURIComponent(testPlacesKey)));
    const assets = {
      async fetch(request) {
        const filePath = path.join(outDir, new URL(request.url).pathname);
        if (!filePath.startsWith(outDir) || !fs.existsSync(filePath)) return new Response("missing", { status: 404 });
        return new Response(fs.readFileSync(filePath));
      },
    };
    const app = createHonoPageRenderer();
    const browseResponse = await app.fetch(new Request("https://renderer.test/wetbulb-temperature/"), { ASSETS: assets });
    assert.equal(browseResponse.status, 200);
    const browseHtml = await browseResponse.text();
    assert.deepEqual(hrefsInPopularSection(browseHtml), hrefsInPopularSection(renderBrowsePage(site)));
    for (const route of [
      "/wetbulb-temperature/singapore/singapore/singapore/",
      "/wetbulb-temperature/hong-kong/hong-kong/hong-kong/",
    ]) {
      const response = await app.fetch(new Request(`https://renderer.test${route}`), { ASSETS: assets });
      assert.equal(response.status, 200, route);
      assert.match(await response.text(), new RegExp(`<link rel="canonical" href="https://www\\.wetbulb35\\.com${route}">`));
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
