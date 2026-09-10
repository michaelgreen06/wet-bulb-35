import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildHonoRendererAssets } from "../scripts/build-hono-renderer-assets.mjs";
import { normalizedSha256 } from "../scripts/generate-hono-renderer-goldens.mjs";
import {
  createSiteData,
  getRouteParts,
  pageHtml,
  renderBrowsePage,
  renderCountryPage,
  renderHomePage,
  renderStatePage,
} from "../scripts/prototype-static-generator.mjs";
import { createHonoPageRenderer, createLocationResolver } from "../workers/hono-page-renderer.mjs";
import { attachDetachedCleanup, spawnDetached, stopDetached } from "./helpers/detached-process-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = "https://renderer.test";
const options = { siteUrl: "https://www.wetbulb35.com", googleAnalyticsId: "G-LNPWV0JL7S" };
const fixtureCities = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/hono-binding-cities.json"), "utf8"));
const fixtureAssets = path.join(root, "tests/fixtures/hono-binding-assets");
const goldenEvidence = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/hono-renderer-goldens.json"), "utf8"));

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const FETCH_TIMEOUT_MS = 2_000;

function localFetch(port, pathname, init) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

function writeBrowserFixture(fixtureDir) {
  for (const relative of ["favicon.svg", "logo.svg", "images/wetbulb-default.jpg"]) {
    const source = path.join(root, "public", relative);
    const destination = path.join(fixtureDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

async function startWrangler(configPath, port, onSpawn) {
  const startedAt = performance.now();
  const child = spawnDetached(path.join(root, "node_modules/.bin/wrangler"), [
    "dev", "--local", "--config", configPath, "--ip", "127.0.0.1", "--port", String(port),
  ], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  onSpawn(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Wrangler exited early: ${output}`);
      try {
        const response = await localFetch(port, "/not-ready");
        if (response.status === 404) return { child, startupMs: Number((performance.now() - startedAt).toFixed(3)) };
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Wrangler did not start: ${output}`);
  } catch (error) {
    await stopDetached(child);
    throw error;
  }
}

class FakeCache {
  constructor() { this.entries = new Map(); this.matches = 0; this.puts = 0; this.failMatch = false; this.failPut = false; }
  async match(request) {
    this.matches += 1;
    if (this.failMatch) throw new Error("cache read failed");
    const response = this.entries.get(request.url);
    return response?.clone();
  }
  async put(request, response) {
    this.puts += 1;
    if (this.failPut) throw new Error("cache write failed");
    this.entries.set(request.url, response.clone());
  }
}

function fixtureBinding(requested = []) {
  return {
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      requested.push(pathname);
      const diskPath = path.join(fixtureAssets, pathname);
      if (!diskPath.startsWith(fixtureAssets) || !fs.existsSync(diskPath)) return new Response("missing", { status: 404 });
      return new Response(fs.readFileSync(diskPath), { status: 200 });
    },
  };
}

async function html(app, pathname, env) {
  const response = await app.fetch(new Request(`${base}${pathname}`), env);
  return { response, body: await response.text() };
}

function assertHtmlParity(actual, expected, pathname) {
  assert.equal(actual, expected, pathname);
  for (const needle of [
    "<meta name=\"description\"", "<link rel=\"canonical\"", "property=\"og:url\"",
    "application/ld\\+json", "/assets/app.css", "/assets/app.js",
  ]) assert.match(actual, new RegExp(needle), `${pathname}: ${needle}`);
}

test("Hono renderer is byte-parity with generator for representative pages", async () => {
  const siteData = createSiteData(fixtureCities);
  const andorra = siteData.countries.find((country) => country.slug === "andorra");
  const encamp = siteData.states.find((state) => state.countrySlug === "andorra" && state.stateSlug === "encamp");
  const vila = encamp.cities.find((city) => city.outputCitySlug === "vila");
  const metsamor = siteData.states.find((state) => state.countrySlug === "armenia").cities;
  const expected = new Map([
    ["/", renderHomePage(siteData, options)],
    ["/wetbulb-temperature", renderBrowsePage(siteData, options)],
    ["/wetbulb-temperature/andorra", renderCountryPage(andorra, options)],
    ["/wetbulb-temperature/andorra/encamp", renderStatePage(encamp, options)],
    ["/wetbulb-temperature/andorra/encamp/vila", pageHtml(vila, options)],
    ["/wetbulb-temperature/armenia/armavir/metsamor-40-0723-44-2917", pageHtml(metsamor[0], options)],
    ["/wetbulb-temperature/armenia/armavir/metsamor-40-1445-44-1167", pageHtml(metsamor[1], options)],
  ]);
  const requested = [];
  let providerCalls = 0;
  const app = createHonoPageRenderer();
  const env = {
    ASSETS: fixtureBinding(requested),
    WEATHER_PROVIDER: { fetch() { providerCalls += 1; throw new Error("HTML must not fetch weather"); } },
  };
  for (const [pathname, expectedHtml] of expected) {
    for (const variant of [pathname, `${pathname}/`]) {
      const result = await html(app, variant, env);
      assert.equal(result.response.status, 200, variant);
      assert.equal(result.response.headers.get("content-type"), "text/html; charset=UTF-8", variant);
      assertHtmlParity(result.body, expectedHtml, variant);
    }
  }
  assert.equal(providerCalls, 0);
  assert.ok(requested.includes("/locations/route-manifest.json"));
  assert.ok(requested.includes("/locations/shards/andorra.json"));
  assert.ok(requested.includes("/locations/shards/armenia.json"));
});

test("Hono renderer matches immutable pre-extraction golden hashes", { timeout: 30_000 }, async () => {
  assert.equal(goldenEvidence.provenance.generatorCommit, "ea7d0da");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "hono-renderer-goldens-"));
  try {
    const sourceCities = JSON.parse(fs.readFileSync(path.join(root, "scripts/resolved_cities.json"), "utf8"));
    buildHonoRendererAssets({ sourceCities, outDir, publicDir: path.join(root, "public") });
    const assets = { async fetch(request) {
      const diskPath = path.join(outDir, new URL(request.url).pathname);
      return fs.existsSync(diskPath) ? new Response(fs.readFileSync(diskPath)) : new Response("missing", { status: 404 });
    }};
    const app = createHonoPageRenderer();
    const mismatches = [];
    for (const page of goldenEvidence.pages) {
      const result = await html(app, page.route, { ASSETS: assets });
      if (result.response.status !== 200 || normalizedSha256(result.body) !== page.sha256) mismatches.push(page.route);
    }
    assert.deepEqual(mismatches, []);
    assert.equal(goldenEvidence.pages.filter((page) => page.type === "country-ordering-sensitive").length, 11);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

test("weather API fails closed without a WeatherGate binding and never calls a provider", async () => {
  let providerCalls = 0;
  const app = createHonoPageRenderer();
  const response = await app.fetch(new Request(`${base}/api/weather?lat=1&lon=2`), {
    ASSETS: fixtureBinding(),
    OBSERVABILITY_DISABLED: "true",
    WEATHER_PROVIDER: { fetch() { providerCalls += 1; return new Response("unexpected"); } },
  });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("content-type"), "application/json; charset=UTF-8");
  assert.deepEqual(await response.json(), { error: "Failed to refresh weather data." });
  assert.equal(providerCalls, 0);
});

test("location resolver bounds parsed shard LRU, reloads evictions, and coalesces in-flight loads", async () => {
  const countries = Array.from({ length: 10 }, (_, index) => ({
    country: `Country ${index}`, countrySlug: `country-${index}`, file: `country-${index}.json`, count: 1,
    states: [{ name: "State", slug: "state", count: 1 }],
  }));
  const counts = new Map();
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const assets = { async fetch(request) {
    const pathname = new URL(request.url).pathname;
    counts.set(pathname, (counts.get(pathname) || 0) + 1);
    if (pathname === "/locations/route-manifest.json") return Response.json({ v: 1, countries });
    const match = pathname.match(/^\/locations\/shards\/(country-\d+\.json)$/);
    if (!match) return new Response("missing", { status: 404 });
    if (match[1] === "country-0.json") await firstBlocked;
    return Response.json({ v: 1, r: [["City", "State", 1, 2, "city"]] });
  }};
  const resolver = createLocationResolver({ maxCachedShards: 8 });
  const partsFor = (index) => ["wetbulb-temperature", `country-${index}`, "state"];
  const request = new Request(base);
  const first = resolver(request, assets, partsFor(0));
  const sameKey = resolver(request, assets, partsFor(0));
  releaseFirst();
  await Promise.all([first, sameKey]);
  assert.equal(counts.get("/locations/shards/country-0.json"), 1);
  for (let index = 1; index < 10; index += 1) await resolver(request, assets, partsFor(index));
  assert.ok(resolver.cacheStats().parsedShards <= 8);
  await resolver(request, assets, partsFor(0));
  assert.equal(counts.get("/locations/shards/country-0.json"), 2);

  let invalidLoads = 0;
  const invalidAssets = { async fetch(requestForAsset) {
    const pathname = new URL(requestForAsset.url).pathname;
    if (pathname === "/locations/route-manifest.json") return Response.json({ v: 1, countries: [countries[0]] });
    invalidLoads += 1;
    return Response.json({ v: 0, r: [] });
  }};
  const invalidResolver = createLocationResolver({ maxCachedShards: 8 });
  await assert.rejects(invalidResolver(request, invalidAssets, partsFor(0)));
  await assert.rejects(invalidResolver(request, invalidAssets, partsFor(0)));
  assert.equal(invalidLoads, 2, "invalid shard data must not be retained");

  let rejectedLoads = 0;
  const rejectedAssets = { async fetch(requestForAsset) {
    const pathname = new URL(requestForAsset.url).pathname;
    if (pathname === "/locations/route-manifest.json") return Response.json({ v: 1, countries: [countries[0]] });
    rejectedLoads += 1;
    throw new Error("asset read failed");
  }};
  const rejectedResolver = createLocationResolver({ maxCachedShards: 8 });
  await assert.rejects(rejectedResolver(request, rejectedAssets, partsFor(0)));
  await assert.rejects(rejectedResolver(request, rejectedAssets, partsFor(0)));
  assert.equal(rejectedLoads, 2, "rejected shard loads must not be retained");
});

test("HTML Cache API envelope has bounded fresh/stale behavior and never changes browser caching", async () => {
  let clock = 1_000;
  let providerCalls = 0;
  const cache = new FakeCache();
  const app = createHonoPageRenderer({ cache: () => cache, now: () => clock, cacheVersion: (env) => env.HTML_CACHE_TEST_VERSION });
  const env = {
    ASSETS: fixtureBinding(), HTML_CACHE_TEST_VERSION: "deployment-a", OBSERVABILITY_DISABLED: "true",
    WEATHER_PROVIDER: { fetch() { providerCalls += 1; throw new Error("HTML must not fetch weather"); } },
  };
  const first = await html(app, "/wetbulb-temperature/andorra/encamp/vila?utm=one", env);
  assert.equal(first.response.status, 200);
  assert.equal(first.response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal(cache.puts, 1);
  const [cacheKey, internal] = [...cache.entries][0];
  assert.match(cacheKey, /deployment-a\/wetbulb-temperature\/andorra\/encamp\/vila$/);
  assert.equal(internal.headers.get("cache-control"), "public, max-age=691200");
  const envelope = await internal.clone().json();
  assert.deepEqual(Object.keys(envelope).sort(), ["cacheVersion", "freshUntil", "headers", "html", "routePath", "schema", "staleUntil", "status", "storedAt"]);
  assert.equal(envelope.headers["cache-control"], undefined, "browser response is not stored as the internal object");
  const slash = await html(app, "/wetbulb-temperature/andorra/encamp/vila/?utm=two", env);
  assert.equal(slash.body, first.body);
  assert.equal(cache.puts, 1, "query and parity-equivalent slash spelling share one GET entry");
  const head = await app.fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/vila?head=1`, { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal(await head.text(), "");
  assert.equal(cache.puts, 1, "HEAD fresh hit never creates an entry");

  clock = 1_000 + 24 * 60 * 60 * 1_000 + 1;
  const waits = [];
  const staleContext = { waitUntil(promise) { waits.push(promise); } };
  const staleResponses = await Promise.all([
    app.fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/vila`), env, staleContext),
    app.fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/vila?again=1`), env, staleContext),
  ]);
  assert.equal(await staleResponses[0].text(), first.body, "stale response is immediate parity HTML");
  assert.equal(await staleResponses[1].text(), first.body);
  await Promise.all(waits);
  assert.equal(cache.puts, 2, "same-key stale regeneration is coalesced");

  const headOnlyCache = new FakeCache();
  const headOnly = createHonoPageRenderer({ cache: () => headOnlyCache, now: () => clock });
  const headMiss = await headOnly.fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/vila`, { method: "HEAD" }), env);
  assert.equal(headMiss.status, 200);
  assert.equal(await headMiss.text(), "");
  assert.equal(headOnlyCache.puts, 0, "HEAD-only miss does not populate Cache API");

  const writeFailureCache = new FakeCache();
  writeFailureCache.failPut = true;
  const writeFailureApp = createHonoPageRenderer({ cache: () => writeFailureCache, now: () => clock });
  assert.equal((await html(writeFailureApp, "/wetbulb-temperature/andorra/encamp/vila", env)).response.status, 200, "cache write failure cannot break rendering");
  const readFailureCache = new FakeCache();
  readFailureCache.failMatch = true;
  const readFailureApp = createHonoPageRenderer({ cache: () => readFailureCache, now: () => clock });
  assert.equal((await html(readFailureApp, "/wetbulb-temperature/andorra/encamp/vila", env)).response.status, 200, "cache read failure cannot break rendering");

  const noCacheBefore = cache.puts;
  for (const pathname of ["/api/weather?lat=1&lon=2", "/not-a-real-page", "/assets/app.css", "/locations/route-manifest.json"]) {
    await app.fetch(new Request(`${base}${pathname}`), env);
  }
  assert.equal(cache.puts, noCacheBefore, "API, 404, static, and metadata routes are never cached");
  assert.equal(providerCalls, 0);

  const bad = { ...await cache.entries.get(cacheKey).clone().json(), schema: 0 };
  cache.entries.set(cacheKey, Response.json(bad));
  const corrupted = await html(app, "/wetbulb-temperature/andorra/encamp/vila", env);
  assert.equal(corrupted.response.status, 200, "corrupt internal envelope is not served and rendering continues");
  assert.equal(corrupted.body, first.body);

  const versionBefore = cache.puts;
  await html(app, "/wetbulb-temperature/andorra/encamp/vila", { ...env, HTML_CACHE_TEST_VERSION: "deployment-b" });
  assert.equal(cache.puts, versionBefore + 1, "deployment version changes the namespace");

  const expired = new FakeCache();
  expired.entries.set(cacheKey, Response.json({ ...envelope, staleUntil: clock - 1 }));
  const failingAssets = { async fetch() { return new Response("metadata unavailable", { status: 500 }); } };
  const failedApp = createHonoPageRenderer({ cache: () => expired, now: () => clock });
  const failure = await failedApp.fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/vila`), { ...env, ASSETS: failingAssets });
  assert.notEqual(failure.status, 200, "expired cache plus metadata failure never becomes an empty success");

  const staleFallback = new FakeCache();
  staleFallback.entries.set(cacheKey, Response.json({
    ...envelope,
    storedAt: clock - 1 - 24 * 60 * 60 * 1_000,
    freshUntil: clock - 1,
    staleUntil: clock - 1 + 7 * 24 * 60 * 60 * 1_000,
  }));
  const fallbackApp = createHonoPageRenderer({ cache: () => staleFallback, now: () => clock, cacheVersion: (environment) => environment.HTML_CACHE_TEST_VERSION });
  const fallback = await fallbackApp.fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/vila`), { ...env, ASSETS: failingAssets }, { waitUntil() {} });
  assert.equal(fallback.status, 200);
  assert.equal(await fallback.text(), first.body, "unexpired stale survives metadata/render failure");
});

