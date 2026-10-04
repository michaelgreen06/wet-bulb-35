import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { clientRuntimeSource, pageHtml, routePathForCity } from '../lib/page-renderer.mjs';
import { LOCATION_FACTS_SHA256, loadLocationFacts, validateLocationFacts } from '../lib/location-facts.mjs';
import { buildHonoBindingAssets } from '../scripts/build-hono-binding-assets.mjs';
import { createRouteIdentityIndex } from '../scripts/probe-location-route-identity.mjs';
import { createHonoPageRenderer } from '../workers/hono-page-renderer.mjs';

const baseCity = {name: 'Boulder', resolvedAdmin1Code: 'Colorado', resolvedCountryName: 'United States', latitude: 40.01499, longitude: -105.27055, outputCitySlug: 'boulder'};

test('city facts are visible in HTML beneath weather without pretending the source date is a census year', () => {
  const html = pageHtml({...baseCity, locationFacts: {id: 5574991, population: 108250, timeZone: 'America/Denver', elevationM: 1655, elevationSource: 'dem', snapshot: '2026-09-29'}});
  assert.match(html, /About Boulder/);
  assert.ok(html.indexOf('About Boulder') > html.indexOf('data-weather-widget'));
  assert.match(html, /GeoNames lists (?:a population of )?108,250/);
  assert.match(html, /September 29, 2026/);
  assert.match(html, /(?:year|date) (?:is )?not (?:provided|specified)/i);
  assert.match(html, /data-local-clock="America\/Denver"/);
  assert.match(html, /1,655 m/);
  assert.match(html, /approximate/i);
  assert.doesNotMatch(html, /population of Boulder as of September 29, 2026/i);
});

test('partial facts never invent population, time, or elevation', () => {
  const html = pageHtml({...baseCity, locationFacts: {id: 5574991, population: null, timeZone: null, elevationM: null, elevationSource: null}});
  assert.doesNotMatch(html, /data-local-clock=/);
  assert.doesNotMatch(html, /Population of Boulder:/);
  assert.doesNotMatch(html, /Elevation of Boulder:/);
  assert.doesNotMatch(pageHtml(baseCity), /About Boulder/);
  const belowSeaLevel = pageHtml({...baseCity, locationFacts: {id: 5574991, population: null, timeZone: null, elevationM: -20, elevationSource: 'dem', snapshot: '2026-09-29'}});
  assert.match(belowSeaLevel, /20 m below sea level/);
});

test('clock script uses the pinned location time zone and refreshes after a suspended tab resumes', () => {
  const source = clientRuntimeSource();
  new Script(source);
  assert.match(source, /\[data-local-clock\]/);
  assert.match(source, /Intl\.DateTimeFormat/);
  assert.match(source, /visibilitychange/);
});

