import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import { COMPARED_HEADERS, EXPECTED_ZONE_MANAGED_DIFFERENCES, IGNORED_HEADERS, INTERNAL_HTML_CACHE_POLICY, comparableBody, compareRoute, htmlSemanticFields, normalizeContentType, request, runGate } from "../scripts/staging-parity-gate.mjs";

test("parity semantic extraction preserves SEO, links, assets, JSON-LD, and widget coordinates", () => {
  const fields = htmlSemanticFields(`<!doctype html><title>Example</title>
    <meta name="description" content="Description"><meta name="robots" content="index, follow">
    <meta property="og:title" content="Example"><meta property="og:url" content="https://www.wetbulb35.com/example/">
    <link rel="canonical" href="https://www.wetbulb35.com/example/"><link rel="stylesheet" href="/assets/app.css">
    <a href="/wetbulb-temperature/andorra/">Andorra</a><div data-lat="42.5" data-lon="1.5"></div>
    <script type="application/ld+json">{"z":1,"a":{"b":2}}</script><script src="/assets/app.js" defer></script>`);
  assert.equal(fields.title, "Example");
  assert.equal(fields.description, "Description");
  assert.equal(fields.canonical, "https://www.wetbulb35.com/example/");
  assert.equal(fields.og["og:title"], "Example");
  assert.deepEqual(fields.jsonLd, [{ a: { b: 2 }, z: 1 }]);
  assert.deepEqual(fields.links, ["/wetbulb-temperature/andorra/"]);
  assert.deepEqual(fields.widgetCoordinates, ["1.5", "42.5"]);
  assert.deepEqual(fields.publicAssetReferences, ["/assets/app.css", "/assets/app.js"]);
});

test("parity rejects missing runtime scripts and changed browser asset contents", () => {
  const sample = (body) => ({ status: 200, contentType: "text/html", headers: {}, body, latencyMs: 1 });
  const html = '<title>Home</title><script src="/assets/app.js" defer></script>';
  assert.equal(compareRoute(["home", "/", "html"], sample(html), sample('<title>Home</title>')).pass, false);
  for (const [name, pathname, body] of [
    ["browser-css", "/assets/app.css", ".sr-only{position:absolute}"],
    ["browser-js", "/assets/app.js", "startWeather()"],
    ["browser-search-index", "/assets/locations.json", '[{"url":"/city/"}]'],
  ]) {
    assert.equal(compareRoute([name, pathname, "asset"], sample(body), sample("")).pass, false);
    assert.equal(compareRoute([name, pathname, "asset"], sample(body), sample(body)).pass, true);
  }
});

test("full parity gate requests browser assets and rejects their byte differences", { timeout: 30_000 }, async () => {
  const requested = [];
  const servers = [];
  const origin = async (changed) => {
    const server = http.createServer((req, res) => {
      requested.push(req.url);
      res.setHeader("content-type", "text/html");
      res.end(req.url.startsWith('/assets/') ? (changed ? 'changed asset' : 'original asset') : '<title>Fixture</title>');
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  try {
    const report = await runGate({ production: await origin(false), staging: await origin(true) });
    for (const name of ['browser-css', 'browser-js', 'browser-search-index']) {
      const record = report.routes.find((route) => route.name === name);
      assert.equal(record.pass, false, name);
      assert.ok(record.differences.includes('bodyHash'));
    }
    assert.equal(requested.some((pathname) => pathname.startsWith('/api/weather')), false);
  } finally { await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))); }
});

test("parity gate documents only delivery-varying headers as ignored", () => {
  for (const header of ["date", "server", "cf-ray", "x-vercel-id", "x-vercel-cache"]) assert.ok(IGNORED_HEADERS.has(header), header);
  assert.equal(IGNORED_HEADERS.has("cache-control"), false);
  assert.ok(IGNORED_HEADERS.has("content-type"), "media type is compared separately from parameters");
  assert.deepEqual(INTERNAL_HTML_CACHE_POLICY, { schema: 1, freshSeconds: 86_400, staleSeconds: 604_800, storageTtlSeconds: 691_200, browserCacheControl: "public, max-age=0, must-revalidate" });
});

