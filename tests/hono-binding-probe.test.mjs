import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHonoBindingProbe } from "../workers/hono-binding-probe.mjs";
import { buildHonoBindingAssets } from "../scripts/build-hono-binding-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureSource = path.join(root, "tests/fixtures/hono-binding-cities.json");
const fixtureAssets = path.join(root, "tests/fixtures/hono-binding-assets");
const base = "http://probe.local";
const recognized = [
  "/wetbulb-temperature/andorra",
  "/wetbulb-temperature/andorra/encamp",
  "/wetbulb-temperature/andorra/encamp/vila",
  "/wetbulb-temperature/armenia/armavir/metsamor-40-0723-44-2917",
  "/wetbulb-temperature/armenia/armavir/metsamor-40-1445-44-1167",
];

function canonical(pathname, origin = base) {
  return `${origin}${pathname}/`;
}

function fixtureAssetBinding(requestedPaths = []) {
  return {
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      requestedPaths.push(pathname);
      const diskPath = path.join(fixtureAssets, pathname);
      if (!diskPath.startsWith(fixtureAssets) || !fs.existsSync(diskPath)) return new Response("missing", { status: 404 });
      return new Response(fs.readFileSync(diskPath), { status: 200 });
    },
  };
}

async function assertRecognized(fetcher, origin = base) {
  for (const route of recognized) {
    for (const pathname of [route, `${route}/`]) {
      const response = await fetcher(pathname);
      assert.equal(response.status, 200, pathname);
      assert.equal(response.headers.get("content-type"), "text/html; charset=UTF-8", pathname);
      assert.match(await response.text(), new RegExp(`<link rel="canonical" href="${canonical(route, origin)}">`), pathname);
    }
  }
}

async function startWrangler(port) {
  const startedAt = performance.now();
  const child = spawn(path.join(root, "node_modules/.bin/wrangler"), [
    "dev", "--local", "--config", "wrangler.probe-test.toml", "--ip", "127.0.0.1", "--port", String(port),
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`wrangler exited early: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/not-ready`);
      if (response.status === 404) {
        return { child, output: () => output, startupMs: Number((performance.now() - startedAt).toFixed(3)) };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`wrangler did not start: ${output}`);
}

async function stopWrangler(child) {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("binding fixture is generated through production collision identity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hono-binding-assets-"));
  try {
    const sourceCities = JSON.parse(fs.readFileSync(fixtureSource, "utf8"));
    const result = buildHonoBindingAssets({ sourceCities, outDir: directory });
    assert.deepEqual(result, { files: 3, countries: 2, rows: 3, collisionGroups: 1, collisionRows: 2 });
    assert.equal(
      fs.readFileSync(path.join(directory, "locations/shards/armenia.json"), "utf8"),
      fs.readFileSync(path.join(fixtureAssets, "locations/shards/armenia.json"), "utf8"),
    );
    assert.match(fs.readFileSync(path.join(directory, "locations/shards/armenia.json"), "utf8"), /metsamor-40-0723-44-2917/);
    assert.match(fs.readFileSync(path.join(directory, "locations/shards/armenia.json"), "utf8"), /metsamor-40-1445-44-1167/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Hono probe reads ASSETS and never calls a supplied weather provider for HTML", async () => {
  let providerCalls = 0;
  const requestedPaths = [];
  const app = createHonoBindingProbe();
  const env = {
    ASSETS: fixtureAssetBinding(requestedPaths),
    WEATHER_PROVIDER: { fetch() { providerCalls += 1; throw new Error("HTML must not call weather"); } },
  };
  await assertRecognized((pathname) => app.fetch(new Request(`${base}${pathname}`), env));
  const missing = await app.fetch(new Request(`${base}/wetbulb-temperature/andorra/encamp/missing`), env);
  assert.equal(missing.status, 404);
  assert.equal(providerCalls, 0);
  assert.ok(requestedPaths.includes("/locations/route-manifest.json"));
  assert.ok(requestedPaths.includes("/locations/shards/andorra.json"));
  assert.ok(requestedPaths.includes("/locations/shards/armenia.json"));
});

test("Wrangler local Miniflare serves slashful and slashless ASSETS routes", async (t) => {
  const port = 20000 + (process.pid % 10000);
  const { child, startupMs } = await startWrangler(port);
  t.diagnostic(`Wrangler local readiness (spawn to first 404): ${startupMs} ms`);
  try {
    await assertRecognized(
      (pathname) => fetch(`http://127.0.0.1:${port}${pathname}`),
      `http://127.0.0.1:${port}`,
    );
    const missing = await fetch(`http://127.0.0.1:${port}/wetbulb-temperature/andorra/encamp/missing`);
    assert.equal(missing.status, 404);
  } finally {
    await stopWrangler(child);
  }
});
