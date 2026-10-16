import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildHonoBindingAssets } from '../scripts/build-hono-binding-assets.mjs';
import { createLocationResolver } from '../workers/hono-page-renderer.mjs';

const cities = [
  { name: 'Vila', resolvedCountryName: 'Andorra', resolvedAdmin1Code: 'Encamp', latitude: 42.53176, longitude: 1.56654 },
  { name: 'Andorra la Vella', resolvedCountryName: 'Andorra', resolvedAdmin1Code: 'Andorra la Vella', latitude: 42.5063, longitude: 1.5218 },
];

test('v2 build emits one bounded shard per region and resolves without loading its sibling', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'region-shards-'));
  try {
    const built = buildHonoBindingAssets({ sourceCities: cities, outDir: out });
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'locations/route-manifest.json'), 'utf8'));
    assert.equal(manifest.v, 2);
    assert.equal(built.rows, 2);
    assert.equal(built.files, 3);
    const country = manifest.countries[0];
    assert.equal(country.count, 2);
    assert.equal(country.states.length, 2);
    assert.ok(country.states.every((state) => state.count === 1 && state.file));
    assert.equal(new Set(country.states.map((state) => state.file)).size, 2);
    const requested = [];
    const assets = { async fetch(request) {
      const pathname = new URL(request.url).pathname;
      requested.push(pathname);
      const file = path.join(out, pathname);
      return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response('missing', { status: 404 });
    } };
    const resolve = createLocationResolver();
    const request = new Request('https://region.test');
    const state = country.states.find((item) => item.slug === 'encamp');
    const result = await resolve(request, assets, ['wetbulb-temperature', 'andorra', state.slug, 'vila']);
    assert.equal(result.kind, 'city');
    assert.equal(result.city.name, 'Vila');
    assert.ok(requested.includes(`/locations/shards/${state.file}`));
    assert.equal(requested.filter((item) => item.startsWith('/locations/shards/')).length, 1);
    const other = country.states.find((item) => item.slug !== state.slug);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'locations/shards', state.file), 'utf8')).r.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'locations/shards', other.file), 'utf8')).r.length, 1);
    const broken = JSON.parse(fs.readFileSync(path.join(out, 'locations/shards', state.file), 'utf8'));
    broken.r[0][1] = other.name;
    fs.writeFileSync(path.join(out, 'locations/shards', state.file), JSON.stringify(broken));
    await assert.rejects(createLocationResolver()(request, assets, ['wetbulb-temperature', 'andorra', state.slug, 'vila']),
      'a region shard must not claim another region’s city');
    manifest.countries[0].states[0].file = '../outside.json';
    fs.writeFileSync(path.join(out, 'locations/route-manifest.json'), JSON.stringify(manifest));
    await assert.rejects(createLocationResolver()(request, assets, ['wetbulb-temperature', 'andorra']),
      'a manifest must not fetch files outside its region namespace');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('large regions resolve cold city pages from bounded buckets, but directories retain every city', async () => {
  const many = Array.from({ length: 140 }, (_, i) => ({ name: `Town ${i}`, resolvedCountryName: 'Exampleland',
    resolvedAdmin1Code: 'Large Region', latitude: 20 + i / 1000, longitude: 30 + i / 1000 }));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'region-buckets-'));
  try {
    buildHonoBindingAssets({ sourceCities: many, outDir: out });
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'locations/route-manifest.json')));
    const state = manifest.countries[0].states[0];
    assert.ok(state.buckets > 1);
    const requested = [];
    const assets = { async fetch(request) {
      const pathname = new URL(request.url).pathname;
      requested.push(pathname);
      const file = path.join(out, pathname);
      return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response('missing', { status: 404 });
    } };
    const request = new Request('https://region.test');
    const city = await createLocationResolver()(request, assets,
      ['wetbulb-temperature', 'exampleland', 'large-region', 'town-17']);
    assert.equal(city.kind, 'city');
    assert.equal(city.city.name, 'Town 17');
    assert.equal(requested.length, 2, 'cold city needs only the manifest and one bounded bucket');
    assert.match(requested[1], /\.city-\d+\.json$/);
    requested.length = 0;
    const directory = await createLocationResolver()(request, assets,
      ['wetbulb-temperature', 'exampleland', 'large-region']);
    assert.equal(directory.state.cities.length, 140);
    assert.equal(requested[1], `/locations/shards/${state.file}`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