test("HTML cache uses Worker version metadata, rejects ambiguous namespaces, and coalesces cold GET misses", async () => {
  const cache = new FakeCache();
  const env = { ASSETS: fixtureBinding(), CF_VERSION_METADATA: { id: "cloudflare-version-a" } };
  const app = createHonoPageRenderer({ cache: () => cache, now: () => 1_000 });
  const [first, second] = await Promise.all([
    html(app, "/wetbulb-temperature/andorra/encamp/vila?first=1", env),
    html(app, "/wetbulb-temperature/andorra/encamp/vila/?second=1", env),
  ]);
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(cache.puts, 1, "concurrent same-key cold GET misses render and write once");
  const cacheKey = [...cache.entries.keys()][0];
  assert.match(cacheKey, /cloudflare-version-a\/wetbulb-temperature\/andorra\/encamp\/vila$/);
  assert.equal(first.response.headers.get("content-disposition"), 'inline; filename="vila"');
  const cached = await app.fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/vila`), env);
  const cachedHead = await app.fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/vila`, { method: "HEAD" }), env);
  assert.equal(cached.headers.get("content-disposition"), 'inline; filename="vila"');
  assert.deepEqual([...cachedHead.headers].sort(), [...cached.headers].sort(), "cache-hit HEAD preserves delivery headers");
  assert.equal(await cachedHead.text(), "");

  const deadlineCache = new FakeCache();
  const malformedDeadline = await cache.entries.get(cacheKey).clone().json();
  deadlineCache.entries.set(cacheKey, Response.json({ ...malformedDeadline, staleUntil: malformedDeadline.staleUntil + 1 }));
  const noServePastDeadline = createHonoPageRenderer({ cache: () => deadlineCache, now: () => 1_000 });
  const expiredByContract = await noServePastDeadline.fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/vila`), { CF_VERSION_METADATA: { id: "cloudflare-version-a" }, ASSETS: { async fetch() { return new Response("missing", { status: 404 }); } } });
  assert.equal(expiredByContract.status, 500, "an envelope with an extended stale deadline is not served or converted to a 404");

  const noIdentityCache = new FakeCache();
  const noIdentity = createHonoPageRenderer({ cache: () => noIdentityCache, now: () => 1_000 });
  const uncached = await html(noIdentity, "/wetbulb-temperature/andorra/encamp/vila", { ASSETS: fixtureBinding(), HTML_CACHE_VERSION: "old-shared-production-namespace" });
  assert.equal(uncached.response.status, 200, "missing deployment identity still renders");
  assert.equal(noIdentityCache.puts, 0, "never cache under a shared fallback production namespace");

  const injectedCache = new FakeCache();
  const unitOnly = createHonoPageRenderer({ cache: () => injectedCache, now: () => 1_000, cacheVersion: () => "unit-deterministic" });
  await html(unitOnly, "/wetbulb-temperature/andorra/encamp/vila", { ASSETS: fixtureBinding() });
  assert.equal(injectedCache.puts, 1, "tests may explicitly inject a deterministic cache identity");
});

test("manifest failures are retried by the same renderer instance", async () => {
  for (const failedResponse of [() => new Response("unavailable", { status: 503 }), () => new Response("not JSON"), () => Response.json({ v: 0 })]) {
    let reads = 0;
    const fixtures = fixtureBinding();
    const env = { ASSETS: { async fetch(request) { return ++reads === 1 ? failedResponse() : fixtures.fetch(request); } } };
    const app = createHonoPageRenderer();
    assert.equal((await app.fetch(new Request(`${base}/wetbulb-temperature/andorra`), env)).status, 500);
    assert.equal((await app.fetch(new Request(`${base}/wetbulb-temperature/andorra`), env)).status, 200);
    assert.equal(reads, 2);
  }
});

test("renderer fails closed for internal metadata failures but retains negotiated public 404s", async () => {
  const app = createHonoPageRenderer();
  const metadataFailure = async () => new Response("upstream details must not reach clients", { status: 503 });
  const malformedManifest = async () => Response.json({ v: 1, countries: [{ countrySlug: "andorra" }] });
  const malformedShard = async (request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/locations/route-manifest.json") return Response.json({
      v: 1, countries: [{ country: "Andorra", countrySlug: "andorra", file: "andorra.json", states: [{ name: "Encamp", slug: "encamp" }] }],
    });
    return Response.json({ v: 1, r: "not-an-array" });
  };
  for (const assets of [{ fetch: metadataFailure }, { fetch: malformedManifest }, { fetch: malformedShard }]) {
    const response = await app.fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/vila`, { headers: { accept: "application/json" } }), { ASSETS: assets });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.ok(body.length > 0);
    assert.doesNotMatch(body, /upstream details|at file:|stack trace/i);
  }
  const unknown = await app.fetch(new Request(`${base}/wetbulb-temperature/nope`, { headers: { accept: "application/json" } }), { ASSETS: fixtureBinding() });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: { code: "404", message: "The page could not be found" } });
});

