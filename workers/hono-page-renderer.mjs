import { Hono } from "hono";
import { pageHtml, renderBrowsePage, renderCountryPage, renderHomePage, renderStatePage } from "../lib/page-renderer.mjs";
import { weatherResponse } from "./weather-edge.mjs";
export { WeatherGate } from "./weather-edge.mjs";

const LOCATION_ROOT = "/locations";
const DEFAULT_CANONICAL_ORIGIN = "https://www.wetbulb35.com";
const DEFAULT_GA_MEASUREMENT_ID = "G-LNPWV0JL7S";
const DEFAULT_MAX_CACHED_SHARDS = 8;
const HTML_CACHE_SCHEMA = 1;
const HTML_CACHE_FRESH_MS = 24 * 60 * 60 * 1_000;
const HTML_CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1_000;
const HTML_CACHE_STORAGE_TTL_SECONDS = (HTML_CACHE_FRESH_MS + HTML_CACHE_STALE_MS) / 1_000;
const HTML_BROWSER_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const DEFAULT_HTML_CACHE_VERSION = "phase1-html-v1";
const htmlRegenerations = new Map();

function assetRequest(request, pathname) { return new Request(new URL(pathname, request.url)); }
async function readAssetJson(request, assets, pathname) {
  const response = await assets.fetch(assetRequest(request, pathname));
  if (!response.ok) return null;
  try { return await response.json(); } catch { return null; }
}
function rendererOptions(env) { return { siteUrl: env.CANONICAL_ORIGIN || DEFAULT_CANONICAL_ORIGIN, googleAnalyticsId: env.GOOGLE_ANALYTICS_ID || DEFAULT_GA_MEASUREMENT_ID }; }
function indexCountryShard(country, rows) {
  const states = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[1] !== "string" || typeof row[4] !== "string") continue;
    const [name, stateName, latitude, longitude, outputCitySlug] = row;
    if (!states.has(stateName)) states.set(stateName, []);
    states.get(stateName).push({ name, resolvedAdmin1Code: stateName, resolvedCountryName: country.country, latitude, longitude, outputCitySlug });
  }
  for (const cities of states.values()) cities.sort((a, b) => a.name.localeCompare(b.name) || a.outputCitySlug.localeCompare(b.outputCitySlug));
  return new Map([...states].map(([stateName, cities]) => [stateName, {
    cities,
    citiesBySlug: new Map(cities.map((city) => [city.outputCitySlug, city])),
  }]));
}
function stateFromIndex(country, state, index) {
  const indexedState = index.get(state.name);
  if (!indexedState) return null;
  return { countryName: country.country, countrySlug: country.countrySlug, stateName: state.name, stateSlug: state.slug, cities: indexedState.cities, citiesBySlug: indexedState.citiesBySlug };
}
function countryFromManifest(country) { return { name: country.country, slug: country.countrySlug, count: country.count, states: (country.states || []).map((state) => ({ name: state.name, slug: state.slug, count: state.count })) }; }
function htmlResponse(html) { return new Response(html, { headers: { "content-type": "text/html; charset=UTF-8", "cache-control": HTML_BROWSER_CACHE_CONTROL } }); }
function headResponse(response) { return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers }); }
function cacheVersion(env) { return env.HTML_CACHE_VERSION || DEFAULT_HTML_CACHE_VERSION; }
function candidateHtmlPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  if (parts[0] !== "wetbulb-temperature" || parts.length > 4) return null;
  // Rendering uses resolved route data, not the request spelling, so these variants are parity-identical.
  return `/${parts.join("/")}`;
}
function htmlCacheKey(request, version, routePath) {
  return new Request(`https://html-cache.internal/${encodeURIComponent(version)}${routePath}`, { method: "GET" });
}
function validHtmlEnvelope(value, version, routePath, now) {
  return value && value.schema === HTML_CACHE_SCHEMA && value.cacheVersion === version && value.routePath === routePath
    && typeof value.html === "string" && Number.isFinite(value.storedAt) && Number.isFinite(value.freshUntil)
    && Number.isFinite(value.staleUntil) && value.freshUntil >= value.storedAt && value.staleUntil >= value.freshUntil
    && value.staleUntil > now && value.status === 200 && value.headers && typeof value.headers === "object"
    && Object.keys(value.headers).length === 1 && value.headers["content-type"] === "text/html; charset=UTF-8";
}
async function readHtmlEnvelope(cache, key, version, routePath, now) {
  if (!cache) return null;
  try {
    const response = await cache.match(key);
    if (!response) return null;
    const envelope = await response.json();
    return validHtmlEnvelope(envelope, version, routePath, now) ? envelope : null;
  } catch { return null; }
}
function browserResponse(envelope) {
  return new Response(envelope.html, { status: envelope.status, headers: { ...envelope.headers, "content-type": "text/html; charset=UTF-8", "cache-control": HTML_BROWSER_CACHE_CONTROL } });
}
async function writeHtmlEnvelope(cache, key, version, routePath, response, now) {
  if (!cache || !response?.ok) return;
  const html = await response.text();
  const envelope = {
    schema: HTML_CACHE_SCHEMA, cacheVersion: version, routePath, status: response.status,
    headers: { "content-type": "text/html; charset=UTF-8" }, html, storedAt: now,
    freshUntil: now + HTML_CACHE_FRESH_MS, staleUntil: now + HTML_CACHE_FRESH_MS + HTML_CACHE_STALE_MS,
  };
  const internal = new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${HTML_CACHE_STORAGE_TTL_SECONDS}` } });
  try { await cache.put(key, internal); } catch {}
}

/** Resolves static metadata only; it deliberately never consults a weather/provider binding. */
export function createLocationResolver({ maxCachedShards = DEFAULT_MAX_CACHED_SHARDS } = {}) {
  let manifestPromise;
  const parsedShards = new Map();
  const inFlightShards = new Map();
  const shardCacheLimit = Number.isSafeInteger(maxCachedShards) && maxCachedShards > 0
    ? maxCachedShards
    : DEFAULT_MAX_CACHED_SHARDS;
  function touchParsedShard(file, index) {
    parsedShards.delete(file);
    parsedShards.set(file, index);
  }
  function trimParsedShards() {
    while (parsedShards.size > shardCacheLimit) parsedShards.delete(parsedShards.keys().next().value);
  }
  async function manifest(request, assets) {
    if (!manifestPromise) {
      const promise = readAssetJson(request, assets, `${LOCATION_ROOT}/route-manifest.json`);
      manifestPromise = promise;
      promise.catch(() => { if (manifestPromise === promise) manifestPromise = undefined; });
    }
    return manifestPromise;
  }
  async function shard(request, assets, country) {
    const cached = parsedShards.get(country.file);
    if (cached) {
      touchParsedShard(country.file, cached);
      return cached;
    }
    const inFlight = inFlightShards.get(country.file);
    if (inFlight) return inFlight;
    const promise = readAssetJson(request, assets, `${LOCATION_ROOT}/shards/${country.file}`)
      .then((countryShard) => countryShard?.v === 1 && Array.isArray(countryShard.r) ? indexCountryShard(country, countryShard.r) : null)
      .then((index) => {
        if (!index) return null;
        touchParsedShard(country.file, index);
        trimParsedShards();
        return index;
      });
    inFlightShards.set(country.file, promise);
    promise.then(
      () => { if (inFlightShards.get(country.file) === promise) inFlightShards.delete(country.file); },
      () => { if (inFlightShards.get(country.file) === promise) inFlightShards.delete(country.file); },
    );
    return promise;
  }
  const resolve = async (request, assets, parts) => {
    const index = await manifest(request, assets);
    if (!index || index.v !== 1 || !Array.isArray(index.countries)) return null;
    if (parts.length === 1) return { kind: "browse", index };
    const country = index.countries.find((item) => item.countrySlug === parts[1]);
    if (!country || typeof country.file !== "string") return null;
    if (parts.length === 2) return { kind: "country", country };
    const stateRecord = country.states?.find((item) => item.slug === parts[2]);
    if (!stateRecord || typeof stateRecord.name !== "string") return null;
    const countryIndex = await shard(request, assets, country);
    if (!countryIndex) return null;
    const state = stateFromIndex(country, stateRecord, countryIndex);
    if (!state?.cities.length) return null;
    if (parts.length === 3) return { kind: "state", state };
    const city = state.citiesBySlug.get(parts[3]);
    return city ? { kind: "city", city } : null;
  };
  resolve.cacheStats = () => ({ parsedShards: parsedShards.size, inFlightShards: inFlightShards.size, maxCachedShards: shardCacheLimit });
  return resolve;
}

export function createHonoPageRenderer({ cache = () => globalThis.caches?.default, now = () => Date.now() } = {}) {
  const app = new Hono();
  const resolve = createLocationResolver();
  app.all("/api/weather", (context) => {
    let executionContext;
    try { executionContext = context.executionCtx; } catch {}
    return weatherResponse(context.req.raw, context.env, executionContext);
  });
  app.all("/api/weather/", (context) => context.notFound());
  app.get("*", async (context) => {
    const request = context.req.raw;
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname.startsWith(`${LOCATION_ROOT}/`) || pathname === LOCATION_ROOT) return context.notFound();
    const routePath = candidateHtmlPath(pathname);
    if (!routePath) return context.env.ASSETS.fetch(request);
    const method = request.method;
    const version = cacheVersion(context.env);
    const key = htmlCacheKey(request, version, routePath);
    const edgeCache = cache();
    const current = now();
    const cached = await readHtmlEnvelope(edgeCache, key, version, routePath, current);
    if (cached && cached.freshUntil > current) {
      const response = browserResponse(cached);
      return method === "HEAD" ? headResponse(response) : response;
    }
    const render = async () => {
      const parts = pathname.split("/").filter(Boolean);
      const options = rendererOptions(context.env);
      if (parts.length === 0) return htmlResponse(renderHomePage({}, options));
      const result = await resolve(request, context.env.ASSETS, parts);
      if (!result) return null;
      if (result.kind === "browse") return htmlResponse(renderBrowsePage({ countries: result.index.countries.map(countryFromManifest) }, options));
      if (result.kind === "country") return htmlResponse(renderCountryPage(countryFromManifest(result.country), options));
      if (result.kind === "state") return htmlResponse(renderStatePage(result.state, options));
      return htmlResponse(pageHtml(result.city, options));
    };
    const regenerate = async () => {
      const rendered = await render();
      if (!rendered) return null;
      if (method === "GET") await writeHtmlEnvelope(edgeCache, key, version, routePath, rendered.clone(), now());
      return rendered;
    };
    if (cached) {
      if (method === "GET") {
        const inFlight = htmlRegenerations.get(key.url) || regenerate().catch(() => null).finally(() => htmlRegenerations.delete(key.url));
        htmlRegenerations.set(key.url, inFlight);
        try { context.executionCtx?.waitUntil(inFlight); } catch {}
      }
      const response = browserResponse(cached);
      return method === "HEAD" ? headResponse(response) : response;
    }
    const rendered = await regenerate();
    if (!rendered) return context.notFound();
    return method === "HEAD" ? headResponse(rendered) : rendered;
  });
  return app;
}
const app = createHonoPageRenderer();
export default { fetch(request, env, executionContext) { return app.fetch(request, env, executionContext); } };
