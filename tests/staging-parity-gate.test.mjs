import assert from "node:assert/strict";
import test from "node:test";
import { IGNORED_HEADERS, htmlSemanticFields, request } from "../scripts/staging-parity-gate.mjs";

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
});

test("parity request helper refuses all weather API paths before networking", async () => {
  await assert.rejects(request("https://www.wetbulb35.com", "/api/weather?lat=1&lon=2"), /forbidden/);
});