test("HTML cache never converts internal regeneration failures into 404 and releases rejected coalescing", async () => {
  let clock = 1_000;
  const cache = new FakeCache();
  let fail = true;
  const assets = { async fetch(request) {
    if (fail) return new Response("metadata outage", { status: 503 });
    return fixtureBinding().fetch(request);
  }};
  const env = { ASSETS: assets, CF_VERSION_METADATA: { id: "outage-test" }, OBSERVABILITY_DISABLED: "true" };
  const app = createHonoPageRenderer({ cache: () => cache, now: () => clock });
  const cold = await app.fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/vila`), env);
  assert.equal(cold.status, 500);
  assert.ok((await cold.text()).length > 0);
  fail = false;
  const recovered = await app.fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/vila`), env);
  assert.equal(recovered.status, 200, "a rejected same-key regeneration cannot poison later requests");

  const [key, stored] = [...cache.entries][0];
  const envelope = await stored.clone().json();
  clock = envelope.freshUntil + 1;
  fail = true;
  const waits = [];
  const stale = await app.fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/vila`), env, { waitUntil(promise) { waits.push(promise); } });
  assert.equal(stale.status, 200);
  assert.equal(await stale.text(), envelope.html);
  await Promise.all(waits);
  assert.equal((await cache.entries.get(key).clone().json()).html, envelope.html, "failed stale regeneration cannot overwrite usable stale HTML");

  const expired = new FakeCache();
  expired.entries.set(key, Response.json({ ...envelope, staleUntil: clock - 1 }));
  const corrupt = new FakeCache();
  corrupt.entries.set(key, Response.json({ ...envelope, schema: 0 }));
  for (const failingCache of [expired, corrupt]) {
    const response = await createHonoPageRenderer({ cache: () => failingCache, now: () => clock }).fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/vila`), env);
    assert.equal(response.status, 500, "expired or corrupt cache must not mask an internal failure");
    assert.ok((await response.text()).length > 0);
  }
});

