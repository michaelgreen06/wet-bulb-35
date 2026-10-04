import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pageHtml, routePathForCity } from "../lib/page-renderer.mjs";
import { createClimateExpander } from "../lib/climate-classes.mjs";
import { BECK_ZIP_SHA256, expandClimate, inventorySha256, KOPPEN_CLASSES, loadClimateContext, validateClimateContext } from "../lib/climate-context.mjs";
import { buildHonoBindingAssets } from "../scripts/build-hono-binding-assets.mjs";
import { createRouteIdentityIndex } from "../scripts/probe-location-route-identity.mjs";
import { createHonoPageRenderer } from "../workers/hono-page-renderer.mjs";

const city = { name: "Boulder", resolvedAdmin1Code: "Colorado", resolvedCountryName: "United States", latitude: 40.01499, longitude: -105.27055, outputCitySlug: "boulder" };
const other = { ...city, name: "Lyons", latitude: 40.22471, longitude: -105.27138, outputCitySlug: "lyons" };
const beck = { version: "v3", period: "1991-2020", file: "koppen_geiger_tif.zip", sha256: BECK_ZIP_SHA256,
  rasterSha256: "2130f0071dfb2904947d8ec3a0d807fac71004df76e769262004f1602e4d6a13", legendSha256: "2ede2ad270a036cc11c31705a2c1dbf0314a8cf011fc972cd4a9665e3339e5e5",
  method: "center plus 3x3 modal share", minModalShare: 0.67, license: "CC BY 4.0", url: "https://doi.org/10.6084/m9.figshare.21789074.v3" };
const nasa = { accessedDate: "2026-10-04", apiVersion: "v2.10.0", parameter: "T2MWET", period: "1991-2020", timeStandard: "LST",
  grid: "MERRA-2 0.5x0.625 nearest cell", cells: 1, validationSamples: 200, sourceLockSha256: "a".repeat(64) };
const monthly = [-61, -50, -21, 11, 54, 99, 128, 126, 82, 23, -31, -61];
const cellRow = [...monthly, 1 << 6];

function inventory(...cities) {
  return createRouteIdentityIndex(cities).rows;
}

function artifact(rows, byPath, { cells = [cellRow], source = nasa, exclusions = { koppen: {}, nasaPower: {} } } = {}) {
  const values = Object.values(byPath);
  return { v: 1, inventory: { routes: rows.length, sha256: inventorySha256(rows) }, sources: { beck, nasaPower: source },
    counts: { routes: values.length, koppen: values.filter(([k]) => k !== null).length, nasaPower: values.filter(([, c]) => c !== null).length },
    exclusions, cells, byPath };
}

function climateSection(html) {
  return html.slice(html.indexOf('<section aria-labelledby="city-climate-context-heading"'), html.indexOf("</section>", html.indexOf('<section aria-labelledby="city-climate-context-heading"')));
}

test("validator fails closed on inventory drift, inconsistent exclusions and unsourced values", () => {
  const rows = inventory(city, other);
  const [a, b] = rows.map((row) => `/wetbulb-temperature/${row.countrySlug}/${row.stateSlug}/${row.outputCitySlug}/`);
  const exclusions = { koppen: { lowModalShare: [b] }, nasaPower: {} };
  const good = artifact(rows, { [a]: [26, 0], [b]: [null, 0] }, { exclusions });
  assert.equal(validateClimateContext(good, rows), good);
  assert.throws(() => validateClimateContext(good, inventory(city, { ...other, latitude: 40.22472 })), /different canonical inventory/);
  assert.throws(() => validateClimateContext(artifact(rows, { [a]: [26, 0], [b]: [null, 0] }), rows), /Köppen exclusions/);
  assert.throws(() => validateClimateContext(artifact(rows, { [a]: [26, 0], [b]: [null, 0] }, { exclusions: { koppen: { guessed: [b] } } }), rows), /Unknown climate exclusion/);
  assert.throws(() => validateClimateContext(artifact(rows, { [a]: [26, 0], [b]: [null, null] }, { source: null, exclusions }), rows), /without provenance/);
  assert.throws(() => validateClimateContext(artifact(rows, { [a]: [31, 0], [b]: [null, 0] }, { exclusions }), rows), /Invalid climate-context row/);
  assert.throws(() => validateClimateContext(artifact(rows, { [a]: [26, 0], [b]: [null, 0] }, { exclusions, cells: [[...monthly, 1]] }), rows), /Invalid NASA POWER cell/);
  assert.throws(() => validateClimateContext({ ...good, sources: { ...good.sources, beck: { ...beck, minModalShare: 0.5 } } }, rows), /provenance/);
});

