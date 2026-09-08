import { Hono } from "hono";
import { pageHtml, renderBrowsePage, renderCountryPage, renderHomePage, renderStatePage } from "../lib/page-renderer.mjs";

const LOCATION_ROOT = "/locations";
const DEFAULT_CANONICAL_ORIGIN = "https://www.wetbulb35.com";
const DEFAULT_GA_MEASUREMENT_ID = "G-LNPWV0JL7S";

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
function htmlResponse(html) { return new Response(html, { headers: { "content-type": "text/html; charset=UTF-8" } }); }

/** Resolves static metadata only; it deliberately never consults a weather/provider binding. */
export function createLocationResolver() {
  let manifestPromise;
  const shardPromises = new Map();
  async function manifest(request, assets) {
    if (!manifestPromise) {
      const promise = readAssetJson(request, assets, `${LOCATION_ROOT}/route-manifest.json`);
      manifestPromise = promise;
      promise.catch(() => { if (manifestPromise === promise) manifestPromise = undefined; });
    }
    return manifestPromise;
  }
  async function shard(request, assets, country) {
    if (!shardPromises.has(country.file)) {
      const promise = readAssetJson(request, assets, `${LOCATION_ROOT}/shards/${country.file}`)
        .then((countryShard) => countryShard?.v === 1 && Array.isArray(countryShard.r) ? indexCountryShard(country, countryShard.r) : null);
      shardPromises.set(country.file, promise);
      promise.catch(() => { if (shardPromises.get(country.file) === promise) shardPromises.delete(country.file); });
    }
    return shardPromises.get(country.file);
  }
  return async (request, assets, parts) => {
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
}

export function createHonoPageRenderer() {
  const app = new Hono();
  const resolve = createLocationResolver();
  app.get("*", async (context) => {
    const request = context.req.raw;
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith(`${LOCATION_ROOT}/`) || pathname === LOCATION_ROOT) return context.notFound();
    const parts = pathname.split("/").filter(Boolean);
    const options = rendererOptions(context.env);
    if (parts.length === 0) return htmlResponse(renderHomePage({}, options));
    if (parts[0] !== "wetbulb-temperature" || parts.length > 4) return context.env.ASSETS.fetch(request);
    const result = await resolve(request, context.env.ASSETS, parts);
    if (!result) return context.notFound();
    if (result.kind === "browse") return htmlResponse(renderBrowsePage({ countries: result.index.countries.map(countryFromManifest) }, options));
    if (result.kind === "country") return htmlResponse(renderCountryPage(countryFromManifest(result.country), options));
    if (result.kind === "state") return htmlResponse(renderStatePage(result.state, options));
    return htmlResponse(pageHtml(result.city, options));
  });
  return app;
}
const app = createHonoPageRenderer();
export default { fetch(request, env, executionContext) { return app.fetch(request, env, executionContext); } };