test("public ASSETS failures remain failures and preserve GET/HEAD semantics", async () => {
  const app = createHonoPageRenderer();
  const assets = { async fetch() { return new Response("asset backend unavailable", { status: 503, headers: { "content-type": "text/plain" } }); } };
  const get = await app.fetch(new Request(`${base}/favicon.svg`), { ASSETS: assets });
  const head = await app.fetch(new Request(`${base}/favicon.svg`, { method: "HEAD" }), { ASSETS: assets });
  assert.equal(get.status, 503);
  assert.equal(await get.text(), "Service Unavailable\n");
  assert.equal(get.headers.get("cache-control"), "no-store");
  assert.equal(head.status, 503);
  assert.equal(await head.text(), "");
  assert.deepEqual([...head.headers].sort(), [...get.headers].sort());

  const thrown = await app.fetch(new Request(`${base}/favicon.svg`), { ASSETS: { async fetch() { throw new Error("private backend detail"); } } });
  assert.equal(thrown.status, 500);
  assert.equal(await thrown.text(), "Internal Server Error\n");
  assert.equal(thrown.headers.get("cache-control"), "no-store");

  const forbidden = await app.fetch(new Request(`${base}/favicon.svg`), { ASSETS: { async fetch() { return new Response("forbidden", { status: 403 }); } } });
  assert.equal(forbidden.status, 403, "non-404 public asset responses retain their status");
  assert.equal(await forbidden.text(), "forbidden");

  const notModified = await app.fetch(new Request(`${base}/favicon.svg`), { ASSETS: { async fetch() { return new Response(null, { status: 304, headers: { etag: "asset-etag" } }); } } });
  assert.equal(notModified.status, 304, "conditional public asset responses are not converted to 404");
  assert.equal(notModified.headers.get("etag"), "asset-etag");
});