test("parity request helper refuses all weather API paths before networking", async () => {
  await assert.rejects(request("https://www.wetbulb35.com", "/api/weather?lat=1&lon=2"), /forbidden/);
});

test("404 comparison retains only the stable negotiated contract", () => {
  assert.equal(COMPARED_HEADERS.includes("x-vercel-error"), false);
  assert.deepEqual(EXPECTED_ZONE_MANAGED_DIFFERENCES, { robots: ["bodyHash"], "browser-css": ["bodyHash"] });
  assert.deepEqual(comparableBody("not-found", '{"error":{"message":"The page could not be found","code":"404"}}'), { error: { code: "404", message: "The page could not be found" } });
  assert.deepEqual(comparableBody("not-found", "{not-json"), { invalidJson: true, nonEmpty: true });
  assert.deepEqual(comparableBody("not-found", '<html><head><title>404: NOT_FOUND</title></head></html>'), { code: true, noindex: false, title: "404: NOT_FOUND", nonEmpty: true });
  assert.deepEqual(comparableBody("not-found", "The page could not be found\n\nNOT_FOUND\n\nrequest-id\n"), { message: true, code: true, nonEmpty: true });
  assert.deepEqual(comparableBody("not-found", ""), { message: false, code: false, nonEmpty: false });
});

test("only the exact Cloudflare managed robots prefix is expected", () => {
  const committed = fs.readFileSync("public/robots.txt", "utf8");
  const base = { status: 200, contentType: "text/plain", headers: {}, latencyMs: 1 };
  const expected = compareRoute(["robots", "/robots.txt", "text"], { ...base, body: `# As a condition of accessing this website, you agree to abide by the following\n# content signals:\nmanaged\n${committed}` }, { ...base, body: committed });
  assert.equal(expected.pass, true);
  assert.deepEqual(expected.expectedDifferences, ["bodyHash"]);
  const defect = compareRoute(["robots", "/robots.txt", "text"], { ...base, body: "wrong" }, { ...base, body: committed });
  assert.equal(defect.pass, false);
  assert.deepEqual(defect.unexpectedDifferences, ["bodyHash"]);
});

test("zone-injected markup and JavaScript media type spelling are not parity differences", () => {
  const fields = htmlSemanticFields(`<a href="/cdn-cgi/l/email-protection">mail</a><a href="/">home</a>
    <script src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script>
    <script defer src="https://static.cloudflareinsights.com/beacon.min.js/v1" data-cf-beacon='{}'></script>
    <script src="/assets/app.js" defer></script>`);
  assert.deepEqual(fields.links, ["/"]);
  assert.deepEqual(fields.publicAssetReferences, ["/assets/app.js"]);
  assert.equal(normalizeContentType("application/javascript; charset=utf-8"), "text/javascript");
  assert.equal(normalizeContentType("text/css"), "text/css");
});

test("only the pending .relative Tailwind rule is an expected CSS difference", () => {
  const base = { status: 200, contentType: "text/css", headers: {}, latencyMs: 1 };
  const production = ".sr-only{position:absolute}.static{position:static}.mx-auto{margin-left:auto}";
  const staging = ".sr-only{position:absolute}.static{position:static}.relative{position:relative}.mx-auto{margin-left:auto}";
  assert.equal(compareRoute(["browser-css", "/assets/app.css", "asset"], { ...base, body: production }, { ...base, body: staging }).pass, true);
  assert.equal(compareRoute(["browser-css", "/assets/app.css", "asset"], { ...base, body: production }, { ...base, body: `${staging}.extra{color:red}` }).pass, false);
  assert.equal(compareRoute(["browser-css", "/assets/app.css", "asset"], { ...base, body: staging }, { ...base, body: `${staging}.relative{position:relative}` }).pass, false);
});
