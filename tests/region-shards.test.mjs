import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildHonoBindingAssets } from '../scripts/build-hono-binding-assets.mjs';
import { createHonoPageRenderer, createLocationResolver } from '../workers/hono-page-renderer.mjs';

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
    assert.equal(directory.kind, 'state');
    assert.equal(directory.state.cityCardsHtml.split('</a>').length - 1, 140);
    assert.deepEqual(requested.slice(1), [`/locations/shards/${state.file.replace(/\.json$/, '.directory.json')}`],
      'a cold large directory must not load or index the full region shard');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('region-shard staging config is never publicly reachable by default', () => {
  const toml = fs.readFileSync(new URL('../wrangler.region-shards-staging.toml', import.meta.url), 'utf8');
  const active = toml.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  // Wrangler enables workers.dev when the key is absent; top-level keys must precede the first table.
  const topLevel = active.split(/^\[/m)[0];
  assert.match(topLevel, /^workers_dev = false$/m);
  assert.match(topLevel, /^preview_urls = false$/m);
  assert.doesNotMatch(active, /^\s*routes?\s*=|custom_domain|\[\[routes\]\]/m);
});

// Serves a build directory; `withoutBuckets` reproduces the full-region directory render as the parity reference.
function diskAssets(out, { withoutBuckets = false } = {}) {
  return { async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const file = path.join(out, pathname);
    if (withoutBuckets && pathname === '/locations/route-manifest.json') {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const country of manifest.countries) for (const state of country.states) delete state.buckets;
      return Response.json(manifest);
    }
    return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response('missing', { status: 404 });
  } };
}

async function assertDirectoryParity(out, routes) {
  for (const route of routes) {
    const env = { OBSERVABILITY_DISABLED: 'true' };
    const actual = await createHonoPageRenderer({ cache: () => undefined })
      .fetch(new Request(`https://www.wetbulb35.com${route}`), { ...env, ASSETS: diskAssets(out) });
    const expected = await createHonoPageRenderer({ cache: () => undefined })
      .fetch(new Request(`https://www.wetbulb35.com${route}`), { ...env, ASSETS: diskAssets(out, { withoutBuckets: true }) });
    assert.equal(actual.status, 200, route);
    assert.equal(expected.status, 200, route);
    assert.deepEqual([...actual.headers], [...expected.headers], route);
    assert.equal(await actual.text(), await expected.text(), route);
  }
}

test('large-region directories render byte-identically from a precomputed fragment and fail closed', async () => {
  const names = ['Zürich', 'Ångström', 'école', 'Ecole', '<b>"Quoted" & Co</b>', "O'Brien", 'Łódź', 'Ōsaka', 'Town 1', 'Town 10'];
  const many = Array.from({ length: 140 }, (_, i) => ({ name: names[i] ?? `Town ${i}`, resolvedCountryName: 'Exampleland',
    resolvedAdmin1Code: 'Large Region', latitude: 20 + i / 1000, longitude: 30 + i / 1000 }));
  many.push({ name: 'Small Town', resolvedCountryName: 'Exampleland', resolvedAdmin1Code: 'Small Region', latitude: 1, longitude: 1 });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'region-directories-'));
  try {
    const built = buildHonoBindingAssets({ sourceCities: many, outDir: out });
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'locations/route-manifest.json')));
    const large = manifest.countries[0].states.find((state) => state.slug === 'large-region');
    const small = manifest.countries[0].states.find((state) => state.slug === 'small-region');
    assert.ok(large.buckets > 1);
    assert.equal(small.buckets, undefined);
    const directoryFile = path.join(out, 'locations/shards', large.file.replace(/\.json$/, '.directory.json'));
    assert.ok(fs.existsSync(directoryFile));
    assert.ok(!fs.existsSync(path.join(out, 'locations/shards', small.file.replace(/\.json$/, '.directory.json'))));
    assert.equal(built.files, 2 + large.buckets + 1 + 1, 'manifest, two regions, buckets and one directory');
    await assertDirectoryParity(out, ['/wetbulb-temperature/exampleland/large-region/', '/wetbulb-temperature/exampleland/small-region/']);

    const request = new Request('https://region.test');
    const parts = ['wetbulb-temperature', 'exampleland', 'large-region'];
    const original = fs.readFileSync(directoryFile, 'utf8');
    for (const tamper of [
      (value) => ({ ...value, n: value.n + 1 }),
      (value) => ({ ...value, path: '/wetbulb-temperature/exampleland/small-region/' }),
      (value) => ({ ...value, h: '' }),
      (value) => ({ ...value, v: 2 }),
    ]) {
      fs.writeFileSync(directoryFile, JSON.stringify(tamper(JSON.parse(original))));
      await assert.rejects(createLocationResolver()(request, diskAssets(out), parts), 'a directory fragment must match its region');
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('real large regions keep byte-identical directory HTML from bounded fragments', { timeout: 120_000 }, async () => {
  const regions = new Set(['England', 'Bavaria', 'Lombardy']);
  const sourceCities = JSON.parse(fs.readFileSync(new URL('../scripts/resolved_cities.json', import.meta.url), 'utf8'))
    .filter((city) => regions.has(city.resolvedAdmin1Code));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'region-directories-real-'));
  try {
    buildHonoBindingAssets({ sourceCities, outDir: out });
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'locations/route-manifest.json')));
    const routes = manifest.countries.flatMap((country) => country.states.map((state) => {
      assert.ok(state.buckets > 1, state.name);
      return `/wetbulb-temperature/${country.countrySlug}/${state.slug}/`;
    }));
    assert.equal(routes.length, 3);
    await assertDirectoryParity(out, routes);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
