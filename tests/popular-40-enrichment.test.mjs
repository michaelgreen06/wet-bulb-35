import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

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
  const wrongPeriod = structuredClone(enrichment);
  wrongPeriod.cities[0].nasaPower.requestUrl = wrongPeriod.cities[0].nasaPower.requestUrl.replace("start=1991&end=2020", "start=1981&end=2010");
  assert.throws(() => validatePopular40Enrichment(wrongPeriod), /provenance/);
  const missingProvenance = structuredClone(enrichment);
  delete missingProvenance.provenance.nasaPower;
  assert.throws(() => validatePopular40Enrichment(missingProvenance), /provenance/);
  const ambiguousKoppen = structuredClone(enrichment);
  ambiguousKoppen.cities[0].koppenGeiger.modalShare = 0.66;
  assert.throws(() => validatePopular40Enrichment(ambiguousKoppen), /Köppen-Geiger/);
});

test("Popular-40 climate source references have unique paired backlinks and valid fragments", () => {
  const site = createSiteData(inventory, tier1);
  const citiesByPath = new Map(site.cities.map((city) => [routePathForCity(city), city]));
  for (const pathName of enrichment.cities.map((city) => city.path)) {
    const city = citiesByPath.get(pathName);
    assert.ok(city, pathName);
    const html = pageHtml(city);
    const document = new JSDOM(html).window.document;
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    assert.equal(new Set(ids).size, ids.length, `${pathName} has duplicate IDs`);
    for (const anchor of document.querySelectorAll('a[href^="#"]')) {
      assert.ok(document.getElementById(anchor.hash.slice(1)), `${pathName} has unresolved ${anchor.getAttribute("href")}`);
    }
    const inlineRefs = [...document.querySelectorAll("a[data-source-reference]")];
    assert.deepEqual(inlineRefs.map((anchor) => anchor.id), [
      "source-note-koppen-ref",
      "source-note-geonames-timezone-ref",
      "source-note-geonames-elevation-ref",
      "source-note-nasa-power-peak-ref",
      "source-note-nasa-power-table-ref",
    ]);
    for (const reference of inlineRefs) {
      const backlink = document.querySelector(`[data-source-backlink="${reference.id}"]`);
      assert.ok(backlink, `${pathName} lacks a backlink for ${reference.id}`);
      assert.equal(backlink.hash, `#${reference.id}`);
    }
    assert.equal(document.querySelectorAll("a[data-source-backlink]").length, inlineRefs.length);
    assert.match(document.querySelector("#source-note-geonames").textContent, /GeoNames.*CC BY 4\.0/s);
    assert.match(document.querySelector("#source-note-koppen").textContent, /Beck et al\..*CC BY 4\.0.*3×3/s);
    assert.match(document.querySelector("#source-note-nasa-power").textContent, /NASA POWER.*MERRA-2 grid.*local solar time.*modeled monthly means, not station observations or records.*neighborhood conditions/s);
    assert.doesNotMatch(document.querySelector("[aria-labelledby='city-climate-context-heading']").textContent, /wet-bulb|wetbulb/i);
  }
  const nonPopular = site.cities.find((city) => !city.enrichment);
  assert.ok(nonPopular);
  assert.doesNotMatch(pageHtml(nonPopular), /city-climate-context-heading/);
});

test("Houston copy is exact, tied months format grammatically, and dynamic city text is escaped", () => {
  const site = createSiteData(inventory, tier1);
  const houston = site.cities.find((city) => routePathForCity(city) === "/wetbulb-temperature/united-states/texas/houston/");
  assert.ok(houston);
  const houstonHtml = pageHtml(houston);
  assert.match(houstonHtml, /Houston and the surrounding area have a temperate, no dry season, hot summer climate classification \(Cfa\)\./);
  assert.match(houstonHtml, /August is predicted to be the highest wet bulb month for Houston, Texas, with a mean wet bulb temperature of 25\.6 °C\./);
  assert.match(houstonHtml, /Monthly mean wet bulb temperatures for Houston, Texas/);

  const tied = structuredClone(houston);
  tied.name = "Example City";
  tied.outputCitySlug = "example-city";
  tied.enrichment.nasaPower.peakMonths = [7, 8];
  const tiedHtml = pageHtml(tied);
  assert.match(tiedHtml, /July and August are predicted to be the highest wet bulb months for Example City, Texas, with a mean wet bulb temperature of 25\.6 °C\./);

  const threeWayTie = structuredClone(houston);
  threeWayTie.outputCitySlug = "three-way-tie";
  threeWayTie.enrichment.nasaPower.monthlyC[5] = 25.6;
  threeWayTie.enrichment.nasaPower.monthlyC[6] = 25.6;
  threeWayTie.enrichment.nasaPower.peakMonths = [6, 7, 8];
  assert.match(pageHtml(threeWayTie), /June, July, and August are predicted to be the highest wet bulb months/);

  const hostile = structuredClone(houston);
  hostile.name = '<City (A)+ & "B">';
  hostile.resolvedAdmin1Code = 'Admin [x].* & "y"';
  const hostileHtml = pageHtml(hostile);
  const hostileDocument = new JSDOM(hostileHtml).window.document;
  const climateText = hostileDocument.querySelector("[aria-labelledby='city-climate-context-heading']").textContent;
  assert.match(climateText, /<City \(A\)\+ & "B">/);
  assert.match(climateText, /Admin \[x\]\.\* & "y"/);
  assert.doesNotMatch(hostileHtml, /<City \(A\)\+/);
});
