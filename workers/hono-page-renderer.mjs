import { Hono } from "hono";
import { pageHtml, renderBrowsePage, renderCountryPage, renderGlobalGridHotspotPage, renderHomePage, renderHotspotPage, renderStatePage } from "../lib/page-renderer.mjs";

import { forecastResponse } from "./forecast-edge.ts";
import { hotspotApiResponse, readHotspotSnapshot } from "./hotspots-edge.ts";
import { globalGridHotspotApiResponse, readGlobalGridHotspotSnapshot } from "./global-grid-hotspots-edge.ts";
import { createObservability, weatherResponse } from "./weather-edge.mjs";
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
const STRICT_TRANSPORT_SECURITY = "max-age=63072000";
const NOT_FOUND_MESSAGE = "The page could not be found";
const htmlRegenerations = new Map();

class InternalMetadataError extends Error {}
function assetRequest(request, pathname) { return new Request(new URL(pathname, request.url)); }
async function readAssetJson(request, assets, pathname) {
  let response;
  try { response = await assets.fetch(assetRequest(request, pathname)); } catch { throw new InternalMetadataError(); }
  if (!response?.ok) throw new InternalMetadataError();
  try { return await response.json(); } catch { throw new InternalMetadataError(); }
}
function rendererOptions(env) { return { siteUrl: env.CANONICAL_ORIGIN || DEFAULT_CANONICAL_ORIGIN, googleAnalyticsId: env.GOOGLE_ANALYTICS_ID || DEFAULT_GA_MEASUREMENT_ID, forecastEnabled: env.OPEN_METEO_API_MODE === "public-noncommercial" || env.OPEN_METEO_API_MODE === "customer-commercial", hotspotEnabled: env.HOTSPOT_FEATURE_MODE === "enabled" }; }
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
function htmlResponse(html, routePath) { return new Response(html, { headers: htmlHeaders(routePath) }); }
function safeFilename(pathname) {
  const filename = pathname.split("/").filter(Boolean).at(-1);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename || "") ? filename : null;
}
function htmlHeaders(routePath = "/") {
  const filename = routePath === "/" ? null : safeFilename(routePath);
  return { "content-type": "text/html; charset=UTF-8", "cache-control": HTML_BROWSER_CACHE_CONTROL, "content-disposition": filename ? `inline; filename="${filename}"` : "inline", "access-control-allow-origin": "*", "strict-transport-security": STRICT_TRANSPORT_SECURITY };
}
function headResponse(response) { return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers }); }
function acceptedQuality(request, mediaType) {
  const [wantedType, wantedSubtype] = mediaType.split("/");
  let best = null;
  for (const [index, value] of (request.headers.get("accept") || "").split(",").entries()) {
    const [range, ...parameters] = value.trim().toLowerCase().split(";");
    const [type, subtype] = range.trim().split("/");
    if (type !== wantedType || subtype !== wantedSubtype) continue;
    const quality = Number(parameters.find((parameter) => parameter.trim().startsWith("q="))?.trim().slice(2) ?? 1);
    if (!Number.isFinite(quality) || quality <= 0) continue;
    const candidate = { quality, index };
    if (!best || candidate.quality > best.quality || (candidate.quality === best.quality && candidate.index < best.index)) best = candidate;
  }
  return best;
}
function notFoundResponse(request) {
  const headers = { "cache-control": HTML_BROWSER_CACHE_CONTROL, "strict-transport-security": STRICT_TRANSPORT_SECURITY };
  const candidates = [["text/html", "html"], ["application/json", "json"], ["text/plain", "plain"]].map(([type, kind]) => ({ type, kind, ...acceptedQuality(request, type) })).filter((candidate) => candidate.quality !== undefined).sort((a, b) => b.quality - a.quality || a.index - b.index);
  const selected = candidates[0]?.kind || "plain";
  if (selected === "json") return new Response(JSON.stringify({ error: { code: "404", message: NOT_FOUND_MESSAGE } }), { status: 404, headers: { ...headers, "content-type": "application/json" } });
  if (selected === "html") return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>404: NOT_FOUND</title></head><body><main><h1>404</h1><p>${NOT_FOUND_MESSAGE}</p><code>NOT_FOUND</code></main></body></html>`, { status: 404, headers: { ...headers, "content-type": "text/html; charset=UTF-8" } });
  return new Response(`${NOT_FOUND_MESSAGE}\n\nNOT_FOUND\n`, { status: 404, headers: { ...headers, "content-type": "text/plain; charset=UTF-8" } });
}
function internalErrorResponse(status = 500) {
  const body = status === 503 ? "Service Unavailable\n" : "Internal Server Error\n";
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=UTF-8", "cache-control": "no-store", "strict-transport-security": STRICT_TRANSPORT_SECURITY } });
}
function publicAssetFilename(pathname) {
  if (pathname === "/robots.txt") return null;
  return safeFilename(pathname);
}
function publicAssetCacheControl(pathname) {
  if (pathname === "/assets/locations.json" || pathname === "/sitemap.xml" || pathname.startsWith("/sitemaps/")) return HTML_BROWSER_CACHE_CONTROL;
  return "public, max-age=14400, must-revalidate";
}
async function publicAssetResponse(request, assets) {
  let response;
  try { response = await assets.fetch(request); } catch { return request.method === "HEAD" ? headResponse(internalErrorResponse()) : internalErrorResponse(); }
  if (response.status === 404) return null;
  if (response.status >= 500) {
    const failure = internalErrorResponse(response.status);
    return request.method === "HEAD" ? headResponse(failure) : failure;
  }
  const headers = new Headers(response.headers);
  const pathname = new URL(request.url).pathname;
  headers.set("strict-transport-security", STRICT_TRANSPORT_SECURITY);
  headers.set("access-control-allow-origin", "*");
  if (response.ok) {
    headers.set("cache-control", publicAssetCacheControl(pathname));
    const filename = publicAssetFilename(pathname);
    if (filename) headers.set("content-disposition", `inline; filename="${filename}"`);
  }
  return request.method === "HEAD" ? new Response(null, { status: response.status, statusText: response.statusText, headers }) : new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function cacheVersion(env, injectedFallback) {
  const id = env.CF_VERSION_METADATA?.id;
  if (typeof id === "string" && id.trim()) return id;
  const fallback = injectedFallback?.(env);
  return typeof fallback === "string" && fallback.trim() ? fallback : null;
}
function htmlObservability(env) {
  if (env?.OBSERVABILITY && typeof env.OBSERVABILITY.html === "function") return env.OBSERVABILITY;
  const id = env?.CF_VERSION_METADATA?.id;
  return createObservability({
    deploymentVersion: typeof id === "string" && id.trim() ? id : "unknown",
    // Explicitly disabled unless staging sets a fraction in [0, 1].
    htmlSampleRate: Number(env?.HTML_CACHE_EVENT_SAMPLE_RATE) || 0,
  });
}
function candidateHtmlPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  if (parts[0] !== "wetbulb-temperature" || parts.length > 4) return null;
  // Rendering uses resolved route data, not the request spelling, so these variants are parity-identical.
  return `/${parts.join("/")}`;
}
function htmlCacheKey(version, routePath) {
  return new Request(`https://html-cache.internal/${encodeURIComponent(version)}${routePath}`, { method: "GET" });
}
function validHtmlEnvelope(value, version, routePath, now) {
  return value && value.schema === HTML_CACHE_SCHEMA && value.cacheVersion === version && value.routePath === routePath
    && typeof value.html === "string" && Number.isFinite(value.storedAt) && Number.isFinite(value.freshUntil)
    && Number.isFinite(value.staleUntil) && value.freshUntil === value.storedAt + HTML_CACHE_FRESH_MS
    && value.staleUntil === value.freshUntil + HTML_CACHE_STALE_MS
    && value.staleUntil > now && value.status === 200 && value.headers && typeof value.headers === "object"
    && Object.keys(value.headers).length === 1 && value.headers["content-type"] === "text/html; charset=UTF-8";
}
function validManifest(value) {
  const popularCitiesValid = !value?.popularCities || (Array.isArray(value.popularCities)
    && (value.popularCities.length === 0 || value.popularCities.length === 40)
    && value.popularCities.every((city) => city && typeof city.name === "string" && typeof city.stateName === "string"
      && typeof city.countryName === "string" && /^\/wetbulb-temperature\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(city.path)));
  return value && value.v === 1 && Array.isArray(value.countries) && popularCitiesValid && value.countries.every((country) => country && typeof country.country === "string"
    && typeof country.countrySlug === "string" && typeof country.file === "string" && Array.isArray(country.states)
    && country.states.every((state) => state && typeof state.name === "string" && typeof state.slug === "string"));
}
function validShard(value) {
  return value && value.v === 1 && Array.isArray(value.r) && value.r.every((row) => Array.isArray(row)
    && typeof row[0] === "string" && typeof row[1] === "string" && Number.isFinite(row[2]) && Number.isFinite(row[3]) && typeof row[4] === "string" && (row.length < 6 || row[5] === null || Number.isInteger(row[5])));
}
function validLegacyManifest(value) {
  if (!(value && value.v === 1 && typeof value.artifactSha256 === "string" && /^[a-f0-9]{64}$/.test(value.artifactSha256)
    && Array.isArray(value.files) && value.files.every((entry) => Array.isArray(entry) && entry.length === 2 && /^[a-z0-9-]+$/.test(entry[0]) && /^[a-f0-9]{16}\.json$/.test(entry[1])))) return false;
  return new Set(value.files.map(([country]) => country)).size === value.files.length
    && new Set(value.files.map(([, file]) => file)).size === value.files.length;
}
function validLegacyShard(value) {
  if (!(value && value.v === 1 && Array.isArray(value.a) && value.a.every((entry) => Array.isArray(entry) && entry.length === 2
    && /^\/wetbulb-temperature\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(entry[0])
    && /^\/wetbulb-temperature\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(entry[1])))) return false;
  return new Set(value.a.map(([alias]) => alias)).size === value.a.length;
}
async function readHtmlEnvelope(cache, key, version, routePath, now) {
  if (!cache) return null;
  try {
    const response = await cache.match(key);
    if (!response?.ok) return null;
    const envelope = await response.json();
    return validHtmlEnvelope(envelope, version, routePath, now) ? envelope : null;
  } catch { return null; }
}
function browserResponse(envelope, routePath) {
  return new Response(envelope.html, { status: envelope.status, headers: htmlHeaders(routePath) });
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
  const parsedLegacyShards = new Map();
  const inFlightShards = new Map();
  const inFlightLegacyShards = new Map();
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
      const promise = readAssetJson(request, assets, `${LOCATION_ROOT}/route-manifest.json`).then((value) => {
        if (!validManifest(value)) throw new InternalMetadataError();
        return value;
      });
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
      .then((countryShard) => {
        if (!validShard(countryShard)) throw new InternalMetadataError();
        return indexCountryShard(country, countryShard.r);
      })
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
  async function legacyAlias(request, assets, pathname) {
    const match = pathname.match(/^\/wetbulb-temperature\/([a-z0-9-]+)\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
    if (!match) return null;
    const index = await manifest(request, assets);
    if (index.legacyRedirects === undefined) return null;
    if (!validLegacyManifest(index.legacyRedirects)) throw new InternalMetadataError();
    const file = index.legacyRedirects.files.find(([country]) => country === match[3])?.[1];
    if (!file) return null;
    let aliases = parsedLegacyShards.get(file);
    if (!aliases) {
      let promise = inFlightLegacyShards.get(file);
      if (!promise) {
        promise = readAssetJson(request, assets, `${LOCATION_ROOT}/legacy-shards/${file}`).then((shard) => {
          if (!validLegacyShard(shard)) throw new InternalMetadataError();
          const parsed = new Map(shard.a);
          parsedLegacyShards.set(file, parsed);
          while (parsedLegacyShards.size > shardCacheLimit) parsedLegacyShards.delete(parsedLegacyShards.keys().next().value);
          return parsed;
        });
        inFlightLegacyShards.set(file, promise);
        promise.then(
          () => { if (inFlightLegacyShards.get(file) === promise) inFlightLegacyShards.delete(file); },
          () => { if (inFlightLegacyShards.get(file) === promise) inFlightLegacyShards.delete(file); },
        );
      }
      aliases = await promise;
    } else {
      parsedLegacyShards.delete(file); parsedLegacyShards.set(file, aliases);
    }
    return aliases.get(pathname) || null;
  }
  const resolve = async (request, assets, parts) => {
    const index = await manifest(request, assets);
    if (!validManifest(index)) throw new InternalMetadataError();
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
  resolve.legacyAlias = legacyAlias;
  resolve.cacheStats = () => ({ parsedShards: parsedShards.size, parsedLegacyShards: parsedLegacyShards.size,
    inFlightShards: inFlightShards.size, inFlightLegacyShards: inFlightLegacyShards.size, maxCachedShards: shardCacheLimit });
  return resolve;
}

export function createHonoPageRenderer({ cache = () => globalThis.caches?.default, now = () => Date.now(), cacheVersion: injectedCacheVersion } = {}) {
  const app = new Hono();
  app.notFound((context) => {
    const response = notFoundResponse(context.req.raw);
    return context.req.raw.method === "HEAD" ? headResponse(response) : response;
  });
  const resolve = createLocationResolver();
  app.all("/api/weather", (context) => {
    let executionContext;
    try { executionContext = context.executionCtx; } catch {}
    return weatherResponse(context.req.raw, context.env, executionContext);
  });
  app.all("/api/weather/", (context) => context.notFound());
  app.all("/api/forecast", (context) => {
    if (context.env.OPEN_METEO_API_MODE !== "public-noncommercial" && context.env.OPEN_METEO_API_MODE !== "customer-commercial") return context.notFound();
    let executionContext;
    try { executionContext = context.executionCtx; } catch {}
    const resolveForecastLocation = async (path) => {
      const parts = path.split("/").filter(Boolean);
      const result = await resolve(context.req.raw, context.env.ASSETS, parts);
      if (result?.kind !== "city") return null;
      return {
        path,
        name: `${result.city.name}, ${result.city.resolvedAdmin1Code}, ${result.city.resolvedCountryName}`,
        latitude: Number(result.city.latitude),
        longitude: Number(result.city.longitude),
      };
    };
    return forecastResponse(context.req.raw, context.env, executionContext, resolveForecastLocation);
  });
  app.all("/api/forecast/", (context) => context.notFound());
  app.all("/api/inhabited-hotspots", (context) => {
    if (context.env.HOTSPOT_FEATURE_MODE !== "enabled") return context.notFound();
    return hotspotApiResponse(context.req.raw, context.env, cache());
  });
  app.all("/api/inhabited-hotspots/", (context) => context.notFound());
  app.all("/api/global-grid-hotspots", (context) => {
    if (context.env.GLOBAL_GRID_HOTSPOT_FEATURE_MODE !== "enabled") return context.notFound();
    return globalGridHotspotApiResponse(context.req.raw, context.env, cache());
  });
  app.all("/api/global-grid-hotspots/", (context) => context.notFound());
  app.all("/wetbulb-temperature/forecast/global-hotspots", (context) => {
    if (context.req.raw.method !== "GET" && context.req.raw.method !== "HEAD") return context.notFound();
    const url = new URL(context.req.raw.url);
    url.pathname = "/wetbulb-temperature/forecast/global-hotspots/";
    return new Response(null, { status: 308, headers: { location: url.toString(), "strict-transport-security": STRICT_TRANSPORT_SECURITY } });
  });
  app.all("/wetbulb-temperature/forecast/global-hotspots/", async (context) => {
    const request = context.req.raw;
    if (request.method !== "GET" && request.method !== "HEAD") return context.notFound();
    if (context.env.HOTSPOT_FEATURE_MODE !== "enabled") return context.notFound();
    const result = await readHotspotSnapshot(context.env, cache());
    if (!result.ok) {
      const response = internalErrorResponse(result.status);
      return request.method === "HEAD" ? headResponse(response) : response;
    }
    const response = htmlResponse(renderHotspotPage(result.snapshot, rendererOptions(context.env)), "/wetbulb-temperature/forecast/global-hotspots/");
    response.headers.set("etag", result.etag);
    return request.method === "HEAD" ? headResponse(response) : response;
  });
  app.all("/wetbulb-temperature/forecast/global-grid-hotspots", (context) => {
    if (context.req.raw.method !== "GET" && context.req.raw.method !== "HEAD") return context.notFound();
    const url = new URL(context.req.raw.url);
    url.pathname = "/wetbulb-temperature/forecast/global-grid-hotspots/";
    return new Response(null, { status: 308, headers: { location: url.toString(), "strict-transport-security": STRICT_TRANSPORT_SECURITY } });
  });
  app.all("/wetbulb-temperature/forecast/global-grid-hotspots/", async (context) => {
    const request = context.req.raw;
    if (request.method !== "GET" && request.method !== "HEAD") return context.notFound();
    if (context.env.GLOBAL_GRID_HOTSPOT_FEATURE_MODE !== "enabled") return context.notFound();
    const result = await readGlobalGridHotspotSnapshot(context.env, cache());
    if (!result.ok) {
      const response = internalErrorResponse(result.status);
      return request.method === "HEAD" ? headResponse(response) : response;
    }
    const response = htmlResponse(renderGlobalGridHotspotPage(result.snapshot, rendererOptions(context.env)), "/wetbulb-temperature/forecast/global-grid-hotspots/");
    response.headers.set("etag", result.etag);
    return request.method === "HEAD" ? headResponse(response) : response;
  });
  app.get("*", async (context) => {
    const request = context.req.raw;
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname.startsWith(`${LOCATION_ROOT}/`) || pathname === LOCATION_ROOT) return context.notFound();
    if (pathname === "/sitemap-index.xml" || pathname === "/api/sitemap-index.xml") {
      url.pathname = "/sitemap.xml";
      return new Response(null, { status: 308, headers: { location: url.toString(), "strict-transport-security": STRICT_TRANSPORT_SECURITY } });
    }
    const routePath = candidateHtmlPath(pathname);
    if (!routePath) {
      const asset = await publicAssetResponse(request, context.env.ASSETS);
      return asset || context.notFound();
    }
    if (pathname !== "/" && !pathname.endsWith("/") && pathname === routePath) {
      const parts = pathname.split("/").filter(Boolean);
      let resolved;
      try { resolved = await resolve(request, context.env.ASSETS, parts); }
      catch {
        const response = internalErrorResponse();
        return request.method === "HEAD" ? headResponse(response) : response;
      }
      if (!resolved) {
        let target;
        try { target = await resolve.legacyAlias(request, context.env.ASSETS, pathname); }
        catch {
          const response = internalErrorResponse();
          return request.method === "HEAD" ? headResponse(response) : response;
        }
        if (!target) return context.notFound();
        url.pathname = target;
        return new Response(null, { status: 308, headers: { location: url.toString(), "strict-transport-security": STRICT_TRANSPORT_SECURITY } });
      }
      url.pathname = `${pathname}/`;
      return new Response(null, { status: 308, headers: { location: url.toString(), "strict-transport-security": STRICT_TRANSPORT_SECURITY } });
    }
    const method = request.method;
    const version = cacheVersion(context.env, injectedCacheVersion);
    const key = version ? htmlCacheKey(version, routePath) : null;
    const edgeCache = key ? cache() : null;
    const current = now();
    const cached = key ? await readHtmlEnvelope(edgeCache, key, version, routePath, current) : null;
    if (cached && cached.freshUntil > current) {
      htmlObservability(context.env).html("hit");
      const response = browserResponse(cached, routePath);
      return method === "HEAD" ? headResponse(response) : response;
    }
    const render = async () => {
      const parts = pathname.split("/").filter(Boolean);
      const options = rendererOptions(context.env);
      if (parts.length === 0) return htmlResponse(renderHomePage({}, options), routePath);
      const result = await resolve(request, context.env.ASSETS, parts);
      if (!result) return null;
      if (result.kind === "browse") return htmlResponse(renderBrowsePage({ countries: result.index.countries.map(countryFromManifest), popularCities: result.index.popularCities || [] }, options), routePath);
      if (result.kind === "country") return htmlResponse(renderCountryPage(countryFromManifest(result.country), options), routePath);
      if (result.kind === "state") return htmlResponse(renderStatePage(result.state, options), routePath);
      return htmlResponse(pageHtml(result.city, options), routePath);
    };
    const regenerate = async () => {
      const rendered = await render();
      if (!rendered) return null;
      if (method === "GET" && key) await writeHtmlEnvelope(edgeCache, key, version, routePath, rendered.clone(), now());
      return rendered;
    };
    const coalescedRegenerate = () => {
      const existing = htmlRegenerations.get(key.url);
      if (existing) return existing;
      let inFlight;
      inFlight = regenerate().finally(() => {
        if (htmlRegenerations.get(key.url) === inFlight) htmlRegenerations.delete(key.url);
      });
      htmlRegenerations.set(key.url, inFlight);
      return inFlight;
    };
    if (cached) {
      htmlObservability(context.env).html("stale");
      if (method === "GET") {
        const lifecycle = coalescedRegenerate().catch(() => {});
        try { context.executionCtx?.waitUntil(lifecycle); } catch {}
      }
      const response = browserResponse(cached, routePath);
      return method === "HEAD" ? headResponse(response) : response;
    }
    htmlObservability(context.env).html("miss");
    let rendered;
    try { rendered = method === "GET" && key ? await coalescedRegenerate() : await regenerate(); }
    catch {
      const response = internalErrorResponse();
      return method === "HEAD" ? headResponse(response) : response;
    }
    if (!rendered) return context.notFound();
    if (method === "HEAD") return headResponse(rendered);
    return method === "GET" && key ? rendered.clone() : rendered;
  });
  return app;
}
const app = createHonoPageRenderer();
export default { fetch(request, env, executionContext) { return app.fetch(request, env, executionContext); } };