test("Hono renderer preserves delivery headers, negotiated 404s, HEAD, and private metadata", async () => {
  const app = createHonoPageRenderer();
  const env = { ASSETS: fixtureBinding() };
  const slashless = await html(app, "/wetbulb-temperature/andorra/encamp/vila", env);
  assert.match(slashless.body, /https:\/\/www\.wetbulb35\.com\/wetbulb-temperature\/andorra\/encamp\/vila\//);
  assert.equal(slashless.response.headers.get("strict-transport-security"), "max-age=63072000");
  assert.equal(slashless.response.headers.get("access-control-allow-origin"), "*");
  assert.equal(slashless.response.headers.get("content-disposition"), 'inline; filename="vila"');
  const root = await html(app, "/", env);
  assert.equal(root.response.headers.get("content-disposition"), "inline");

  const assetEnv = { ASSETS: { async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/favicon.svg") return new Response("<svg/>", { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=0, must-revalidate", etag: "asset-etag" } });
    if (pathname === "/sitemap.xml") return new Response("<urlset/>", { headers: { "content-type": "application/xml", "cache-control": "public, max-age=14400, must-revalidate" } });
    if (pathname === "/robots.txt") return new Response("User-agent: *", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" } });
    if (pathname === "/assets/locations.json") return new Response("[]", { headers: { "content-type": "application/json", "cache-control": "public, max-age=14400, must-revalidate" } });
    return new Response("missing", { status: 404 });
  } } };
  for (const [pathname, disposition] of [["/favicon.svg", 'inline; filename="favicon.svg"'], ["/sitemap.xml", 'inline; filename="sitemap.xml"'], ["/robots.txt", null], ["/assets/locations.json", 'inline; filename="locations.json"']]) {
    const response = await app.fetch(new Request(`${base}${pathname}`), assetEnv);
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get("cache-control"), pathname === "/sitemap.xml" || pathname === "/assets/locations.json" ? "public, max-age=0, must-revalidate" : "public, max-age=14400, must-revalidate");
    assert.equal(response.headers.get("etag"), pathname === "/favicon.svg" ? "asset-etag" : null);
    assert.equal(response.headers.get("strict-transport-security"), "max-age=63072000");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("content-disposition"), disposition);
  }

  for (const [accept, contentType, expected] of [
    ["text/html", "text/html; charset=UTF-8", /<title>404: NOT_FOUND<\/title>/],
    ["application/json", "application/json", { error: { code: "404", message: "The page could not be found" } }],
    ["text/plain", "text/plain; charset=UTF-8", "The page could not be found\n\nNOT_FOUND\n"],
  ]) {
    const response = await app.fetch(new Request(`${base}/not-a-real-page`, { headers: { accept } }), env);
    assert.equal(response.status, 404, accept);
    assert.equal(response.headers.get("content-type"), contentType, accept);
    assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate", accept);
    assert.equal(response.headers.get("strict-transport-security"), "max-age=63072000", accept);
    assert.equal(response.headers.get("access-control-allow-origin"), null, accept);
    const body = await response.text();
    if (expected instanceof RegExp) assert.match(body, expected); else if (typeof expected === "string") assert.equal(body, expected); else assert.deepEqual(JSON.parse(body), expected);
  }
  for (const [accept, contentType] of [
    ["text/html,application/json;q=0.9,text/plain;q=0.8", "text/html; charset=UTF-8"],
    ["text/html;q=0.5,application/json;q=0.9,text/plain;q=0.8", "application/json"],
    ["application/json;q=0,text/html;q=0.8,*/*;q=0.1", "text/html; charset=UTF-8"],
    ["text/*;q=0.7,application/json;q=0.7", "application/json"],
    ["*/*", "text/plain; charset=UTF-8"],
  ]) {
    const response = await app.fetch(new Request(`${base}/not-a-real-page`, { headers: { accept } }), env);
    assert.equal(response.headers.get("content-type"), contentType, accept);
  }

  const htmlGet = await app.fetch(new Request(`${base}/wetbulb-temperature/andorra`), env);
  const head = await app.fetch(new Request(`${base}/wetbulb-temperature/andorra`, { method: "HEAD" }), env);
  assert.equal(head.status, htmlGet.status);
  assert.deepEqual([...head.headers].sort(), [...htmlGet.headers].sort());
  assert.equal(await head.text(), "");
  const assetGet = await app.fetch(new Request(`${base}/favicon.svg`), assetEnv);
  const assetHead = await app.fetch(new Request(`${base}/favicon.svg`, { method: "HEAD" }), assetEnv);
  assert.equal(assetHead.status, assetGet.status);
  assert.deepEqual([...assetHead.headers].sort(), [...assetGet.headers].sort());
  assert.equal(await assetHead.text(), "");
  const notFoundGet = await app.fetch(new Request(`${base}/not-a-real-page`, { headers: { accept: "application/json" } }), env);
  const notFoundHead = await app.fetch(new Request(`${base}/not-a-real-page`, { method: "HEAD", headers: { accept: "application/json" } }), env);
  assert.equal(notFoundHead.status, notFoundGet.status);
  assert.deepEqual([...notFoundHead.headers].sort(), [...notFoundGet.headers].sort());
  assert.equal(await notFoundHead.text(), "");

  const api = await app.fetch(new Request(`${base}/api/weather?lat=1&lon=2`), { ...env, OBSERVABILITY_DISABLED: "true" });
  assert.equal(api.headers.get("access-control-allow-origin"), null, "weather remains outside the characterized CORS contract");
  for (const pathname of ["/about", "/wetbulb-temperature/nope", "/locations/route-manifest.json", "/locations/shards/andorra.json"]) {
    const response = await app.fetch(new Request(`${base}${pathname}`, { headers: { accept: "text/html" } }), env);
    assert.equal(response.status, 404, pathname);
    assert.equal(response.headers.get("content-type"), "text/html; charset=UTF-8", pathname);
  }
});

