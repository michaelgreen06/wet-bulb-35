import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLegacyRedirectArtifact, validateLegacyRedirectArtifact } from "../scripts/generate-legacy-city-route-redirects.mjs";
import { buildHonoRendererAssets } from "../scripts/build-hono-renderer-assets.mjs";
import { createHonoPageRenderer } from "../workers/hono-page-renderer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = path.join(root, "scripts/legacy-city-route-redirects.v1.json");

test("committed legacy city redirect artifact is immutable, complete, and destination-safe", () => {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const currentCities = JSON.parse(fs.readFileSync(path.join(root, "scripts/resolved_cities.json"), "utf8"));
  const result = validateLegacyRedirectArtifact({ artifact, currentCities });
  assert.deepEqual(result.counts, {
    historicalRows: 130684,
    historicalUniquePaths: 129089,
    invalidPaths: 1,
    collisionGroups: 1419,
    overlapPaths: 8,
    aliases: 129080,
  });
  assert.equal(result.destinationFailures.length, 0);
  assert.equal(result.currentConflicts.length, 0);
  assert.equal(result.collisionWinnerFailures.length, 0);
  const aliases = new Map(artifact.aliases);
  assert.equal(aliases.get("/wetbulb-temperature/houston/texas/united-states"), "/wetbulb-temperature/united-states/texas/houston/");
  assert.equal(aliases.get("/wetbulb-temperature/metsamor/armavir/armenia"), "/wetbulb-temperature/armenia/armavir/metsamor-40-0723-44-2917/");
  assert.equal(aliases.get("/wetbulb-temperature/shabiyyat/sharjah/united-arab-emirates"), "/wetbulb-temperature/united-arab-emirates/sharjah/shabiyyat-milehah/");
  assert.deepEqual(artifact.invalidPaths, ["/wetbulb-temperature//chucher-sandevo/north-macedonia"]);
  assert.ok(artifact.overlaps.some(([alias]) => alias === "/wetbulb-temperature/djibouti/djibouti/djibouti"));
});