test("compact tuples expand to labelled classes and tenths with tied peaks", () => {
  const climate = expandClimate([14, 0], [[...Array(10).fill(200), 270, 270, 0b110000000000]]);
  assert.deepEqual(climate.koppen, { code: "Cfa", label: "Temperate, no dry season, hot summer" });
  assert.deepEqual(climate.nasaPower.peakMonths, [11, 12]);
  assert.equal(climate.nasaPower.monthlyC[10], 27);
  assert.equal(expandClimate([null, null], []), null);
  assert.equal(KOPPEN_CLASSES.length, 31);
  const expand = createClimateExpander([cellRow]);
  assert.equal(expand([26, 0]), expand([26, 0]));
  assert.notEqual(expand([26, 0]), expand([26, null]));
  assert.ok(Object.isFrozen(expand([26, 0]).nasaPower.monthlyC));
  assert.equal(expand([null, null]), null);
});

test("non-Popular pages render only the climate values that passed generation gates", () => {
  const both = pageHtml({ ...city, climate: expandClimate([26, 0], [cellRow]) });
  const section = climateSection(both);
  assert.match(section, /Boulder and the surrounding area have a cold, no dry season, warm summer climate classification \(Dfb\)\./);
  assert.match(section, /July is predicted to be the highest wet bulb month for Boulder, Colorado, with a mean wet bulb temperature of 12\.8 °C\./);
  assert.match(section, /<caption[^>]*>Monthly mean wet bulb temperatures for Boulder, Colorado/);
  assert.match(section, /<th scope="row"[^>]*>January<\/th><td[^>]*>-6\.1 °C<\/td>/);
  assert.doesNotMatch(section, /IANA timezone|Approximate elevation/);
  assert.doesNotMatch(both, /wetbulb temperatures|wet-bulb/i);
  assert.match(both, /href="#source-note-koppen"[^>]*>1<\/a>/);
  assert.match(both, /href="#source-note-nasa-power"[^>]*>2<\/a>/);
  assert.doesNotMatch(both, /id="source-note-geonames"/);
  assert.match(both, /modeled monthly means, not station observations or records/);

  const koppenOnly = pageHtml({ ...city, climate: expandClimate([26, null], []) });
  assert.match(koppenOnly, /climate classification \(Dfb\)/);
  assert.doesNotMatch(koppenOnly, /<table|NASA POWER|highest wet bulb/);
  assert.match(koppenOnly, /id="source-note-koppen"/);

  const nasaOnly = pageHtml({ ...city, climate: expandClimate([null, 0], [cellRow]) });
  assert.doesNotMatch(nasaOnly, /climate classification|Köppen/);
  assert.match(nasaOnly, /href="#source-note-nasa-power"[^>]*>1<\/a>/);

  const excluded = pageHtml({ ...city, climate: null });
  assert.doesNotMatch(excluded, /Climate context for|Climate context sources/);
});

test("Popular-40 pages keep the reviewed pilot record even if all-location data is present", () => {
  const popular = JSON.parse(fs.readFileSync("data/popular-40-enrichment.v1.json", "utf8")).cities[0];
  const [, , countrySlug, stateSlug, outputCitySlug] = popular.path.split("/");
  const baseline = pageHtml({ name: "Buenos Aires", resolvedAdmin1Code: "Buenos Aires F.D.", resolvedCountryName: "Argentina", latitude: -34.61315, longitude: -58.37723, outputCitySlug, countrySlug, stateSlug });
  const withClimate = pageHtml({ name: "Buenos Aires", resolvedAdmin1Code: "Buenos Aires F.D.", resolvedCountryName: "Argentina", latitude: -34.61315, longitude: -58.37723, outputCitySlug, countrySlug, stateSlug, climate: expandClimate([1, 0], [cellRow]) });
  assert.equal(withClimate, baseline);
  assert.match(baseline, /IANA timezone/);
});

