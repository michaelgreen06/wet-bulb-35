import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const stopPromises = new WeakMap();

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.removeListener("exit", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    child.once("exit", done);
  });
}

async function stopWrangler(child) {
  if (!child) return;
  if (stopPromises.has(child)) return stopPromises.get(child);
  const stopping = (async () => {
    if (child.exitCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      await waitForExit(child, 5_000);
    }
    if (child.exitCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      await waitForExit(child, 5_000);
    }
    if (child.exitCode === null) throw new Error("Wrangler process group did not terminate");
  })();
  stopPromises.set(child, stopping);
  return stopping;
}

function localFetch(port, pathname) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
  const child = spawn(path.join(root, "node_modules/.bin/wrangler"), [
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
    await stopWrangler(child);
    throw error;
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
  assert.equal(await invalidResolver(request, invalidAssets, partsFor(0)), null);
  assert.equal(await invalidResolver(request, invalidAssets, partsFor(0)), null);
  assert.equal(invalidLoads, 2, "invalid shard data must not be retained");

  let rejectedLoads = 0;
  const rejectedAssets = { async fetch(requestForAsset) {
    const pathname = new URL(requestForAsset.url).pathname;
    if (pathname === "/locations/route-manifest.json") return Response.json({ v: 1, countries: [countries[0]] });
    rejectedLoads += 1;
    throw new Error("asset read failed");
  }};
  const rejectedResolver = createLocationResolver({ maxCachedShards: 8 });
  await assert.rejects(rejectedResolver(request, rejectedAssets, partsFor(0)), /asset read failed/);
  await assert.rejects(rejectedResolver(request, rejectedAssets, partsFor(0)), /asset read failed/);
  assert.equal(rejectedLoads, 2, "rejected shard loads must not be retained");
});

test("Hono renderer has production slash, HEAD, 404, and private-metadata behavior", async () => {
  const app = createHonoPageRenderer();
  const env = { ASSETS: fixtureBinding() };
  const slashless = await html(app, "/wetbulb-temperature/andorra/encamp/vila", env);
  assert.match(slashless.body, /https:\/\/www\.wetbulb35\.com\/wetbulb-temperature\/andorra\/encamp\/vila\//);
  const head = await app.fetch(new Request(`${base}/wetbulb-temperature/andorra`, { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  for (const pathname of ["/about", "/not-a-real-page", "/wetbulb-temperature/nope", "/locations/route-manifest.json", "/locations/shards/andorra.json"]) {
    const response = await app.fetch(new Request(`${base}${pathname}`), env);
    assert.equal(response.status, 404, pathname);
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hono-renderer-wrangler-"));
  const assetDir = path.join(tempDir, "served-assets");
  const browserFixtureDir = path.join(tempDir, "browser-public");
  const configPath = path.join(tempDir, "wrangler.toml");
  let child;
  const abortCleanup = () => { void stopWrangler(child); };
  t.signal.addEventListener("abort", abortCleanup, { once: true });
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
      "[vars]",
      'CANONICAL_ORIGIN = "https://www.wetbulb35.com"',
      'GOOGLE_ANALYTICS_ID = "G-LNPWV0JL7S"',
      "",
    ].join("\n"));
    const port = await reservePort();
    const started = await startWrangler(configPath, port, (spawned) => { child = spawned; });
    t.diagnostic(`Wrangler renderer readiness (spawn to first 404): ${started.startupMs} ms`);
    const city = await localFetch(port, "/wetbulb-temperature/andorra/encamp/vila");
    assert.equal(city.status, 200);
    assert.match(await city.text(), /<link rel="canonical" href="https:\/\/www\.wetbulb35\.com\/wetbulb-temperature\/andorra\/encamp\/vila\/">/);
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
    t.signal.removeEventListener("abort", abortCleanup);
    await stopWrangler(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
