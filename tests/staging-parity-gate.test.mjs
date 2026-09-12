import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { COMPARED_HEADERS, EXPECTED_ZONE_MANAGED_DIFFERENCES, IGNORED_HEADERS, INTERNAL_HTML_CACHE_POLICY, comparableBody, compareRoute, htmlSemanticFields, request } from "../scripts/staging-parity-gate.mjs";

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
  assert.deepEqual(fields.publicAssetReferences, ["/assets/app.css"]);
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
  assert.deepEqual(EXPECTED_ZONE_MANAGED_DIFFERENCES, { robots: ["bodyHash"] });
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
