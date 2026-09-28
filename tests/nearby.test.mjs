import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { compactNearby, computeNearby, expandNearby, NEARBY_LIMIT } from "../lib/nearby.mjs";
import { createSiteData, pageHtml, prepareCities, routePathForCity } from "../lib/page-renderer.mjs";

const fixture = JSON.parse(fs.readFileSync("tests/fixtures/hono-binding-cities.json", "utf8"));

test("nearby links exclude self, cross state and country labels, and round trip through shard form", () => {
  const { cities } = prepareCities([
    ...fixture,
    { name: "Yerevan", resolvedCountryName: "Armenia", resolvedAdmin1Code: "Yerevan", latitude: 40.18111, longitude: 44.51361 },
    { name: "Tbilisi", resolvedCountryName: "Georgia", resolvedAdmin1Code: "Tbilisi", latitude: 41.69411, longitude: 44.83368 },
  ]);
  const nearby = computeNearby(cities);
  const metsamor = cities.find((city) => city.outputCitySlug === "metsamor-40-0723-44-2917");
  const entries = nearby.get(routePathForCity(metsamor));
  assert.deepEqual(entries.map((entry) => entry.label), ["Metsamor", "Yerevan, Yerevan", "Tbilisi, Tbilisi, Georgia"]);
  assert.ok(entries.every((entry) => entry.path !== routePathForCity(metsamor)));
  assert.ok(entries.every((entry, index) => index === 0 || entry.km >= entries[index - 1].km));
  assert.deepEqual(expandNearby("armenia", "armavir", compactNearby(metsamor, entries)), entries);
  assert.deepEqual(nearby.get(routePathForCity(cities[0])), []);
});

test("hub within radius is appended after the nearest cities", () => {
  const { cities } = prepareCities(Array.from({ length: 12 }, (_, index) => ({
    name: `Town ${index}`, resolvedCountryName: "X", resolvedAdmin1Code: "Y", latitude: 10 + index * 0.05, longitude: 10,
  })));
  const hub = routePathForCity(cities[11]);
  const entries = computeNearby(cities, new Set([hub])).get(routePathForCity(cities[0]));
  assert.equal(entries.length, NEARBY_LIMIT + 1);
  assert.equal(entries.at(-1).path, hub);
});

test("city page renders nearby links only when present", () => {
  const siteData = createSiteData(fixture);
  const metsamor = siteData.cities.find((city) => city.outputCitySlug === "metsamor-40-0723-44-2917");
  assert.match(pageHtml(metsamor), /<h2 id="nearby-heading"[^>]*>Nearby locations<\/h2>[\s\S]*href="\/wetbulb-temperature\/armenia\/armavir\/metsamor-40-1445-44-1167\/"/);
  assert.doesNotMatch(pageHtml(siteData.cities.find((city) => city.outputCitySlug === "vila")), /nearby-heading/);
});

test("every nearby link in the full inventory resolves to a generated city route", { timeout: 120_000 }, () => {
  const siteData = createSiteData(JSON.parse(fs.readFileSync("scripts/resolved_cities.json", "utf8")));
  let empty = 0;
  for (const city of siteData.cities) {
    const self = routePathForCity(city);
    if (!city.nearby.length) empty += 1;
    assert.ok(city.nearby.length <= NEARBY_LIMIT + 1, self);
    for (const entry of city.nearby) {
      assert.ok(siteData.cityRoutes.has(entry.path), `${self} -> ${entry.path}`);
      assert.notEqual(entry.path, self);
    }
  }
  assert.ok(empty < 50, `cities without nearby links: ${empty}`);
});
