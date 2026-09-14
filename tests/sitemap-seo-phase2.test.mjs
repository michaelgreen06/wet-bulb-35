import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSiteData, routePathForCity } from "../lib/page-renderer.mjs";
import { generateSitemaps, MAX_URLS_PER_SITEMAP } from "../scripts/generate-sitemaps.js";

const root = path.resolve(import.meta.dirname, "..");
const expectedLastmod = "2026-09-13";
const baseUrl = "https://www.wetbulb35.com";

function readLocations(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
}

function readSitemapOutput(outputDir) {
  const sitemapsDir = path.join(outputDir, "sitemaps");
  const members = fs.readdirSync(sitemapsDir).filter((name) => name.endsWith(".xml")).sort();
  const index = fs.readFileSync(path.join(outputDir, "sitemap.xml"), "utf8");
  return {
    index,
    members: new Map(members.map((name) => [name, fs.readFileSync(path.join(sitemapsDir, name), "utf8")])),
  };
}

function withTempOutput(fn) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "wetbulb-sitemap-"));
  try {
    return fn(outputDir);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

function assertProtocolAndMetadata({ index, members }) {
  for (const [file, xml] of [["sitemap.xml", index], ...members]) {
    assert.doesNotMatch(xml, /<(?:priority|changefreq)>/i, file);
    const locations = readLocations(xml);
    const lastmods = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((match) => match[1]);
    assert.equal(lastmods.length, locations.length, `${file} has one lastmod per entry`);
    assert.ok(lastmods.every((value) => value === expectedLastmod), `${file} has date-only lastmod`);
    assert.ok(locations.length <= MAX_URLS_PER_SITEMAP, `${file} obeys sitemap URL limit`);
  }
}

test("generator rejects invalid LASTMOD values", () => {
  withTempOutput((outputDir) => {
    assert.throws(
      () => generateSitemaps({ outputDir, dataPath: path.join(root, "scripts/resolved_cities.json"), lastmod: "2026-13-40" }),
      /YYYY-MM-DD/,
    );
  });
});

test("generator is deterministic, removes stale members, and index references exactly its members", () => {
  withTempOutput((outputDir) => {
    const options = { outputDir, dataPath: path.join(root, "scripts/resolved_cities.json"), baseUrl, lastmod: expectedLastmod };
    fs.mkdirSync(path.join(outputDir, "sitemaps"), { recursive: true });
    fs.writeFileSync(path.join(outputDir, "sitemaps", "sitemap-country-obsolete.xml"), "obsolete");
    fs.writeFileSync(path.join(outputDir, "sitemaps", "sitemap-country-%C3%A5land-islands.xml"), "obsolete");
    generateSitemaps(options);
    const first = readSitemapOutput(outputDir);
    assert.ok(!first.members.has("sitemap-country-obsolete.xml"));
    assert.ok(!first.members.has("sitemap-country-%C3%A5land-islands.xml"));
    generateSitemaps(options);
    const second = readSitemapOutput(outputDir);
    assert.deepEqual(second, first);

    assertProtocolAndMetadata(first);
    const indexedMembers = new Set(readLocations(first.index).map((url) => path.basename(new URL(url).pathname)));
    assert.deepEqual(indexedMembers, new Set(first.members.keys()));
    for (const member of indexedMembers) assert.ok(first.members.has(member), `${member} exists`);
  });
});

test("generated city and non-city URL sets exactly match renderer route identity", () => {
  const sourceCities = JSON.parse(fs.readFileSync(path.join(root, "scripts/resolved_cities.json"), "utf8"));
  const site = createSiteData(sourceCities);
  assert.equal(site.cities.length, 130_684);
  const expectedCities = new Set(site.cities.map(routePathForCity));
  assert.equal(expectedCities.size, 130_684);

  withTempOutput((outputDir) => {
    const result = generateSitemaps({ outputDir, dataPath: path.join(root, "scripts/resolved_cities.json"), baseUrl, lastmod: expectedLastmod });
    const output = readSitemapOutput(outputDir);
    assertProtocolAndMetadata(output);

    const cityUrls = new Set();
    for (const [name, xml] of output.members) {
      if (name.startsWith("sitemap-country-")) {
        for (const url of readLocations(xml)) cityUrls.add(new URL(url).pathname);
      }
    }
    assert.deepEqual(cityUrls, expectedCities);
    assert.equal(result.cityCount, 130_684);

    const nonCityUrls = new Set([
      ...readLocations(output.members.get("sitemap-main.xml")),
      ...readLocations(output.members.get("sitemap-categories.xml")),
    ].map((url) => new URL(url).pathname));
    const expectedNonCity = new Set([...site.pageRoutes].filter((route) => !site.cityRoutes.has(route)));
    assert.deepEqual(nonCityUrls, expectedNonCity);
    assert.equal(result.memberCount, output.members.size);
  });
});

test("committed sitemap output has date-only metadata and no orphaned members", () => {
  const output = readSitemapOutput(path.join(root, "public"));
  assertProtocolAndMetadata(output);
  const indexedMembers = new Set(readLocations(output.index).map((url) => path.basename(new URL(url).pathname)));
  assert.deepEqual(indexedMembers, new Set(output.members.keys()));
  assert.equal([...output.members.values()].flatMap(readLocations).length + readLocations(output.index).length, 134_662);
});