test("full artifact regenerates byte-for-byte from the pinned historical Git object", { timeout: 120_000 }, (t) => {
  try { execFileSync("git", ["cat-file", "-e", "b83b6f33d3a1b2bb00551af3bd2f916c276c90c9^{commit}"], { cwd: root }); }
  catch { t.skip("pinned historical commit is unavailable in this shallow checkout"); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-regeneration-"));
  const out = path.join(directory, "artifact.json");
  try {
    execFileSync(process.execPath, [path.join(root, "scripts/generate-legacy-city-route-redirects.mjs")], {
      cwd: root, env: { ...process.env, LEGACY_REDIRECT_ARTIFACT: out }, stdio: "pipe",
    });
    assert.equal(fs.readFileSync(out, "utf8"), fs.readFileSync(artifactPath, "utf8"));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("legacy artifact generation is deterministic and preserves the historical first-row winner", () => {
  const historicalCities = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/legacy-city-route-historical-sample.json"), "utf8"));
  const currentCities = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/legacy-city-route-current-sample.json"), "utf8"));
  const first = createLegacyRedirectArtifact({ historicalCities, currentCities, historicalCommit: "fixture" });
  const second = createLegacyRedirectArtifact({ historicalCities, currentCities, historicalCommit: "fixture" });
  assert.deepEqual(first, second);
  assert.deepEqual(first.aliases, [["/wetbulb-temperature/other/region/example", "/wetbulb-temperature/example/region/other/"], ["/wetbulb-temperature/same/region/example", "/wetbulb-temperature/example/region/same-1-0000-2-0000/"]]);
});

test("artifact validation fails closed when provenance, schema, or destinations change", () => {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const currentCities = JSON.parse(fs.readFileSync(path.join(root, "scripts/resolved_cities.json"), "utf8"));
  for (const mutate of [
    (value) => { value.v = 2; },
    (value) => { value.provenance.historicalCommit = "untrusted"; },
    (value) => { value.aliases[0][1] = "/wetbulb-temperature/no/such/route/"; },
  ]) {
    const copy = structuredClone(artifact);
    mutate(copy);
    assert.throws(() => validateLegacyRedirectArtifact({ artifact: copy, currentCities }));
  }
});

test("built private legacy shards redirect exact aliases but retain current-route precedence and sitemap boundaries", { timeout: 120_000 }, async () => {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const currentCities = JSON.parse(fs.readFileSync(path.join(root, "scripts/resolved_cities.json"), "utf8"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-city-redirects-"));
  try {
    buildHonoRendererAssets({ sourceCities: currentCities, outDir, publicDir: path.join(root, "public") });
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "locations/route-manifest.json"), "utf8"));
    assert.ok(manifest.legacyRedirects.files.length > 200);
    const builtAliases = [];
    for (const [, file] of manifest.legacyRedirects.files) {
      const shardPath = path.join(outDir, "locations/legacy-shards", file);
      assert.ok(fs.statSync(shardPath).size < 25 * 1024 * 1024);
      builtAliases.push(...JSON.parse(fs.readFileSync(shardPath, "utf8")).a);
    }
    builtAliases.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(builtAliases, artifact.aliases);
    const assets = { async fetch(request) {
      const pathname = new URL(request.url).pathname;
      const diskPath = path.join(outDir, pathname);
      return diskPath.startsWith(outDir) && fs.existsSync(diskPath) ? new Response(fs.readFileSync(diskPath)) : new Response("missing", { status: 404 });
    }};
    const app = createHonoPageRenderer();
    const [alias, target] = artifact.aliases.find(([pathname]) => !pathname.includes("//"));
    for (const method of ["GET", "HEAD"]) {
      const response = await app.fetch(new Request(`https://renderer.test${alias}?keep=1`, { method }), { ASSETS: assets });
      assert.equal(response.status, 308);
      assert.equal(response.headers.get("location"), `https://renderer.test${target}?keep=1`);
      assert.equal(await response.text(), "");
    }
    for (const source of ["/wetbulb-temperature/houston/texas/united-states", "/wetbulb-temperature/metsamor/armavir/armenia", "/wetbulb-temperature/shabiyyat/sharjah/united-arab-emirates"]) {
      const response = await app.fetch(new Request(`https://renderer.test${source}`), { ASSETS: assets });
      assert.equal(response.status, 308, source);
      assert.equal(response.headers.get("location"), `https://renderer.test${new Map(artifact.aliases).get(source)}`, source);
    }
    const [overlap] = artifact.overlaps;
    const current = await app.fetch(new Request(`https://renderer.test${overlap[0]}`), { ASSETS: assets });
    assert.equal(current.status, 308, "current slashless route wins before any historical alias");
    assert.equal(current.headers.get("location"), `https://renderer.test${overlap[0]}/`);
    for (const source of ["/sitemap-index.xml", "/api/sitemap-index.xml"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await app.fetch(new Request(`https://renderer.test${source}?q=1`, { method }), { ASSETS: assets });
        assert.equal(response.status, 308);
        assert.equal(response.headers.get("location"), "https://renderer.test/sitemap.xml?q=1");
        assert.equal(await response.text(), "");
      }
    }
    const actualLegacyShard = manifest.legacyRedirects.files[0][1];
    for (const pathname of ["/sitemap-locations-1.xml", "/wetbulb-temperature//chucher-sandevo/north-macedonia",
      "/locations/route-manifest.json", `/locations/legacy-shards/${actualLegacyShard}`, "/locations/legacy-shards/not-real.json"]) {
      const response = await app.fetch(new Request(`https://renderer.test${pathname}`), { ASSETS: assets });
      assert.equal(response.status, 404, pathname);
    }

    const country = artifact.aliases[0][0].split("/")[4];
    const sameCountryAliases = artifact.aliases.filter(([pathname]) => pathname.split("/")[4] === country).slice(0, 2);
    assert.equal(sameCountryAliases.length, 2);
    const countryFile = manifest.legacyRedirects.files.find(([slug]) => slug === country)[1];
    let legacyShardReads = 0;
    const countingAssets = { async fetch(request) {
      if (new URL(request.url).pathname === `/locations/legacy-shards/${countryFile}`) legacyShardReads += 1;
      return assets.fetch(request);
    }};
    const coalescingApp = createHonoPageRenderer();
    const concurrent = await Promise.all(sameCountryAliases.map(([pathname]) => coalescingApp.fetch(new Request(`https://renderer.test${pathname}`), { ASSETS: countingAssets })));
    assert.deepEqual(concurrent.map((response) => response.status), [308, 308]);
    assert.equal(legacyShardReads, 1, "concurrent aliases coalesce one private-shard read");

    const malformedManifestAssets = { async fetch(request) {
      if (new URL(request.url).pathname === "/locations/route-manifest.json") {
        return new Response(JSON.stringify({ ...manifest, legacyRedirects: { ...manifest.legacyRedirects, v: 2 } }));
      }
      return assets.fetch(request);
    }};
    const malformed = await createHonoPageRenderer().fetch(new Request(`https://renderer.test${artifact.aliases[0][0]}`), { ASSETS: malformedManifestAssets });
    assert.equal(malformed.status, 500, "malformed redirect metadata fails closed");
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});