test("climate travels through a per-country shard with a local cell table into crawler HTML", async () => {
  const rows = inventory(city, other);
  const [a, b] = rows.map((row) => `/wetbulb-temperature/${row.countrySlug}/${row.stateSlug}/${row.outputCitySlug}/`);
  const climateContext = artifact(rows, { [a]: [26, null], [b]: [26, 0] }, { exclusions: { koppen: {}, nasaPower: { cellEdgeTie: [a] } } });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "climate-assets-"));
  try {
    buildHonoBindingAssets({ sourceCities: [city, other], outDir: out, climateContext });
    const asset = (pathname) => path.join(out, pathname);
    const shard = JSON.parse(fs.readFileSync(asset("/locations/shards/united-states.json")));
    const manifest = JSON.parse(fs.readFileSync(asset("/locations/route-manifest.json")));
    assert.deepEqual(shard.c, [cellRow]);
    assert.deepEqual(shard.r.map((row) => row.slice(6)), [[null, [26, null]], [null, [26, 0]]]);
    assert.equal(manifest.climateSource.inventorySha256, climateContext.inventory.sha256);
    const binding = { async fetch(request) { const name = asset(new URL(request.url).pathname); return fs.existsSync(name) ? new Response(fs.readFileSync(name)) : new Response("Missing", { status: 404 }); } };
    let providerCalls = 0;
    const env = { ASSETS: binding, WEATHER_PROVIDER: { fetch() { providerCalls++; throw new Error("No weather on HTML"); } } };
    const renderer = createHonoPageRenderer();
    const lyons = await (await renderer.fetch(new Request(`https://www.wetbulb35.com${b}`, { headers: { "User-Agent": "Googlebot" } }), env)).text();
    assert.match(lyons, /Climate context for Lyons/);
    assert.match(lyons, /July is predicted to be the highest wet bulb month for Lyons, Colorado/);
    const boulder = await (await renderer.fetch(new Request(`https://www.wetbulb35.com${a}`, { headers: { "User-Agent": "Googlebot" } }), env)).text();
    assert.match(boulder, /climate classification \(Dfb\)/);
    assert.doesNotMatch(boulder, /highest wet bulb/);
    assert.equal(providerCalls, 0);
    fs.writeFileSync(asset("/locations/shards/united-states.json"), JSON.stringify({ ...shard, c: [] }));
    const broken = await createHonoPageRenderer().fetch(new Request(`https://www.wetbulb35.com${b}`), env);
    assert.equal(broken.status, 500);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test("committed climate context covers the exact canonical inventory and matches the Popular-40 pilot", { timeout: 120_000 }, () => {
  const rows = createRouteIdentityIndex(JSON.parse(fs.readFileSync("scripts/resolved_cities.json", "utf8"))).rows;
  const climate = validateClimateContext(loadClimateContext(), rows);
  assert.equal(rows.length, 130686);
  assert.ok(climate.counts.koppen / rows.length > 0.9, "Köppen covers a large majority");
  const popular = JSON.parse(fs.readFileSync("data/popular-40-enrichment.v1.json", "utf8")).cities;
  for (const city of popular) {
    const expanded = expandClimate(climate.byPath[city.path], climate.cells);
    assert.deepEqual(expanded.koppen, { code: city.koppenGeiger.code, label: city.koppenGeiger.label }, city.path);
    if (climate.sources.nasaPower) {
      assert.deepEqual(expanded.nasaPower, { monthlyC: city.nasaPower.monthlyC, peakMonths: city.nasaPower.peakMonths }, city.path);
    }
  }
});