test("renderer asset build exposes only public browser assets and preserves index", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "hono-renderer-assets-"));
  try {
    const result = buildHonoRendererAssets({ sourceCities: fixtureCities, outDir, placesApiKey: "", publicDir: path.join(root, "public") });
    assert.equal(result.rows, 3);
    for (const relative of ["assets/app.css", "assets/app.js", "assets/locations.json", "favicon.svg", "logo.svg", "images/wetbulb-default.jpg", "locations/route-manifest.json"]) {
      assert.ok(fs.existsSync(path.join(outDir, relative)), relative);
    }
    const index = JSON.parse(fs.readFileSync(path.join(outDir, "assets/locations.json"), "utf8"));
    assert.equal(index.length, 3);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

test("all generated city routes resolve from metadata shards without static HTML inventory", { timeout: 120_000 }, async () => {
  const sourceCities = JSON.parse(fs.readFileSync(path.join(root, "scripts/resolved_cities.json"), "utf8"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "hono-renderer-inventory-"));
  try {
    buildHonoRendererAssets({ sourceCities, outDir, placesApiKey: "", publicDir: path.join(root, "public") });
    const assetBinding = { async fetch(request) {
      const diskPath = path.join(outDir, new URL(request.url).pathname);
      return fs.existsSync(diskPath) ? new Response(fs.readFileSync(diskPath)) : new Response("missing", { status: 404 });
    }};
    const resolve = createLocationResolver();
    const siteData = createSiteData(sourceCities);
    assert.equal(siteData.cities.length, 130684);
    for (const city of siteData.cities) {
      const { countrySlug, stateSlug, citySlug } = getRouteParts(city);
      const parts = ["wetbulb-temperature", countrySlug, stateSlug, citySlug];
      const result = await resolve(new Request(`${base}/${parts.join("/")}`), assetBinding, parts);
      assert.equal(result?.kind, "city", parts.join("/"));
      assert.equal(result.city.outputCitySlug, city.outputCitySlug);
    }
    assert.equal([...fs.readdirSync(outDir, { recursive: true })].filter((file) => String(file).endsWith(".html")).length, 0);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

test("Wrangler serves renderer pages and public assets while hiding metadata", { timeout: 30_000 }, async (t) => {
  attachDetachedCleanup(t);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hono-renderer-wrangler-"));
  const assetDir = path.join(tempDir, "served-assets");
  const browserFixtureDir = path.join(tempDir, "browser-public");
  const configPath = path.join(tempDir, "wrangler.toml");
  let child;
  try {
    writeBrowserFixture(browserFixtureDir);
    buildHonoRendererAssets({ sourceCities: fixtureCities, outDir: assetDir, publicDir: browserFixtureDir });
    fs.writeFileSync(configPath, [
      'name = "wetbulb35-hono-renderer-local-test"',
      `main = ${JSON.stringify(path.join(root, "workers/hono-page-renderer.mjs"))}`,
      'compatibility_date = "2026-09-08"',
      "[assets]",
      `directory = ${JSON.stringify(assetDir)}`,
      'binding = "ASSETS"',
      "run_worker_first = true",
      "[version_metadata]",
      'binding = "CF_VERSION_METADATA"',
      '[vars]',
      'CANONICAL_ORIGIN = "https://www.wetbulb35.com"',
      'GOOGLE_ANALYTICS_ID = "G-LNPWV0JL7S"',
      'OBSERVABILITY_DISABLED = "true"',
      "",
    ].join("\n"));
    const port = await reservePort();
    const started = await startWrangler(configPath, port, (spawned) => { child = spawned; });
    t.diagnostic(`Wrangler renderer readiness (spawn to first 404): ${started.startupMs} ms`);
    const city = await localFetch(port, "/wetbulb-temperature/andorra/encamp/vila");
    assert.equal(city.status, 200);
    assert.equal(city.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    const cityHtml = await city.text();
    assert.match(cityHtml, /<link rel="canonical" href="https:\/\/www\.wetbulb35\.com\/wetbulb-temperature\/andorra\/encamp\/vila\/">/);
    const repeated = await localFetch(port, "/wetbulb-temperature/andorra/encamp/vila/?query=ignored");
    assert.equal(repeated.status, 200);
    assert.equal(repeated.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assert.equal(await repeated.text(), cityHtml, "repeated GET preserves query/slash parity browser behavior");
    const cityHead = await localFetch(port, "/wetbulb-temperature/andorra/encamp/vila?head=1", { method: "HEAD" });
    assert.equal(cityHead.status, 200);
    assert.equal(cityHead.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assert.equal(await cityHead.text(), "");
    const weather = await localFetch(port, "/api/weather?lat=1&lon=2");
    assert.equal(weather.status, 500, "local integration has no provider secret and fails closed");
    assert.deepEqual(await weather.json(), { error: "Failed to refresh weather data." });
    for (const pathname of ["/assets/app.css", "/assets/app.js", "/assets/locations.json", "/favicon.svg", "/logo.svg", "/images/wetbulb-default.jpg"]) {
      const response = await localFetch(port, pathname);
      assert.equal(response.status, 200, pathname);
      assert.ok((await response.arrayBuffer()).byteLength > 0, pathname);
    }
    for (const pathname of ["/locations/route-manifest.json", "/locations/shards/andorra.json", "/not-a-real-page"]) {
      assert.equal((await localFetch(port, pathname)).status, 404, pathname);
    }
  } finally {
    await stopDetached(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
