#!/usr/bin/env node
/**
 * Bounded, CLI-first production-to-isolated-staging parity gate.
 * It never requests /api/weather from either origin.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHonoRendererAssets } from "./build-hono-renderer-assets.mjs";
import { createSiteData, getRouteParts, routePathForCity } from "./prototype-static-generator.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PRODUCTION = "https://www.wetbulb35.com";
export const DEFAULT_STAGING = "https://wetbulb35-weather-staging.mgdevstuff.workers.dev";
export const FETCH_TIMEOUT_MS = 15_000;
export const LATENCY_SAMPLES = 3;

// These vary by delivery provider, POP, request, or asset revision and are never compared.
export const IGNORED_HEADERS = new Set([
  "age", "alt-svc", "cf-cache-status", "cf-ray", "connection", "content-encoding",
  "content-length", "content-type", "date", "etag", "last-modified", "nel", "report-to",
  "server", "server-timing", "transfer-encoding", "vary", "via", "x-powered-by",
  "x-vercel-cache", "x-vercel-id", "x-vercel-sc-headers", "x-worker-version",
]);
export const COMPARED_HEADERS = ["access-control-allow-origin", "cache-control", "content-disposition", "strict-transport-security"];
export const EXPECTED_ZONE_MANAGED_DIFFERENCES = Object.freeze({ robots: ["bodyHash"] });
export const INTERNAL_HTML_CACHE_POLICY = Object.freeze({ schema: 1, freshSeconds: 86_400, staleSeconds: 604_800, storageTtlSeconds: 691_200, browserCacheControl: "public, max-age=0, must-revalidate" });

const ROUTES = [
  ["home", "/", "html"],
  ["browse", "/wetbulb-temperature", "html"],
  ["country", "/wetbulb-temperature/andorra", "html"],
  ["state", "/wetbulb-temperature/andorra/encamp", "html"],
  ["unique-city", "/wetbulb-temperature/andorra/encamp/vila", "html"],
  ["colliding-city", "/wetbulb-temperature/armenia/armavir/metsamor-40-0723-44-2917", "html"],
  ["slash", "/wetbulb-temperature/andorra/encamp/vila/", "html"],
  ["slashless", "/wetbulb-temperature/andorra/encamp/vila", "html"],
  ["head", "/wetbulb-temperature/andorra/encamp/vila", "head", "text/html"],
  ["404-html", "/not-a-real-page-9b1e3d", "not-found", "text/html"],
  ["404-json", "/not-a-real-page-9b1e3d", "not-found", "application/json"],
  ["404-plain", "/not-a-real-page-9b1e3d", "not-found", "text/plain"],
  ["robots", "/robots.txt", "text"],
  ["sitemap-index", "/sitemap.xml", "xml"],
  ["sitemap-member", "/sitemaps/sitemap-main.xml", "xml"],
  ["public-asset", "/favicon.svg", "asset"],
  ["browser-css", "/assets/app.css", "asset"],
  ["browser-js", "/assets/app.js", "asset"],
  ["browser-search-index", "/assets/locations.json", "asset"],
];

function arg(name, fallback) {
  const value = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return value ? value.slice(name.length + 3) : fallback;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  return value;
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function attribute(tag, name) {
  if (!tag) return null;
  const match = tag.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}
function tags(html, pattern) { return [...html.matchAll(pattern)].map((match) => match[0]); }
function normalizeFooterYear(html) { return html.replace(/(©|&copy;)\s*20\d{2}/gi, "$1 YEAR"); }
function normalizeContentType(value) { return (value || "").split(";", 1)[0].trim().toLowerCase(); }
function stableHeaders(headers) {
  return Object.fromEntries(COMPARED_HEADERS.map((name) => [name, headers.get(name) || null]));
}
export function htmlSemanticFields(html) {
  const meta = tags(html, /<meta\b[^>]*>/gi);
  const links = tags(html, /<link\b[^>]*>/gi);
  const scripts = tags(html, /<script\b[^>]*>[\s\S]*?<\/script>/gi);
  const named = (name) => attribute(meta.find((tag) => attribute(tag, "name")?.toLowerCase() === name), "content");
  const property = (name) => attribute(meta.find((tag) => attribute(tag, "property")?.toLowerCase() === name), "content");
  const jsonLd = scripts
    .filter((tag) => /type=("|')application\/ld\+json\1/i.test(tag))
    .map((tag) => tag.replace(/^.*?>|<\/script>$/g, ""))
    .map((source) => canonicalJson(JSON.parse(source)));
  const hrefs = links.map((tag) => attribute(tag, "href")).filter(Boolean).sort();
  const scriptSources = scripts.map((tag) => attribute(tag, "src")).filter(Boolean);
  const anchors = tags(html, /<a\b[^>]*>/gi).map((tag) => attribute(tag, "href")).filter(Boolean).sort();
  const coordinates = [...html.matchAll(/\b(?:data-(?:lat|latitude)|lat)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))|\b(?:data-(?:lon|lng|longitude)|lon|lng)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
    .map((match) => match.slice(1).find((value) => value !== undefined)).filter(Boolean).sort();
  return {
    title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || null,
    description: named("description"), canonical: attribute(links.find((tag) => attribute(tag, "rel")?.toLowerCase() === "canonical"), "href"),
    robots: named("robots"), og: Object.fromEntries(["og:title", "og:description", "og:type", "og:url", "og:image", "og:site_name"].map((name) => [name, property(name)])),
    jsonLd, links: anchors, widgetCoordinates: coordinates,
    publicAssetReferences: [...hrefs.filter((href) => href.startsWith("/")), ...scriptSources].sort(),
  };
}
export function comparableBody(kind, body) {
  if (kind === "asset") return { sha256: sha256(body), bytes: Buffer.byteLength(body) };
  if (kind === "html") return htmlSemanticFields(normalizeFooterYear(body));
  if (kind === "not-found") {
    const normalized = normalizeFooterYear(body);
    if (normalized.startsWith("{")) {
      try { return canonicalJson(JSON.parse(normalized)); }
      catch { return { invalidJson: true, nonEmpty: normalized.length > 0 }; }
    }
    if (/<html\b/i.test(normalized)) return {
      code: /NOT_FOUND/.test(normalized),
      noindex: /<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(normalized),
      title: (normalized.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || null,
      nonEmpty: normalized.length > 0,
    };
    return { message: /The page could not be found/.test(normalized), code: /NOT_FOUND/.test(normalized), nonEmpty: normalized.length > 0 };
  }
  return { sha256: sha256(normalizeFooterYear(body)), bytes: Buffer.byteLength(body) };
}
export async function request(base, pathname, method = "GET", accept = "text/html,application/xml,text/plain,*/*;q=0.1") {
  if (pathname.startsWith("/api/weather")) throw new Error("Weather API requests are forbidden by this gate");
  const started = performance.now();
  const response = await fetch(new URL(pathname, base), {
    method, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "wetbulb35-staging-parity-gate/1.0", accept },
  });
  const body = method === "HEAD" ? "" : await response.text();
  return { status: response.status, contentType: normalizeContentType(response.headers.get("content-type")), headers: stableHeaders(response.headers), body, latencyMs: Number((performance.now() - started).toFixed(2)) };
}
function isExpectedZoneManagedDifference(name, difference, production, staging) {
  if (name !== "robots" || difference !== "bodyHash") return false;
  const committedRobots = fs.readFileSync(path.join(root, "public/robots.txt"), "utf8");
  return staging.body === committedRobots
    && production.body.startsWith("# As a condition of accessing this website, you agree to abide by the following\n# content signals:\n")
    && production.body.endsWith(committedRobots);
}
export function compareRoute(route, production, staging) {
  const [name, pathname, kind, accept] = route;
  const differences = [];
  for (const field of ["status", "contentType"]) if (production[field] !== staging[field]) differences.push(field);
  if (JSON.stringify(production.headers) !== JSON.stringify(staging.headers)) differences.push("stableHeaders");
  if (kind !== "head" && JSON.stringify(comparableBody(kind, production.body)) !== JSON.stringify(comparableBody(kind, staging.body))) differences.push(kind === "html" ? "htmlSemanticFields" : kind === "not-found" ? "notFoundContract" : "bodyHash");
  if (kind === "head" && (production.body || staging.body)) differences.push("headBody");
  const expectedDifferences = differences.filter((difference) => EXPECTED_ZONE_MANAGED_DIFFERENCES[name]?.includes(difference) && isExpectedZoneManagedDifference(name, difference, production, staging));
  const unexpectedDifferences = differences.filter((difference) => !expectedDifferences.includes(difference));
  return { name, pathname, kind, accept: accept || null, pass: unexpectedDifferences.length === 0, differences, expectedDifferences, unexpectedDifferences, production: { status: production.status, contentType: production.contentType, headers: production.headers, latencyMs: production.latencyMs }, staging: { status: staging.status, contentType: staging.contentType, headers: staging.headers, latencyMs: staging.latencyMs } };
}
function listFiles(directory) {
  return fs.readdirSync(directory, { recursive: true }).filter((entry) => fs.statSync(path.join(directory, entry)).isFile()).map(String).sort();
}
export function offlineInventory() {
  const cities = JSON.parse(fs.readFileSync(path.join(root, "scripts/resolved_cities.json"), "utf8"));
  const site = createSiteData(cities);
  assert.equal(site.cities.length, 130_684, "city inventory count");
  const cityRoutes = new Set(site.cities.map(routePathForCity));
  assert.equal(cityRoutes.size, 130_684, "city routes must be collision-safe and unique");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wetbulb35-parity-assets-"));
  try {
    buildHonoRendererAssets({ sourceCities: cities, outDir: temp, publicDir: path.join(root, "public") });
    const manifest = JSON.parse(fs.readFileSync(path.join(temp, "locations/route-manifest.json"), "utf8"));
    const manifestCities = manifest.countries.reduce((sum, country) => sum + country.count, 0);
    assert.equal(manifestCities, 130_684, "route manifest count");
    const sourcePublic = listFiles(path.join(root, "public"));
    const builtPublic = listFiles(temp).filter((file) => !file.startsWith("locations/") && !file.startsWith("assets/") || ["assets/app.css", "assets/app.js", "assets/locations.json"].includes(file));
    for (const file of sourcePublic) assert.ok(fs.existsSync(path.join(temp, file)), `missing public asset ${file}`);
    const sitemapIndex = fs.readFileSync(path.join(root, "public/sitemap.xml"), "utf8");
    const sitemapMembers = [...sitemapIndex.matchAll(/<loc>https:\/\/www\.wetbulb35\.com(\/sitemaps\/[^<]+)<\/loc>/g)].map((match) => match[1]);
    assert.ok(sitemapMembers.length > 0, "sitemap index members");
    for (const member of sitemapMembers) assert.ok(fs.existsSync(path.join(root, "public", member)), `missing sitemap ${member}`);
    const robotText = fs.readFileSync(path.join(root, "public/robots.txt"), "utf8");
    assert.match(robotText, /Sitemap: https:\/\/www\.wetbulb35\.com\/sitemap\.xml/);
    return { cityRows: site.cities.length, uniqueCityRoutes: cityRoutes.size, routeManifestCities: manifestCities, publicFiles: sourcePublic.length, builtPublicFiles: builtPublic.length, sitemapMembers: sitemapMembers.length, robotsSitemap: true };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
async function latency(base, pathname) {
  const values = [];
  for (let index = 0; index < LATENCY_SAMPLES; index += 1) values.push((await request(base, pathname)).latencyMs);
  return { samples: values, medianMs: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] };
}
export async function runGate({ production = DEFAULT_PRODUCTION, staging = DEFAULT_STAGING } = {}) {
  const records = [];
  for (const route of ROUTES) {
    const [, pathname, kind, accept] = route;
    const method = kind === "head" ? "HEAD" : "GET";
    const [productionResult, stagingResult] = await Promise.all([request(production, pathname, method, accept), request(staging, pathname, method, accept)]);
    records.push(compareRoute(route, productionResult, stagingResult));
  }
  const result = {
    schema: 1, production, staging, weatherApiRequested: false,
    documentedHeaderNormalization: [...IGNORED_HEADERS].sort(), footerYearNormalized: true,
    internalHtmlCachePolicy: INTERNAL_HTML_CACHE_POLICY,
    routes: records, offlineInventory: offlineInventory(),
    latency: { pathname: "/wetbulb-temperature/andorra/encamp/vila", production: await latency(production, "/wetbulb-temperature/andorra/encamp/vila"), staging: await latency(staging, "/wetbulb-temperature/andorra/encamp/vila") },
  };
  result.summary = { total: records.length, passed: records.filter((record) => record.pass).length, failed: records.filter((record) => !record.pass).length };
  return result;
}
async function main() {
  const production = arg("production", DEFAULT_PRODUCTION).replace(/\/$/, "");
  const staging = arg("staging", DEFAULT_STAGING).replace(/\/$/, "");
  const evidence = arg("evidence", "docs/phase1/evidence/staging-parity-gate.json");
  const result = await runGate({ production, staging });
  fs.mkdirSync(path.dirname(path.resolve(evidence)), { recursive: true });
  fs.writeFileSync(evidence, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ evidence, summary: result.summary, offlineInventory: result.offlineInventory, latency: result.latency }, null, 2));
  if (result.summary.failed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