test('browser clock renders the location time zone and refreshes on tab resume without weather access', async () => {
  const dom = new JSDOM('<time data-local-clock="Pacific/Kiritimati">Loading local time…</time>',
    {runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://www.wetbulb35.com/'});
  const calls = [];
  dom.window.fetch = async (url) => {calls.push(String(url));return {ok: false};};
  Object.defineProperty(dom.window.navigator, 'userAgent', {value: 'Googlebot'});
  try {
    dom.window.eval(clientRuntimeSource());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const clock = dom.window.document.querySelector('[data-local-clock]');
    const format = new Intl.DateTimeFormat(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Pacific/Kiritimati', timeZoneName: 'short'});
    assert.equal(clock.textContent, format.format(new Date(clock.dateTime)));
    clock.textContent = 'stale';
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    assert.equal(clock.textContent, format.format(new Date(clock.dateTime)));
    assert.ok(calls.every((url) => !url.includes('/api/weather') && !url.includes('/api/forecast')));
  } finally {dom.window.close();}
});

test('build-time facts travel through a country shard into crawler-readable HTML only', async () => {
  const city = {...baseCity};
  const route = routePathForCity(city);
  const facts = {v: 1, source: {dataset: 'GeoNames cities1000', snapshot: '2026-09-29', sha256: LOCATION_FACTS_SHA256, populationReferenceYear: null}, byPath: {[route]: [5574991, 108250, 'America/Denver', 1655, 'dem']}};
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'location-facts-assets-'));
  try {
    validateLocationFacts(facts, [route]);
    buildHonoBindingAssets({sourceCities: [city], outDir: out, locationFacts: facts});
    const asset = (pathname) => path.join(out, pathname);
    const binding = {async fetch(request) {const name = asset(new URL(request.url).pathname);return fs.existsSync(name) ? new Response(fs.readFileSync(name), {status: 200}) : new Response('Missing', {status: 404});}};
    const manifest = JSON.parse(fs.readFileSync(asset('/locations/route-manifest.json')));
    const shard = JSON.parse(fs.readFileSync(asset('/locations/shards/united-states.json')));
    assert.equal(manifest.factsSource.snapshot, '2026-09-29');
    assert.deepEqual(shard.r[0][6], facts.byPath[route]);
    let providerCalls = 0;
    const response = await createHonoPageRenderer().fetch(new Request('https://www.wetbulb35.com' + route, {headers: {'User-Agent': 'Googlebot'}}), {
      ASSETS: binding,
      WEATHER_PROVIDER: {fetch() {providerCalls++;throw new Error('No weather on HTML');}},
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /About Boulder/);
    assert.match(html, /108,250/);
    assert.match(html, /data-local-clock="America\/Denver"/);
    assert.equal(providerCalls, 0);
  } finally { fs.rmSync(out, {recursive: true, force: true}); }
});

test('one ambiguous city fact never leaks to another route', () => {
  const a = routePathForCity(baseCity);
  const b = '/wetbulb-temperature/united-states/colorado/other-boulder/';
  const artifact = {v: 1, source: {dataset: 'GeoNames cities1000', snapshot: '2026-09-29', sha256: LOCATION_FACTS_SHA256, populationReferenceYear: null}, byPath: {[a]: [1, 100, 'America/Denver', 1000, 'dem'], [b]: [1, 200, 'America/Denver', 2000, 'dem']}};
  assert.throws(() => validateLocationFacts(artifact, [a, b]), /ambiguous/);
  artifact.byPath[b] = null;
  assert.equal(validateLocationFacts(artifact, [a, b]), artifact);
});

test('committed facts cover the unchanged full canonical route inventory', {timeout: 90_000}, () => {
  const inventory = JSON.parse(fs.readFileSync('scripts/resolved_cities.json', 'utf8'));
  const canonicalPaths = createRouteIdentityIndex(inventory).rows.map((row) => `/wetbulb-temperature/${row.countrySlug}/${row.stateSlug}/${row.outputCitySlug}/`);
  const artifact = validateLocationFacts(loadLocationFacts(), canonicalPaths);
  assert.equal(canonicalPaths.length, 130686);
  assert.deepEqual({routes: artifact.counts.routes, matched: artifact.counts.matched, unmatched: artifact.counts.unmatched,
    ambiguous: artifact.counts.ambiguousIdentity, population: artifact.counts.population, elevation: artifact.counts.elevation},
  {routes: 130686, matched: 129313, unmatched: 1367, ambiguous: 6, population: 129310, elevation: 129076});
});

test('new city facts agree with the existing Popular-40 climate module', () => {
  const rows = loadLocationFacts().byPath;
  const popular = JSON.parse(fs.readFileSync('data/popular-40-enrichment.v1.json', 'utf8')).cities;
  assert.equal(popular.length, 40);
  for (const city of popular) {
    const facts = rows[city.path];
    assert.ok(facts, city.path);
    assert.equal(facts[2], city.geonames.timezone, city.path);
    assert.equal(facts[3], city.geonames.elevationM, city.path);
  }
});
