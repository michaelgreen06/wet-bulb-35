import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createSiteData, pageHtml, routePathForCity } from "../lib/page-renderer.mjs";
import { validatePopular40Enrichment } from "../lib/popular-40-enrichment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enrichment = JSON.parse(fs.readFileSync(path.join(root, "data/popular-40-enrichment.v1.json"), "utf8"));
const reviewedMap = JSON.parse(fs.readFileSync(path.join(root, "scripts/popular-40-geonames-map.json"), "utf8"));
const inventory = JSON.parse(fs.readFileSync(path.join(root, "scripts/resolved_cities.json"), "utf8"));
const tier1 = JSON.parse(fs.readFileSync(path.join(root, "scripts/tier1-city-manifest.json"), "utf8"));

const expectedReviewPaths = [
  "/wetbulb-temperature/singapore/singapore/singapore/",
  "/wetbulb-temperature/bangladesh/dhaka-division/dhaka/",
  "/wetbulb-temperature/united-arab-emirates/dubai/dubai/",
  "/wetbulb-temperature/united-states/arizona/phoenix/",
  "/wetbulb-temperature/hong-kong/hong-kong/hong-kong/",
  "/wetbulb-temperature/mexico/mexico-city/mexico-city/",
  "/wetbulb-temperature/japan/tokyo/tokyo/",
  "/wetbulb-temperature/united-states/texas/houston/",
  "/wetbulb-temperature/nigeria/lagos/lagos/",
  "/wetbulb-temperature/india/delhi/new-delhi/",
];

test("Popular-40 enrichment is complete, sanitized, and strictly valid", () => {
  const index = validatePopular40Enrichment(enrichment);
  const site = createSiteData(inventory, tier1);
  const citiesByPath = new Map(site.cities.map((city) => [routePathForCity(city), city]));
  assert.equal(index.size, 40);
  assert.equal(enrichment.cities.length, 40);
  assert.equal(new Set(enrichment.cities.map((city) => city.path)).size, 40);
  assert.equal(new Set(enrichment.cities.map((city) => city.geonames.id)).size, 40);
  for (const reviewed of reviewedMap.cities) {
    const sourceCity = citiesByPath.get(reviewed.path);
    assert.ok(sourceCity, reviewed.path);
    assert.equal(Number(sourceCity.latitude.toFixed(5)), reviewed.latitude);
    assert.equal(Number(sourceCity.longitude.toFixed(5)), reviewed.longitude);
  }
  for (const city of enrichment.cities) {
    assert.deepEqual(Object.keys(city).sort(), ["geonames", "koppenGeiger", "nasaPower", "path"]);
    assert.deepEqual(Object.keys(city.geonames).sort(), ["elevationM", "elevationSource", "id", "timezone"]);
    assert.deepEqual(Object.keys(city.nasaPower).sort(), ["monthlyC", "peakMonths", "requestUrl", "responseSha256"]);
    assert.equal(city.nasaPower.monthlyC.length, 12);
    assert.ok(city.nasaPower.peakMonths.length >= 1);
    assert.ok(city.koppenGeiger.modalShare > 0 && city.koppenGeiger.modalShare <= 1);
  }
  assert.deepEqual(enrichment.reviewCohort, [...expectedReviewPaths].sort());
  assert.equal(enrichment.provenance.geonames.sha256, "b0d39ebf8d1935d425f3efc1d90c881bdc83d7567ca6db1232973eaebc51e2e2");
  assert.equal(enrichment.provenance.beck.sha256, "bb84453d4541f1a0bc5a804ead83f483c19ce70f16a5197f6d3a7b6a63e65562");
  assert.doesNotMatch(JSON.stringify(enrichment), /G-LNPWV0JL7S|google|query/i);
});

test("Popular-40 validator fails closed on malformed values and cohort drift", () => {
  const broken = structuredClone(enrichment);
  broken.cities[0].nasaPower.monthlyC[0] = "hot";
  assert.throws(() => validatePopular40Enrichment(broken), /monthlyC/);
  const missing = structuredClone(enrichment);
  missing.cities.pop();
  assert.throws(() => validatePopular40Enrichment(missing), /exactly 40/);
});

test("all Popular-40 city pages expose accessible attribution and modeled climatology caveats", () => {
  const site = createSiteData(inventory, tier1);
  const citiesByPath = new Map(site.cities.map((city) => [routePathForCity(city), city]));
  for (const pathName of enrichment.cities.map((city) => city.path)) {
    const city = citiesByPath.get(pathName);
    assert.ok(city, pathName);
    const html = pageHtml(city);
    assert.match(html, /aria-labelledby="city-climate-context-heading"/);
    assert.match(html, /NASA POWER/);
    assert.match(html, /modeled monthly means/);
    assert.match(html, /local solar time/i);
    assert.match(html, /coarse .*grid/i);
    assert.match(html, /GeoNames/);
    assert.match(html, /Köppen-Geiger/);
    assert.match(html, /<table/);
    assert.doesNotMatch(html, /wet-bulb/i);
  }
  const nonPopular = site.cities.find((city) => !city.enrichment);
  assert.ok(nonPopular);
  assert.doesNotMatch(pageHtml(nonPopular), /city-climate-context-heading/);
});
