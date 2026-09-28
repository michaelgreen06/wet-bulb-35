import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildCityPopulation, populationKey } from "../scripts/build-city-population.mjs";
import { createSiteData, routePathForCity } from "../lib/page-renderer.mjs";

const line = (id, name, alternates, lat, lon, population) =>
  [id, name, name, alternates, lat, lon, "P", "PPL", "XX", "", "", "", "", "", population, "", "", "Etc/UTC", "2026-01-01"].join("\t");
const geonamesText = [
  line(1, "Kochi", "Cochin,Kochi", 9.93988, 76.26022, 633553),
  line(2, "Cartagena", "", 10.42, -75.53, 914552),
  line(3, "Nowhere", "", 50, 50, 5000),
  line(4, "Pinned", "", 60, 60, 7000),
].join("\n");

test("matches by exact name, alternate name, geonameid, and radius", () => {
  const cities = [
    { name: "Cochin", latitude: 9.93988, longitude: 76.26022 },
    { name: "Cartagena", latitude: 10.39972, longitude: -75.51444 },
    { name: "Nowhere", latitude: 50.1, longitude: 50 },
    { name: "Renamed", latitude: 60, longitude: 60, geonameid: 4 },
  ];
  const { matched, byCoordinate, sourceRows } = buildCityPopulation({ geonamesText, cities });
  assert.equal(sourceRows, 4);
  assert.equal(matched, 3);
  assert.equal(byCoordinate[populationKey(cities[0])], 633553);
  assert.equal(byCoordinate[populationKey(cities[1])], 914552);
  assert.equal(byCoordinate[populationKey(cities[2])], undefined);
  assert.equal(byCoordinate[populationKey(cities[3])], 7000);
});

test("committed sidecar covers the frozen inventory and every Tier-1 city", () => {
  const artifact = JSON.parse(fs.readFileSync("scripts/city-population.v1.json", "utf8"));
  const cities = JSON.parse(fs.readFileSync("scripts/resolved_cities.json", "utf8"));
  const tier1Manifest = JSON.parse(fs.readFileSync("scripts/tier1-city-manifest.json", "utf8"));
  assert.equal(artifact.v, 1);
  assert.match(artifact.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(artifact.inventoryRows, cities.length);
  assert.equal(Object.keys(artifact.byCoordinate).length, artifact.matched);
  assert.ok(artifact.matched / cities.length >= 0.98, `matched ${artifact.matched}`);
  for (const city of createSiteData(cities, tier1Manifest).cities) {
    if (city.tier1) assert.ok(artifact.byCoordinate[populationKey(city)] > 0, routePathForCity(city));
  }
});
