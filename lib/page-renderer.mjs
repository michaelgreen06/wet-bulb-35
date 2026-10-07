/** Browser/Worker-safe static page rendering shared by generator and Hono. */
import slugify from "slugify";
import { computeNearby } from "./nearby.mjs";
import { popular40EnrichmentByPath } from "./popular-40-enrichment.mjs";

export const DEFAULT_SITE_URL = "https://www.wetbulb35.com";
export const DEFAULT_GA_MEASUREMENT_ID = "G-LNPWV0JL7S";

export function parseArgs(argv = []) {
  return new Map(
    argv.map((arg) => {
      const [key, value] = arg.split("=");
      return [key.replace(/^--/, ""), value ?? true];
    }),
  );
}

export function toSlug(value) {
  return slugify(String(value ?? ""), {
    lower: true,
    strict: true,
    locale: "en",
    trim: true,
  });
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function coordinateSuffix(city) {
  const lat = Number(city.latitude).toFixed(4).replace("-", "s").replace(".", "-");
  const lng = Number(city.longitude).toFixed(4).replace("-", "w").replace(".", "-");
  return `${lat}-${lng}`;
}

export function getRouteParts(city) {
  return {
    countrySlug: toSlug(city.resolvedCountryName),
    stateSlug: toSlug(city.resolvedAdmin1Code),
    citySlug: city.outputCitySlug ?? toSlug(city.name),
  };
}

export function routePathForCity(city) {
  const { countrySlug, stateSlug, citySlug } = getRouteParts(city);
  return `/wetbulb-temperature/${countrySlug}/${stateSlug}/${citySlug}/`;
}

function canonicalUrl(siteUrl, routePath) {
  return `${siteUrl}${routePath}`;
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function defaultGoogleAnalyticsId() {
  return DEFAULT_GA_MEASUREMENT_ID;
}

function normalizeGoogleAnalyticsId(measurementId) {
  const id = measurementId === undefined ? defaultGoogleAnalyticsId() : measurementId;
  return String(id ?? "").trim();
}

export function renderGoogleAnalyticsScripts(measurementId) {
  const normalizedMeasurementId = normalizeGoogleAnalyticsId(measurementId);

  if (!normalizedMeasurementId) {
    return "";
  }

  return `
  <script async src="https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(normalizedMeasurementId)}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag("js", new Date());
    gtag("config", ${safeJson(normalizedMeasurementId)});
  </script>`;
}

function sortByName(items) {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }

  return result;
}

export function prepareCities(sourceCities) {
  const routeGroups = new Map();

  for (const city of sourceCities) {
    const countrySlug = toSlug(city.resolvedCountryName);
    const stateSlug = toSlug(city.resolvedAdmin1Code);
    const citySlug = toSlug(city.name);

    if (!countrySlug || !stateSlug || !citySlug) {
      continue;
    }

    const baseRoute = `${countrySlug}/${stateSlug}/${citySlug}`;
    if (!routeGroups.has(baseRoute)) {
      routeGroups.set(baseRoute, []);
    }
    routeGroups.get(baseRoute).push(city);
  }

  let collisionGroups = 0;
  let collisionRows = 0;
  const cities = [];

  for (const group of routeGroups.values()) {
    if (group.length > 1) {
      collisionGroups += 1;
      collisionRows += group.length;
    }

    for (const city of group) {
      const baseCitySlug = toSlug(city.name);
      cities.push({
        ...city,
        outputCitySlug:
          group.length === 1
            ? baseCitySlug
            : `${baseCitySlug}-${coordinateSuffix(city)}`,
      });
    }
  }

  return {
    cities,
    collisionGroups,
    collisionRows,
  };
}

export function tier1ByCanonicalPath(manifest) {
  if (!manifest) return new Map();
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.cities)) throw new Error("Invalid Tier-1 city manifest");
  if (manifest.cities.length !== 200) throw new Error("Tier-1 city manifest must contain exactly 200 cities");
  const index = new Map();
  const ranks = new Set();
  const tierCounts = new Map([["1A", 0], ["1B", 0], ["1C", 0]]);
  let popularCount = 0;
  for (const city of manifest.cities) {
    if (!Number.isInteger(city.rank) || !tierCounts.has(city.tier) || typeof city.path !== "string" || typeof city.popular !== "boolean") {
      throw new Error("Invalid Tier-1 city manifest entry");
    }
    const expectedTier = city.rank <= 50 ? "1A" : city.rank <= 100 ? "1B" : "1C";
    if (city.tier !== expectedTier) throw new Error(`Tier-1 rank ${city.rank} must be tier ${expectedTier}`);
    if (!/^\/wetbulb-temperature\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(city.path)) {
      throw new Error(`Invalid Tier-1 canonical path: ${city.path}`);
    }
    if (ranks.has(city.rank)) throw new Error(`Duplicate Tier-1 rank: ${city.rank}`);
    if (index.has(city.path)) throw new Error(`Duplicate Tier-1 canonical path: ${city.path}`);
    ranks.add(city.rank);
    tierCounts.set(city.tier, tierCounts.get(city.tier) + 1);
    if (city.popular) popularCount += 1;
    index.set(city.path, city);
  }
  if (![...ranks].sort((a, b) => a - b).every((rank, index) => rank === index + 1)) throw new Error("Tier-1 ranks must be exactly 1 through 200");
  if (tierCounts.get("1A") !== 50 || tierCounts.get("1B") !== 50 || tierCounts.get("1C") !== 100) throw new Error("Invalid Tier-1 tier counts");
  if (popularCount !== 40) throw new Error("Tier-1 manifest must contain exactly 40 Popular Cities");
  return index;
}

export function createSiteData(sourceCities, tier1Manifest = null, population = null) {
  const { cities, collisionGroups, collisionRows } = prepareCities(sourceCities);
  const tier1 = tier1ByCanonicalPath(tier1Manifest);
  const nearby = computeNearby(cities, { hubPaths: new Set(tier1.keys()), population });
  const annotatedCities = cities.map((city) => {
    const routePath = routePathForCity(city);
    return {
      ...city,
      tier1: tier1.get(routePath) ?? null,
      enrichment: popular40EnrichmentByPath.get(routePath) ?? null,
      nearby: nearby.get(routePath) ?? [],
    };
  });
  if (tier1.size && annotatedCities.filter((city) => city.tier1).length !== tier1.size) {
    throw new Error("Every Tier-1 manifest path must resolve exactly once from inventory");
  }
  const countriesMap = new Map();
  const statesMap = new Map();

  for (const city of annotatedCities) {
    const { countrySlug, stateSlug } = getRouteParts(city);
    const countryKey = countrySlug;
    const stateKey = `${countrySlug}/${stateSlug}`;

    if (!countriesMap.has(countryKey)) {
      countriesMap.set(countryKey, {
        name: city.resolvedCountryName,
        slug: countrySlug,
        count: 0,
        states: [],
      });
    }

    if (!statesMap.has(stateKey)) {
      statesMap.set(stateKey, {
        countryName: city.resolvedCountryName,
        countrySlug,
        stateName: city.resolvedAdmin1Code,
        stateSlug,
        cities: [],
      });
    }

    countriesMap.get(countryKey).count += 1;
    countriesMap.get(countryKey).states.push(city.resolvedAdmin1Code);
    statesMap.get(stateKey).cities.push(city);
  }

  const countries = sortByName(
    [...countriesMap.values()].map((country) => ({
      ...country,
      states: sortByName(
        dedupeBy(
          country.states.map((stateName) => ({
            name: stateName,
            slug: toSlug(stateName),
            count: statesMap.get(`${country.slug}/${toSlug(stateName)}`).cities.length,
          })),
          (state) => state.slug,
        ),
      ),
    })),
  );

  const states = [...statesMap.values()]
    .map((state) => ({
      ...state,
      cities: [...state.cities].sort((a, b) => a.name.localeCompare(b.name) || routePathForCity(a).localeCompare(routePathForCity(b))),
    }))
    .sort((a, b) =>
      `${a.countryName}/${a.stateName}`.localeCompare(`${b.countryName}/${b.stateName}`),
    );

  const cityRoutes = new Set(annotatedCities.map(routePathForCity));
  const pageRoutes = new Set(["/", "/wetbulb-temperature/"]);

  for (const country of countries) {
    pageRoutes.add(`/wetbulb-temperature/${country.slug}/`);

    for (const state of country.states) {
      pageRoutes.add(`/wetbulb-temperature/${country.slug}/${state.slug}/`);
    }
  }

  for (const route of cityRoutes) {
    pageRoutes.add(route);
  }

  const searchIndex = annotatedCities.map((city) => ({
    label: `${city.name}, ${city.resolvedAdmin1Code}, ${city.resolvedCountryName}`,
    url: routePathForCity(city),
    lat: Number(city.latitude),
    lon: Number(city.longitude),
  }));

  return {
    cities: annotatedCities,
    countries,
    states,
    pageRoutes,
    cityRoutes,
    collisionGroups,
    collisionRows,
    searchIndex,
    popularCities: annotatedCities.filter((city) => city.tier1?.popular).sort((a, b) => a.name.localeCompare(b.name) || routePathForCity(a).localeCompare(routePathForCity(b))),
  };
}

function pageShell({
  siteUrl,
  routePath,
  title,
  description,
  breadcrumbData,
  mainContent,
  googleAnalyticsId,
}) {
  const canonical = canonicalUrl(siteUrl, routePath);
  const imageUrl = `${siteUrl}/images/wetbulb-default.jpg`;
  const jsonLd = safeJson(breadcrumbData);
  const googleAnalyticsScripts = renderGoogleAnalyticsScripts(googleAnalyticsId);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:site_name" content="Wet Bulb Temperature">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/app.css">
  ${googleAnalyticsScripts}
  <script type="application/ld+json">${jsonLd}</script>
</head>
<body>
  ${mainContent}
  <script src="/assets/app.js?v=${CLIENT_RUNTIME_VERSION}" defer></script>
</body>
</html>
`;
}

function renderHeader() {
  return `<header class="text-center mb-8">
    <div class="flex justify-center mb-4">
      <a href="/" class="cursor-pointer">
        <img src="/logo.svg" alt="Wet Bulb Temperature Logo" width="80" height="80">
      </a>
    </div>
    <h1 class="text-4xl font-bold text-gray-900 mb-2">Current Wet Bulb Temperature</h1>
    <p class="text-gray-600">Get real-time wet bulb temperature for any location</p>
  </header>`;
}

function renderCityHeader() {
  return `<header class="text-center mb-8">
    <div class="flex justify-center mb-4">
      <a href="/" class="cursor-pointer">
        <img src="/logo.svg" alt="Wet Bulb Temperature Logo" width="80" height="80">
      </a>
    </div>
    <p class="text-lg font-semibold text-gray-800 mb-1">Wet Bulb Temperature</p>
    <p class="text-gray-600">Get the current wet bulb temperature for any location on earth</p>
  </header>`;
}

function renderFooter() {
  const year = new Date().getFullYear();
  return `<footer class="mt-12 py-6 border-t border-gray-200">
    <div class="max-w-4xl mx-auto px-4">
      <div class="flex flex-col md:flex-row justify-between items-center">
        <div class="mb-4 md:mb-0">
          <p class="text-sm text-gray-600">© ${year} Wet Bulb Temperature Monitor</p>
        </div>
        <div>
          <p class="text-sm text-gray-600">Contact us at: <span class="font-medium">info@wetbulb35.com</span></p>
        </div>
      </div>
    </div>
  </footer>`;
}

function renderDisclaimer() {
  return `<div class="mt-8 text-center text-sm text-gray-500 px-4">
    <p class="mb-2">
      Disclaimer: The wet bulb temperatures shown are estimates calculated using the Stull formula.
      For more information about wet bulb temperature calculations, visit
      <a href="https://www.omnicalculator.com/physics/wet-bulb" target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:text-blue-600 underline">Omni Calculator&apos;s Wet Bulb Temperature Calculator</a>.
    </p>
  </div>`;
}

export function formatCoordinates(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return "";
  return `${Math.abs(latitude).toFixed(4)}°${latitude < 0 ? "S" : "N"}, ${Math.abs(longitude).toFixed(4)}°${longitude < 0 ? "W" : "E"}`;
}

function renderSearchBox() {
  return `<div class="w-full max-w-md mx-auto">
    <form class="flex gap-2" data-search-form>
      <input
        id="location-search"
        name="query"
        type="search"
        placeholder="Search for a location..."
        autocomplete="off"
        data-search-input
        class="w-full px-4 py-2 border border-gray-300 rounded-lg bg-white text-black placeholder-gray-700 caret-black focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      >
      <button type="submit" class="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors whitespace-nowrap">Search</button>
      <p class="sr-only" data-search-status></p>
    </form>
  </div>`;
}

function renderCurrentLocationButton({ wrapperClass = "" } = {}) {
  const button = `<button type="button" class="mx-auto block px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors" data-current-location>Use Current Location</button>`;
  return wrapperClass ? `<div class="${wrapperClass}">${button}</div>` : button;
}

function renderWeatherWidget({ locationName = "", lat = "", lon = "", mode = "lookup" } = {}) {
  const hasCoordinates = Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) && lat !== "" && lon !== "";
  const attrs = [
    ["data-weather-widget", ""],
    ["data-mode", mode],
    ["data-location", locationName],
    ["data-lat", lat],
    ["data-lon", lon],
  ]
    .map(([key, value]) => `${key}="${escapeHtml(value)}"`)
    .join(" ");

  return `<div class="bg-white p-6 rounded-lg shadow-lg max-w-2xl mx-auto" ${attrs}>
    <div class="text-center mb-6">
      <h2 class="text-2xl font-bold text-gray-800" data-weather-location>${escapeHtml(locationName || "Choose a location")}</h2>
      <p class="text-sm text-gray-600" data-weather-coordinates>${
        hasCoordinates ? formatCoordinates(lat, lon) : "Search or use your current location to load weather."
      }</p>
      <p class="sr-only" data-weather-status>Idle</p>
    </div>
    <div class="grid grid-cols-2 gap-4" data-weather-grid>
      <div class="bg-blue-50 p-4 rounded-lg">
        <h3 class="text-lg font-semibold text-blue-800 mb-2">Wet Bulb Temperature</h3>
        <p class="text-3xl font-bold text-blue-600" data-weather-wetbulb>--</p>
      </div>
      <div class="bg-gray-50 p-4 rounded-lg">
        <h3 class="text-lg font-semibold text-gray-800 mb-2">Air Temperature</h3>
        <p class="text-3xl font-bold text-gray-600" data-weather-temp>--</p>
      </div>
      <div class="bg-gray-50 p-4 rounded-lg">
        <h3 class="text-lg font-semibold text-gray-800 mb-2">Relative Humidity</h3>
        <p class="text-3xl font-bold text-gray-600" data-weather-humidity>--</p>
      </div>
      <div class="bg-gray-50 p-4 rounded-lg">
        <h3 class="text-lg font-semibold text-gray-800 mb-2">Last Updated</h3>
        <p class="text-lg text-gray-600" data-weather-updated>${hasCoordinates ? "Fetching latest weather..." : "Waiting for weather"}</p>
      </div>
    </div>
    <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" data-weather-error hidden></div>
  </div>`;
}

function renderForecastWidget(routePath, cityName) {
  return `<section class="rounded-lg border border-gray-200 bg-white p-6" aria-labelledby="wet-bulb-forecast-heading" data-forecast-widget data-forecast-path="${escapeHtml(routePath)}">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="wet-bulb-forecast-heading" class="text-2xl font-bold text-gray-800">Five-day maximum wet bulb temperature forecast for ${escapeHtml(cityName)}</h2>
      <p class="text-sm text-gray-600" data-forecast-status>Loading forecast…</p>
    </div>
    <div class="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-5" data-forecast-days aria-live="polite"></div>
    <div class="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-forecast-error hidden></div>
  </section>`;
}

function renderForecastSourceNotes(routePath) {
  return `<section aria-labelledby="forecast-source-notes-heading" data-forecast-source-notes class="mt-4 border-t border-gray-200 pt-4 text-sm text-gray-600">
    <h3 id="forecast-source-notes-heading" class="font-semibold text-gray-800">Forecast notes</h3>
    <p class="mt-2">Today's card covers only remaining local hours; if no forecast hour remains, it shows no upcoming high. The other four dates cover complete local days.</p>
    <p class="mt-2">Forecast wet bulb temperature values are calculated from hourly temperature, dew point, and surface pressure using the Romps thermodynamic liquid-water method.</p>
    <p class="mt-2">Forecast weather data: ECMWF IFS 0.25° model, provided by <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">Open-Meteo</a> (ECMWF data under CC BY 4.0). <span data-forecast-updated></span></p>
    <p class="mt-2">Forecasts can change and are not a substitute for heat safety guidance or local warnings.</p>
  </section>`;
}

function renderListSection({ title, items, emptyMessage, backLink = "" }) {
  return `<div class="mt-6">
    ${backLink}
    <h1 class="text-3xl font-bold mb-6">${escapeHtml(title)}</h1>
    ${
      items.length
        ? `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">${items.join("")}</div>`
        : `<div class="p-4 border rounded-lg bg-gray-50"><p>${escapeHtml(emptyMessage)}</p></div>`
    }
  </div>`;
}

export const INHABITED_HOTSPOTS_PATH = "/wetbulb-temperature/forecast/global-hotspots/";
export const GLOBAL_GRID_HOTSPOTS_PATH = "/wetbulb-temperature/forecast/global-grid-hotspots/";

// Server-rendered so crawlers and no-JS visitors see it; omitted when the product gate is off
// because the route then returns 404.
function renderSiteNav(options = {}, routePath = "") {
  if (options.hotspotEnabled !== true) return "";
  const current = routePath === INHABITED_HOTSPOTS_PATH ? ` aria-current="page"` : "";
  return `
      <nav aria-label="Forecast hotspots" class="text-center text-sm">
      <a href="${INHABITED_HOTSPOTS_PATH}"${current} class="inline-block rounded-full border border-orange-300 bg-orange-50 px-4 py-2 font-semibold text-orange-900 hover:bg-orange-100 focus:outline-none focus:ring-2 focus:ring-orange-500">Top 50 inhabited hotspots</a>
    </nav>`;
}

function renderAppFrame(content, { cityPage = false, options = {}, routePath = "" } = {}) {
  return `<main class="min-h-screen bg-gray-50 py-8 px-4">
    <div class="max-w-4xl mx-auto space-y-8">
      ${cityPage ? renderCityHeader() : renderHeader()}${renderSiteNav(options, routePath)}
      <div class="space-y-6">${content}</div>
    </div>
    ${renderFooter()}
  </main>`;
}

function formatMonthList(months) {
  if (months.length < 2) return months[0] ?? "";
  if (months.length === 2) return `${months[0]} and ${months[1]}`;
  return `${months.slice(0, -1).join(", ")}, and ${months.at(-1)}`;
}

function sourceReference(noteId, label, number, referenceId) {
  return `<sup><a href="#source-note-${noteId}" id="source-note-${referenceId}-ref" data-source-reference aria-label="Read source note: ${label}">${number}</a></sup>`;
}

function sourceBacklink(referenceId, label) {
  return `<a href="#source-note-${referenceId}-ref" data-source-backlink="source-note-${referenceId}-ref" aria-label="Back to ${label} reference">↩</a>`;
}

const KOPPEN_SOURCE_NOTE = `<li id="source-note-koppen"><a class="text-blue-600 hover:underline" href="https://doi.org/10.6084/m9.figshare.21789074.v3" target="_blank" rel="noopener noreferrer">Beck et al. Köppen-Geiger</a> 1991–2020 map data are licensed under <a class="text-blue-600 hover:underline" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>. The classification is sampled at the city-center grid cell and checked against the surrounding 3×3 cells. ${sourceBacklink("koppen", "Köppen-Geiger")}</li>`;
const NASA_POWER_SOURCE_NOTE = `<li id="source-note-nasa-power"><a class="text-blue-600 hover:underline" href="https://power.larc.nasa.gov/" target="_blank" rel="noopener noreferrer">NASA POWER</a> modeled 1991–2020 climatology uses a coarse MERRA-2 grid and local solar time. These are modeled monthly means, not station observations or records, and may not reflect neighborhood conditions. ${sourceBacklink("nasa-power-peak", "NASA POWER peak")} ${sourceBacklink("nasa-power-table", "NASA POWER table")}</li>`;

function renderClimateSourceNotes(city, routePath) {
  const enrichment = city.enrichment ?? popular40EnrichmentByPath.get(routePath);
  if (!enrichment) {
    const climate = city.climate;
    if (!climate?.koppen && !climate?.nasaPower) return "";
    return `<section aria-labelledby="climate-source-notes-heading" class="mt-4 border-t border-gray-200 pt-4 text-sm text-gray-600">
    <h3 id="climate-source-notes-heading" class="font-semibold text-gray-800">Climate context sources</h3>
    <ol class="mt-2 list-decimal space-y-2 pl-5">
      ${[climate.koppen ? KOPPEN_SOURCE_NOTE : "", climate.nasaPower ? NASA_POWER_SOURCE_NOTE : ""].filter(Boolean).join("\n      ")}
    </ol>
  </section>`;
  }
  return `<section aria-labelledby="climate-source-notes-heading" class="mt-4 border-t border-gray-200 pt-4 text-sm text-gray-600">
    <h3 id="climate-source-notes-heading" class="font-semibold text-gray-800">Climate context sources</h3>
    <ol class="mt-2 list-decimal space-y-2 pl-5">
      <li id="source-note-geonames"><a class="text-blue-600 hover:underline" href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">GeoNames</a> supplies the reviewed place identity, timezone, and approximate elevation. GeoNames data are licensed under <a class="text-blue-600 hover:underline" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>. ${sourceBacklink("geonames-timezone", "GeoNames timezone")} ${sourceBacklink("geonames-elevation", "GeoNames elevation")}</li>
      ${KOPPEN_SOURCE_NOTE}
      ${NASA_POWER_SOURCE_NOTE}
    </ol>
  </section>`;
}

function renderNearby(nearby) {
  if (!nearby?.length) return "";
  const items = nearby.map(({ path, label, km }) => `<li><a href="${escapeHtml(path)}" class="text-blue-600 hover:underline">${escapeHtml(label)}</a> <span class="text-sm text-gray-500">${km} km</span></li>`);
  return `
    <section aria-labelledby="nearby-heading" class="rounded-lg border border-gray-200 bg-white p-6">
      <h2 id="nearby-heading" class="text-2xl font-bold text-gray-800 mb-3">Nearby locations</h2>
      <ul class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-gray-700">${items.join("")}</ul>
    </section>`;
}

function koppenSentence(city, koppen, number) {
  return `${escapeHtml(city.name)} and the surrounding area have a ${escapeHtml(koppen.label.toLowerCase())} climate classification (${escapeHtml(koppen.code)}). ${sourceReference("koppen", "Köppen-Geiger", number, "koppen")}`;
}

function renderMonthlyWetBulb(city, nasaPower, number, peakClass) {
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthlyRows = nasaPower.monthlyC.map((value, index) => `<tr><th scope="row" class="px-3 py-2 text-left font-medium">${monthNames[index]}</th><td class="px-3 py-2 text-right">${value.toFixed(1)} °C</td></tr>`).join("");
  const peakMonths = nasaPower.peakMonths.map((month) => monthNames[month - 1]);
  const peakValues = nasaPower.peakMonths.map((month) => nasaPower.monthlyC[month - 1]);
  const peakValue = Math.max(...peakValues).toFixed(1);
  const cityLocation = `${city.name}, ${city.resolvedAdmin1Code}`;
  const isTiedPeak = peakMonths.length > 1;
  return `
    <p class="${peakClass}text-gray-700">${escapeHtml(formatMonthList(peakMonths))} ${isTiedPeak ? "are" : "is"} predicted to be the highest wet bulb ${isTiedPeak ? "months" : "month"} for ${escapeHtml(cityLocation)}, with a mean wet bulb temperature of ${peakValue} °C. ${sourceReference("nasa-power", "NASA POWER", number, "nasa-power-peak")}</p>
    <div class="mt-4 overflow-x-auto"><table class="w-full border-collapse text-sm text-gray-700"><caption class="mb-2 text-left font-semibold text-gray-800">Monthly mean wet bulb temperatures for ${escapeHtml(cityLocation)} ${sourceReference("nasa-power", "NASA POWER", number, "nasa-power-table")}</caption><thead><tr class="border-b border-gray-200"><th scope="col" class="px-3 py-2 text-left">Month</th><th scope="col" class="px-3 py-2 text-right">Wet bulb</th></tr></thead><tbody>${monthlyRows}</tbody></table></div>`;
}

/** Non-Popular routes: GeoNames facts already appear in "About"; show only climate values that passed generation gates. */
function renderAllLocationClimate(city) {
  const climate = city.climate;
  if (!climate?.koppen && !climate?.nasaPower) return "";
  const koppen = climate.koppen ? `
    <p class="text-gray-700">${koppenSentence(city, climate.koppen, 1)}</p>` : "";
  const monthly = climate.nasaPower ? renderMonthlyWetBulb(city, climate.nasaPower, climate.koppen ? 2 : 1, climate.koppen ? "mt-4 " : "") : "";
  return `<section aria-labelledby="city-climate-context-heading" class="rounded-lg border border-gray-200 bg-white p-6">
    <h2 id="city-climate-context-heading" class="text-2xl font-bold text-gray-800 mb-3">Climate context for ${escapeHtml(city.name)}</h2>${koppen}${monthly}
  </section>`;
}

function renderClimateContext(city, routePath) {
  const enrichment = city.enrichment ?? popular40EnrichmentByPath.get(routePath);
  if (!enrichment) return renderAllLocationClimate(city);
  const elevation = enrichment.geonames.elevationM === null ? "Unavailable" : `${enrichment.geonames.elevationM} m`;
  return `<section aria-labelledby="city-climate-context-heading" class="rounded-lg border border-gray-200 bg-white p-6">
    <h2 id="city-climate-context-heading" class="text-2xl font-bold text-gray-800 mb-3">Climate context for ${escapeHtml(city.name)}</h2>
    <p class="text-gray-700">${koppenSentence(city, enrichment.koppenGeiger, 2)}</p>
    <dl class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm text-gray-700">
      <div><dt class="font-semibold">IANA timezone</dt><dd>${escapeHtml(enrichment.geonames.timezone)} ${sourceReference("geonames", "GeoNames", 1, "geonames-timezone")}</dd></div>
      <div><dt class="font-semibold">Approximate elevation</dt><dd>${escapeHtml(elevation)} ${sourceReference("geonames", "GeoNames", 1, "geonames-elevation")}</dd></div>
    </dl>${renderMonthlyWetBulb(city, enrichment.nasaPower, 3, "mt-5 ")}
  </section>`;
}

function renderLocationFacts(city, routePath) {
  const facts = city.locationFacts;
  if (!facts || typeof facts.snapshot !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(facts.snapshot)) return "";
  const population = Number.isSafeInteger(facts.population) && facts.population > 0 ? facts.population : null;
  let timeZone = null;
  if (typeof facts.timeZone === "string") {
    try { new Intl.DateTimeFormat("en-US", { timeZone: facts.timeZone }); timeZone = facts.timeZone; } catch {}
  }
  const climateAlreadyShowsElevation = Boolean(city.enrichment ?? popular40EnrichmentByPath.get(routePath));
  const elevation = Number.isInteger(facts.elevationM) && facts.elevationM >= -1000 && facts.elevationM <= 9000 && !climateAlreadyShowsElevation
    ? facts.elevationM : null;
  if (population === null && timeZone === null && elevation === null) return "";
  const name = escapeHtml(city.name);
  const snapshotDate = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${facts.snapshot}T12:00:00Z`));
  const paragraphs = [];
  if (population !== null) paragraphs.push(`<p>GeoNames lists a population of ${population.toLocaleString("en-US")} for ${name}. Its population reference year is not provided; the source snapshot is dated ${escapeHtml(snapshotDate)}.</p>`);
  if (timeZone !== null) paragraphs.push(`<p>Local time in ${name}: <time data-local-clock="${escapeHtml(timeZone)}">Loading local time…</time> <span class="text-sm text-gray-600">(${escapeHtml(timeZone)})</span>.</p>`);
  if (elevation !== null) paragraphs.push(`<p>The approximate elevation at the mapped point for ${name} is ${Math.abs(elevation).toLocaleString("en-US")} m ${elevation < 0 ? "below" : "above"} sea level. This is not a citywide average.</p>`);
  return `<section aria-labelledby="city-facts-heading" class="rounded-lg border border-gray-200 bg-white p-6">
    <h2 id="city-facts-heading" class="text-2xl font-bold text-gray-800 mb-3">About ${name}</h2>
    <div class="space-y-2 text-gray-700">${paragraphs.join("")}</div>
    <p class="mt-3 text-sm text-gray-600">Source: <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">GeoNames</a> (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">CC BY 4.0</a>). Values describe the mapped settlement or source point, not an entire metro area.</p>
  </section>`;
}

export function pageHtml(city, options = {}) {
  const siteUrl = options.siteUrl ?? DEFAULT_SITE_URL;
  const cityName = city.name;
  const stateName = city.resolvedAdmin1Code;
  const countryName = city.resolvedCountryName;
  const { countrySlug, stateSlug, citySlug } = getRouteParts(city);
  const routePath = `/wetbulb-temperature/${countrySlug}/${stateSlug}/${citySlug}/`;
  const fullName = `${cityName}, ${stateName}, ${countryName}`;
  // US state names disambiguate city titles; elsewhere retain country context.
  const cityTitleLocation = countryName === "United States" ? `${cityName}, ${stateName}` : fullName;
  const title = `Wet Bulb Temperature in ${cityTitleLocation}`;
  const hasForecast = options.forecastEnabled === true;
  const description = hasForecast
    ? `Get the current wet bulb temperature and five-day maximum wet bulb temperature forecast for ${fullName}.`
    : `Get the current wet bulb temperature for ${fullName}.`;
  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Wet Bulb Temperature", item: `${siteUrl}/wetbulb-temperature/` },
      { "@type": "ListItem", position: 2, name: countryName, item: `${siteUrl}/wetbulb-temperature/${countrySlug}/` },
      { "@type": "ListItem", position: 3, name: stateName, item: `${siteUrl}/wetbulb-temperature/${countrySlug}/${stateSlug}/` },
      { "@type": "ListItem", position: 4, name: cityName, item: `${siteUrl}${routePath}` },
    ],
  };
  const breadcrumbs = `
    <nav aria-label="Breadcrumb" class="text-sm text-gray-600">
      <ol class="flex flex-wrap gap-x-2 gap-y-1" role="list">
        <li><a href="/wetbulb-temperature/" class="text-blue-600 hover:underline">Wet Bulb Temperature</a></li>
        <li aria-hidden="true">/</li>
        <li><a href="/wetbulb-temperature/${escapeHtml(countrySlug)}/" class="text-blue-600 hover:underline">${escapeHtml(countryName)}</a></li>
        <li aria-hidden="true">/</li>
        <li><a href="/wetbulb-temperature/${escapeHtml(countrySlug)}/${escapeHtml(stateSlug)}/" class="text-blue-600 hover:underline">${escapeHtml(stateName)}</a></li>
        <li aria-hidden="true">/</li>
        <li><span aria-current="page">${escapeHtml(cityName)}</span></li>
      </ol>
    </nav>`;
  const climateSourceNotes = renderClimateSourceNotes(city, routePath);
  const forecastSourceNotes = hasForecast ? renderForecastSourceNotes(routePath) : "";
  const methodology = `
    <section aria-labelledby="methodology-heading" class="rounded-lg border border-gray-200 bg-white p-6">
      <h2 id="methodology-heading" class="text-2xl font-bold text-gray-800 mb-3">How we calculate the current wet bulb temperature.</h2>
      <p class="text-gray-700">We use the Stull formula with current air temperature and relative humidity to calculate the wet bulb temperature.</p>
      <p class="mt-3 text-sm text-gray-600">Disclaimer: This estimate has limitations and is not a substitute for heat safety guidance, local warnings, or professional advice.</p>
      <div class="mt-4 border-t border-gray-200 pt-4 text-sm text-gray-600">
        <p>Weather data provided by <a href="https://openweathermap.org/" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">OpenWeather</a>.</p>
        <a href="https://openweathermap.org/" target="_blank" rel="noopener noreferrer" class="mt-2 inline-flex rounded bg-gray-800 p-2" aria-label="OpenWeather">
          <img src="/openweather-logo.png" alt="OpenWeather" width="117" height="50" class="block object-contain">
        </a>
      </div>${forecastSourceNotes}${climateSourceNotes}
    </section>`;

  const cityContent = `
    ${renderSearchBox()}
    ${renderCurrentLocationButton({ wrapperClass: "mt-8" })}
    ${breadcrumbs}
    <section aria-labelledby="city-page-heading">
      <h1 id="city-page-heading" class="text-4xl font-bold text-gray-900">${escapeHtml(title)}</h1>
      <p class="mt-3 text-gray-700">${escapeHtml(description)}</p>
    </section>
    ${renderWeatherWidget({
      locationName: fullName,
      lat: Number(city.latitude),
      lon: Number(city.longitude),
      mode: "city",
    })}${hasForecast ? renderForecastWidget(routePath, cityName) : ""}${renderLocationFacts(city, routePath)}${renderClimateContext(city, routePath)}${renderNearby(city.nearby)}
    ${methodology}
  `;

  return pageShell({
    siteUrl,
    routePath,
    title,
    description,
    breadcrumbData,
    mainContent: renderAppFrame(cityContent, { cityPage: true, options, routePath }),
    googleAnalyticsId: options.googleAnalyticsId,
  });
}

export function renderHomePage(siteData, options = {}) {
  const siteUrl = options.siteUrl ?? DEFAULT_SITE_URL;
  const routePath = "/";
  const title = "Current Wet Bulb Temperature";
  const description = "Get real-time wet bulb temperature, humidity, and air temperature for your location or browse our static location index.";
  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: siteUrl }],
  };

  const content = `
    ${renderSearchBox()}
    ${renderCurrentLocationButton()}
    <nav aria-label="Location directory" class="text-sm text-blue-600 underline">
      <a href="/wetbulb-temperature">browse all wet bulb temperatures</a>
    </nav>
    ${renderWeatherWidget({ mode: "home" })}
    ${renderDisclaimer()}
  `;

  return pageShell({
    siteUrl,
    routePath,
    title,
    description,
    breadcrumbData,
    mainContent: renderAppFrame(content, { options, routePath }),
    googleAnalyticsId: options.googleAnalyticsId,
  });
}

function hotspotTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value ?? "");
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

/** Mirrors lib/hotspots/snapshot.ts: a window is current only inside its original bounds. */
export function hotspotWindowState(snapshot, now = Date.now()) {
  if (Number(now) >= Date.parse(snapshot.validTo)) return "expired";
  return Number(now) < Date.parse(snapshot.validFrom) ? "upcoming" : "active";
}

function hotspotWindowNotice(snapshot, state) {
  const window = `${escapeHtml(hotspotTimestamp(snapshot.validFrom))} – ${escapeHtml(hotspotTimestamp(snapshot.validTo))}`;
  if (state === "upcoming") {
    return `<p class="mt-3 border-l-4 border-blue-500 bg-blue-50 px-4 py-3 text-sm text-blue-950" data-hotspot-window-state="upcoming">Fixed 24-hour forecast window: ${window}. It begins at ${escapeHtml(hotspotTimestamp(snapshot.validFrom))}.</p>`;
  }
  return `<p class="mt-3 border-l-4 border-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-950" data-hotspot-window-state="active">This ranking is for the original fixed forecast window ${window}, which has already begun. It is not a rolling next-24-hours forecast; peak times marked “passed” are no longer upcoming.</p>`;
}

function hotspotPeakCell(peakTime, now) {
  const passed = Date.parse(peakTime) <= Number(now);
  return `${escapeHtml(hotspotTimestamp(peakTime))}${passed ? ` <span class="text-xs font-semibold uppercase text-gray-500">(passed)</span>` : ""}`;
}

function hotspotProductLink(enabled, href, label) {
  return enabled ? `<p class="mt-2"><a class="font-semibold text-blue-700 hover:underline" href="${href}">${label}</a></p>` : "";
}

const GLOBAL_GRID_LINK_LABEL = "Unfiltered global grid-cell hotspots: every ECMWF model cell, including ocean and uninhabited areas (not a ranking of inhabited locations)";
const INHABITED_LINK_LABEL = "Top 50 inhabited hotspots: the separate hourly ranking of WetBulb35 locations";

export function renderHotspotPage(snapshot, options = {}) {
  const siteUrl = options.siteUrl ?? DEFAULT_SITE_URL;
  const routePath = INHABITED_HOTSPOTS_PATH;
  const now = Number(options.now ?? Date.now());
  const state = hotspotWindowState(snapshot, now);
  if (state === "expired") return renderHotspotUnavailablePage("inhabited", { reason: "expired", snapshot }, options);
  const title = "Top 50 Inhabited Wet Bulb Forecast Hotspots";
  const description = `Highest forecast wet bulb temperatures for one fixed 24-hour window among ${Number(snapshot.counts.corpus).toLocaleString("en-US")} inhabited locations tracked by WetBulb35.`;
  const recallNotice = snapshot.validation?.recallWarning
    ? `<p class="border-l-4 border-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-950">Today’s excluded-location control sample placed at least one control in the top 20. This snapshot remains visible for validation, but the discovery margin requires recalibration before stronger recall claims.</p>`
    : "";
  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Wet Bulb Temperature", item: `${siteUrl}/wetbulb-temperature/` },
      { "@type": "ListItem", position: 2, name: "Top 50 Inhabited Hotspots", item: `${siteUrl}${routePath}` },
    ],
  };
  const rows = snapshot.hotspots.map((hotspot) => `<tr class="border-t border-gray-200">
      <td class="py-3 pr-3 font-semibold text-gray-700">${hotspot.rank}</td>
      <td class="py-3 pr-3"><a class="font-semibold text-blue-700 hover:underline" href="${escapeHtml(hotspot.path)}">${escapeHtml(hotspot.name)}</a><div class="text-sm text-gray-600">${escapeHtml(hotspot.state)}, ${escapeHtml(hotspot.country)}</div></td>
      <td class="py-3 pr-3 whitespace-nowrap font-bold text-red-700">${Number(hotspot.maximumWetBulbC).toFixed(1)}°C</td>
      <td class="py-3 pr-3 whitespace-nowrap">${hotspotPeakCell(hotspot.peakTime, now)}</td>
      <td class="py-3 whitespace-nowrap">${Number(hotspot.airTemperatureC).toFixed(1)}°C</td>
    </tr>`).join("");
  const lastUpdated = snapshot.discovery.retrievedAt
    ? `<div class="rounded border border-gray-200 p-3"><dt class="font-semibold text-gray-700">Model data retrieved</dt><dd>${escapeHtml(hotspotTimestamp(snapshot.discovery.retrievedAt))}</dd></div>`
    : "";
  const content = `<section class="bg-white p-6 rounded-lg shadow-md space-y-5" aria-labelledby="hotspot-heading">
    <div>
      <h2 id="hotspot-heading" class="text-3xl font-bold text-gray-900 mb-2">Top 50 inhabited wet bulb forecast hotspots</h2>
      <p class="text-gray-700">Highest maximum wet bulb temperatures forecast during one fixed 24-hour window among ${Number(snapshot.counts.corpus).toLocaleString("en-US")} WetBulb35 locations.</p>
      ${hotspotProductLink(options.globalGridHotspotEnabled === true, GLOBAL_GRID_HOTSPOTS_PATH, GLOBAL_GRID_LINK_LABEL)}
      ${hotspotWindowNotice(snapshot, state)}
      ${recallNotice}
    </div>
    <dl class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
      <div class="rounded border border-gray-200 p-3"><dt class="font-semibold text-gray-700">Forecast window</dt><dd>${escapeHtml(hotspotTimestamp(snapshot.validFrom))} – ${escapeHtml(hotspotTimestamp(snapshot.validTo))}</dd></div>
      <div class="rounded border border-gray-200 p-3"><dt class="font-semibold text-gray-700">Last updated</dt><dd>${escapeHtml(hotspotTimestamp(snapshot.generatedAt))}</dd></div>
      <div class="rounded border border-gray-200 p-3"><dt class="font-semibold text-gray-700">ECMWF IFS run initialized</dt><dd>${escapeHtml(hotspotTimestamp(snapshot.discovery.initialization))}</dd></div>
      ${lastUpdated}
      <div class="rounded border border-gray-200 p-3"><dt class="font-semibold text-gray-700">Candidate locations</dt><dd>${Number(snapshot.counts.candidates).toLocaleString("en-US")}</dd></div>
    </dl>
    <div class="overflow-x-auto">
      <table class="min-w-full text-left" aria-label="Top 50 inhabited wet bulb forecast hotspot rankings">
        <thead><tr class="text-sm text-gray-600"><th class="pb-2 pr-3">Rank</th><th class="pb-2 pr-3">Location</th><th class="pb-2 pr-3">Maximum wet bulb</th><th class="pb-2 pr-3">Peak time (UTC)</th><th class="pb-2">Air temperature</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>
  <section class="bg-white p-6 rounded-lg shadow-md space-y-3" aria-labelledby="hotspot-method-heading">
    <h2 id="hotspot-method-heading" class="text-2xl font-bold text-gray-900">How this forecast is calculated</h2>
    <p class="text-gray-700">A global ECMWF Open Data grid scan identifies warm, humid land regions. All tracked WetBulb35 locations in those buffered regions are then refined with hourly ECMWF IFS 0.25° forecasts from Open-Meteo, pinned to the same model run. Wet bulb temperature is calculated from simultaneous air temperature, dew point, and surface pressure using the Romps thermodynamic liquid-water method.</p>
    <p class="text-gray-700">${Number(snapshot.counts.discoveredCandidates).toLocaleString("en-US")} discovery candidates and ${Number(snapshot.counts.excludedControls).toLocaleString("en-US")} deterministic excluded-location controls received hourly refinement. The controls help detect candidate-reduction misses; periodic broader scans are still required before making an absolute highest-on-Earth claim.</p>
    <p class="text-gray-700">This is a model forecast, not a weather-station observation or a health threshold. Rankings may change as forecast models update, and nearby locations can share the same source model cell.</p>
    <p class="text-sm text-gray-600">Sources: ECMWF Open Data (CC BY 4.0) and Open-Meteo. Method: ${escapeHtml(snapshot.method.name)} (${escapeHtml(snapshot.method.version)}). Model: ${escapeHtml(snapshot.provider.model)}, run ${escapeHtml(snapshot.discovery.initialization)}.</p>
  </section>`;
  return pageShell({
    siteUrl,
    routePath,
    title,
    description,
    breadcrumbData,
    mainContent: renderAppFrame(content, { options, routePath }),
    googleAnalyticsId: options.googleAnalyticsId,
  });
}

export function renderGlobalGridHotspotPage(snapshot, options = {}) {
  const siteUrl = options.siteUrl ?? DEFAULT_SITE_URL;
  const routePath = GLOBAL_GRID_HOTSPOTS_PATH;
  const now = Number(options.now ?? Date.now());
  const state = hotspotWindowState(snapshot, now);
  if (state === "expired") return renderHotspotUnavailablePage("global-grid", { reason: "expired", snapshot }, options);
  const title = "Global ECMWF Grid-Cell Wet Bulb Forecast Hotspots";
  const description = "Ranked wet bulb forecast hotspots for one fixed 24-hour window from global ECMWF 0.25° model grid cells over land and ocean.";
  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Wet Bulb Temperature", item: `${siteUrl}/wetbulb-temperature/` },
      { "@type": "ListItem", position: 2, name: "Global Grid Forecast Hotspots", item: `${siteUrl}${routePath}` },
    ],
  };
  const rows = snapshot.hotspots.map((hotspot) => {
    const coordinates = `${hotspot.latitude},${hotspot.longitude}`;
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coordinates)}`;
    return `<tr class="border-t border-gray-200">
      <td class="py-3 pr-3 font-semibold text-gray-700">${hotspot.rank}</td>
      <td class="py-3 pr-3 whitespace-nowrap"><a class="font-semibold text-blue-700 hover:underline" href="${escapeHtml(mapUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(formatCoordinates(hotspot.latitude, hotspot.longitude))}</a></td>
      <td class="py-3 pr-3 whitespace-nowrap font-bold text-red-700">${Number(hotspot.maximumWetBulbC).toFixed(1)}°C</td>
      <td class="py-3 pr-3 whitespace-nowrap">${hotspotPeakCell(hotspot.peakTime, now)}</td>
      <td class="py-3 pr-3 whitespace-nowrap">${Number(hotspot.airTemperatureC).toFixed(1)}°C</td>
      <td class="py-3 whitespace-nowrap">${Number(hotspot.dewPointC).toFixed(1)}°C</td>
    </tr>`;
  }).join("");
  const interval = snapshot.model.interval === "hourly-interpolated" ? "hourly, interpolated from three-hourly steps" : "three-hourly";
  const content = `<section class="bg-white p-6 rounded-lg shadow-md space-y-5" aria-labelledby="global-grid-hotspot-heading">
    <div>
      <h2 id="global-grid-hotspot-heading" class="text-3xl font-bold text-gray-900 mb-2">Global ECMWF grid-cell wet bulb forecast hotspots</h2>
      <p class="text-gray-700">This unfiltered ranking covers global ECMWF 0.25° model grid cells including land and ocean, with no inhabited-location filter.</p>
      <p class="mt-2 text-gray-700">Each coordinate links to its model grid cell area in Google Maps. Values are model forecasts, not weather-station observations.</p>
      ${hotspotProductLink(options.hotspotEnabled === true, INHABITED_HOTSPOTS_PATH, INHABITED_LINK_LABEL)}
      ${hotspotWindowNotice(snapshot, state)}
    </div>
    <dl class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
      <div class="rounded border border-gray-200 p-3"><dt class="font-semibold text-gray-700">Forecast window</dt><dd>${escapeHtml(hotspotTimestamp(snapshot.validFrom))} – ${escapeHtml(hotspotTimestamp(snapshot.validTo))}</dd></div>
      <div class="rounded border border-gray-200 p-3"><dt class="font-semibold text-gray-700">Model initialized</dt><dd>${escapeHtml(hotspotTimestamp(snapshot.model.initialization))}</dd></div>
      ${snapshot.model.retrievedAt ? `<div class="rounded border border-gray-200 p-3"><dt class="font-semibold text-gray-700">Last updated</dt><dd>${escapeHtml(hotspotTimestamp(snapshot.generatedAt))}</dd></div>` : ""}
      <div class="rounded border border-gray-200 p-3"><dt class="font-semibold text-gray-700">Published grid cells</dt><dd>${Number(snapshot.counts.published).toLocaleString("en-US")}</dd></div>
    </dl>
    <div class="overflow-x-auto">
      <table class="min-w-full text-left" aria-label="Global ECMWF grid-cell wet bulb forecast hotspot rankings">
        <thead><tr class="text-sm text-gray-600"><th class="pb-2 pr-3">Rank</th><th class="pb-2 pr-3">Grid coordinates</th><th class="pb-2 pr-3">Maximum wet bulb</th><th class="pb-2 pr-3">Peak time (UTC)</th><th class="pb-2 pr-3">Air temperature</th><th class="pb-2">Dew point</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>
  <section class="bg-white p-6 rounded-lg shadow-md space-y-3" aria-labelledby="global-grid-hotspot-method-heading">
    <h2 id="global-grid-hotspot-method-heading" class="text-2xl font-bold text-gray-900">Method and coverage</h2>
    <p class="text-gray-700">Wet bulb temperature is calculated from simultaneous air temperature, dew point, and surface pressure using the ${escapeHtml(snapshot.method.name)} (${escapeHtml(snapshot.method.version)}).</p>
    <p class="text-gray-700">Model source: ${escapeHtml(snapshot.model.source)}; initialization: ${escapeHtml(hotspotTimestamp(snapshot.model.initialization))}; interval: ${escapeHtml(interval)}; resolution: ${escapeHtml(snapshot.model.resolution)}. ${Number(snapshot.counts.gridCells).toLocaleString("en-US")} grid cells were available and ${Number(snapshot.counts.evaluatedWarmCells).toLocaleString("en-US")} warm cells were evaluated.</p>
    <p class="text-gray-700">This static snapshot is generated separately and served without live provider requests.</p>
  </section>`;
  return pageShell({
    siteUrl,
    routePath,
    title,
    description,
    breadcrumbData,
    mainContent: renderAppFrame(content, { options, routePath }),
    googleAnalyticsId: options.googleAnalyticsId,
  });
}

/**
 * Keeps each hotspot URL usable when no current ranking exists. An expired snapshot shows only
 * its original window bounds, never its values, so nothing past validTo reads as current.
 */
export function renderHotspotUnavailablePage(product, { reason = "unpublished", snapshot = null } = {}, options = {}) {
  const siteUrl = options.siteUrl ?? DEFAULT_SITE_URL;
  const inhabited = product === "inhabited";
  const routePath = inhabited ? INHABITED_HOTSPOTS_PATH : GLOBAL_GRID_HOTSPOTS_PATH;
  const title = inhabited ? "Top 50 Inhabited Wet Bulb Forecast Hotspots" : "Global ECMWF Grid-Cell Wet Bulb Forecast Hotspots";
  const heading = inhabited ? "Top 50 inhabited wet bulb forecast hotspots" : "Global ECMWF grid-cell wet bulb forecast hotspots";
  const description = "No current hotspot forecast ranking is available right now. A new ranking is published after the next complete ECMWF IFS model run.";
  const ended = reason === "expired" && snapshot
    ? `<p class="mt-3 text-gray-700">The last published forecast window (${escapeHtml(hotspotTimestamp(snapshot.validFrom))} – ${escapeHtml(hotspotTimestamp(snapshot.validTo))}) has ended, so its ranking is no longer shown.</p>`
    : "";
  const otherLink = inhabited
    ? hotspotProductLink(options.globalGridHotspotEnabled === true, GLOBAL_GRID_HOTSPOTS_PATH, GLOBAL_GRID_LINK_LABEL)
    : hotspotProductLink(options.hotspotEnabled === true, INHABITED_HOTSPOTS_PATH, INHABITED_LINK_LABEL);
  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Wet Bulb Temperature", item: `${siteUrl}/wetbulb-temperature/` },
      { "@type": "ListItem", position: 2, name: inhabited ? "Top 50 Inhabited Hotspots" : "Global Grid Forecast Hotspots", item: `${siteUrl}${routePath}` },
    ],
  };
  const content = `<section class="bg-white p-6 rounded-lg shadow-md" aria-labelledby="hotspot-unavailable-heading" data-hotspot-unavailable="${escapeHtml(reason)}">
    <h2 id="hotspot-unavailable-heading" class="text-3xl font-bold text-gray-900 mb-2">${heading}</h2>
    <p class="border-l-4 border-gray-500 bg-gray-100 px-4 py-3 text-gray-900" role="status">No current forecast ranking is available. A new ranking is published after the next complete ECMWF IFS model run passes validation.</p>
    ${ended}
    ${otherLink}
    <p class="mt-2"><a class="font-semibold text-blue-700 hover:underline" href="/wetbulb-temperature/">Browse current wet bulb temperatures by location</a></p>
  </section>`;
  return pageShell({
    siteUrl,
    routePath,
    title,
    description,
    breadcrumbData,
    mainContent: renderAppFrame(content, { options, routePath }),
    googleAnalyticsId: options.googleAnalyticsId,
  });
}

export function renderBrowsePage(siteData, options = {}) {
  const siteUrl = options.siteUrl ?? DEFAULT_SITE_URL;
  const routePath = "/wetbulb-temperature/";
  const title = "Wet Bulb Temperature by Country";
  const description = "Browse wet bulb temperature data by country, then drill into states and cities.";
  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [{ "@type": "ListItem", position: 1, name: "Wet Bulb Temperature", item: `${siteUrl}/wetbulb-temperature/` }],
  };

  const countryCards = siteData.countries.map(
    (country) => `<a class="p-4 border rounded-lg hover:bg-gray-50 transition-colors" href="/wetbulb-temperature/${country.slug}/">
      <div class="font-semibold">${escapeHtml(country.name)}</div>
      <div class="text-sm text-gray-500">${country.count} locations</div>
    </a>`,
  );
  const popularCityCards = (siteData.popularCities || []).map((city) => {
    const labelParts = [city.name, city.stateName ?? city.resolvedAdmin1Code, city.countryName ?? city.resolvedCountryName]
      .filter((value, index, values) => value && values.findIndex((candidate) => String(candidate).toLocaleLowerCase("en") === String(value).toLocaleLowerCase("en")) === index);
    return `<a class="text-blue-600 hover:underline" href="${city.path ?? routePathForCity(city)}">${labelParts.map(escapeHtml).join(", ")}</a>`;
  });

  const content = `
    ${options.hotspotEnabled ? `<section aria-labelledby="global-hotspot-forecast" class="mb-10 rounded-lg border border-orange-200 bg-orange-50 p-5"><h2 id="global-hotspot-forecast" class="text-2xl font-bold mb-2">Global inhabited wet bulb forecast hotspots</h2><p class="text-gray-700 mb-3">See the highest forecast wet bulb temperatures for the latest published 24-hour forecast window.</p><a class="font-semibold text-blue-700 hover:underline" href="/wetbulb-temperature/forecast/global-hotspots/">View the Top 50 inhabited hotspots</a></section>` : ""}
    ${popularCityCards.length ? `<section aria-labelledby="popular-wet-bulb-temperatures" class="mb-10"><h2 id="popular-wet-bulb-temperatures" class="text-2xl font-bold mb-4">Popular Wet Bulb Temperatures</h2><div class="grid grid-cols-1 md:grid-cols-2 gap-3">${popularCityCards.map((card) => `<div>${card}</div>`).join("")}</div></section>` : ""}
    ${renderListSection({
      title: "Browse Wet Bulb Temperature by Country",
      items: countryCards,
      emptyMessage: "No countries found.",
    })}
  `;

  return pageShell({
    siteUrl,
    routePath,
    title,
    description,
    breadcrumbData,
    mainContent: renderAppFrame(content, { options, routePath }),
    googleAnalyticsId: options.googleAnalyticsId,
  });
}

export function renderCountryPage(country, options = {}) {
  const siteUrl = options.siteUrl ?? DEFAULT_SITE_URL;
  const routePath = `/wetbulb-temperature/${country.slug}/`;
  const title = `Wet Bulb Temperature in ${country.name}`;
  const description = `Browse wet bulb temperature data for states and provinces in ${country.name}.`;
  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Wet Bulb Temperature", item: `${siteUrl}/wetbulb-temperature/` },
      { "@type": "ListItem", position: 2, name: country.name, item: `${siteUrl}${routePath}` },
    ],
  };

  const stateCards = [...country.states].sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug)).map(
    (state) => `<a class="p-4 border rounded-lg hover:bg-gray-50 transition-colors" href="/wetbulb-temperature/${country.slug}/${state.slug}/">
      <div class="font-semibold">${escapeHtml(state.name)}</div>
      <div class="text-sm text-gray-500">${state.count} locations</div>
    </a>`,
  );

  const content = `
    ${renderListSection({
      title: `Browse ${country.name} by State/Province`,
      items: stateCards,
      emptyMessage: "No states or provinces found for this country.",
      backLink: `<div class="mb-6"><a href="/wetbulb-temperature/" class="text-blue-600 hover:underline">← Back to Countries</a></div>`,
    })}
  `;

  return pageShell({
    siteUrl,
    routePath,
    title,
    description,
    breadcrumbData,
    mainContent: renderAppFrame(content, { options, routePath }),
    googleAnalyticsId: options.googleAnalyticsId,
  });
}

export function renderStatePage(state, options = {}) {
  const siteUrl = options.siteUrl ?? DEFAULT_SITE_URL;
  const routePath = `/wetbulb-temperature/${state.countrySlug}/${state.stateSlug}/`;
  const title = `Wet Bulb Temperature in ${state.stateName}, ${state.countryName}`;
  const description = `Browse wet bulb temperature data for cities in ${state.stateName}, ${state.countryName}.`;
  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Wet Bulb Temperature", item: `${siteUrl}/wetbulb-temperature/` },
      { "@type": "ListItem", position: 2, name: state.countryName, item: `${siteUrl}/wetbulb-temperature/${state.countrySlug}/` },
      { "@type": "ListItem", position: 3, name: state.stateName, item: `${siteUrl}${routePath}` },
    ],
  };

  const cityCards = state.cities.map((city) => {
    const href = routePathForCity(city);
    return `<a class="p-4 border rounded-lg hover:bg-gray-50 transition-colors" href="${href}">
      <div class="font-semibold">${escapeHtml(city.name)}</div>
    </a>`;
  });

  const content = `
    ${renderListSection({
      title: `Cities in ${state.stateName}, ${state.countryName}`,
      items: cityCards,
      emptyMessage: "No cities found for this state or province.",
      backLink: `<div class="mb-6"><a href="/wetbulb-temperature/${state.countrySlug}/" class="text-blue-600 hover:underline">← Back to ${escapeHtml(state.countryName)}</a></div>`,
    })}
  `;

  return pageShell({
    siteUrl,
    routePath,
    title,
    description,
    breadcrumbData,
    mainContent: renderAppFrame(content, { options, routePath }),
    googleAnalyticsId: options.googleAnalyticsId,
  });
}

// Busts the 4h browser cache the moment the client changes; the asset path itself is unchanged.
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}
export const CLIENT_RUNTIME_VERSION = fnv1a(clientRuntimeSource());

export function clientRuntimeSource({ placesApiKey = "" } = {}) {
  const normalizedPlacesApiKey = String(placesApiKey ?? "").trim();
  const placesRuntime = normalizedPlacesApiKey
    ? String.raw`
  const googlePlacesApiKey = ${safeJson(normalizedPlacesApiKey)};
  const googlePlacesScriptId = "google-maps-places-sdk";
  const googlePlacesCallbackName = "__wetBulbGooglePlacesReady";
  let googlePlacesPromise = null;

  function hasGooglePlaces() {
    return Boolean(
      window.google &&
      window.google.maps &&
      window.google.maps.places &&
      window.google.maps.places.Autocomplete
    );
  }

  function loadGooglePlaces() {
    if (hasGooglePlaces()) {
      return Promise.resolve(window.google.maps.places);
    }

    if (googlePlacesPromise) {
      return googlePlacesPromise;
    }

    googlePlacesPromise = new Promise((resolve, reject) => {
      window[googlePlacesCallbackName] = () => {
        if (hasGooglePlaces()) {
          resolve(window.google.maps.places);
        } else {
          reject(new Error("Google Places search is unavailable."));
        }
      };

      const existing = document.getElementById(googlePlacesScriptId);
      if (existing) {
        existing.addEventListener("load", () => {
          if (hasGooglePlaces()) {
            resolve(window.google.maps.places);
          }
        }, { once: true });
        existing.addEventListener("error", () => reject(new Error("Google Places search failed to load.")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.id = googlePlacesScriptId;
      script.src =
        "https://maps.googleapis.com/maps/api/js?key=" +
        encodeURIComponent(googlePlacesApiKey) +
        "&libraries=places&callback=" +
        encodeURIComponent(googlePlacesCallbackName);
      script.async = true;
      script.defer = true;
      script.onerror = () => reject(new Error("Google Places search failed to load."));
      document.head.appendChild(script);
    });

    return googlePlacesPromise;
  }

  function placeCoordinate(value) {
    return typeof value === "function" ? value() : value;
  }

  function placeLabel(place, input) {
    return place.formatted_address || place.name || input.value.trim() || "Selected Location";
  }

  function nearestWeatherWidget(form) {
    const localWidget = form.parentElement && form.parentElement.querySelector("[data-weather-widget]");
    return localWidget || document.querySelector("[data-weather-widget]");
  }

  function bindPlacesSearch() {
    document.querySelectorAll("[data-search-form]").forEach((form) => {
      const input = form.querySelector("[data-search-input]");
      const status = form.querySelector("[data-search-status]");
      if (!input) {
        return;
      }

      let autocomplete = null;
      const ensureAutocomplete = () => {
        if (autocomplete) {
          return;
        }

        if (status) status.textContent = "Loading Google Places search.";
        loadGooglePlaces()
          .then(() => {
            if (autocomplete) {
              return;
            }

            autocomplete = new window.google.maps.places.Autocomplete(input, {
              types: ["(cities)"],
              fields: ["geometry", "name", "formatted_address"]
            });
            if (status) status.textContent = "Google Places search ready.";

            autocomplete.addListener("place_changed", async () => {
              const place = autocomplete.getPlace();
              const location = place && place.geometry && place.geometry.location;
              if (!location) {
                if (status) status.textContent = "Choose a suggested city to load weather here.";
                return;
              }

              const lat = Number(placeCoordinate(location.lat));
              const lng = Number(placeCoordinate(location.lng));
              if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                if (status) status.textContent = "Selected city did not include coordinates.";
                return;
              }

              const widget = nearestWeatherWidget(form);
              if (!widget) {
                if (status) status.textContent = "Weather card is unavailable on this page.";
                return;
              }

              const label = placeLabel(place, input);
              input.value = label;
              input.dataset.placesSelected = "true";
              widget.dataset.lat = String(lat);
              widget.dataset.lon = String(lng);
              widget.dataset.location = label;
              trackOnce(form, "PlacesSearch", "location_search_success", { search_method: "places" });

              try {
                await fetchWeather(widget, lat, lng, label, "places_search");
                if (status) status.textContent = "Showing weather for " + label + ".";
              } catch (error) {
                setWeatherError(widget, error instanceof Error ? error.message : "Weather is temporarily unavailable.");
              }
            });
          })
          .catch((error) => {
            if (status) {
              status.textContent = error instanceof Error
                ? error.message + " Static directory search is still available."
                : "Google Places search is unavailable. Static directory search is still available.";
            }
          });
      };

      input.addEventListener("focus", ensureAutocomplete);
      input.addEventListener("click", ensureAutocomplete);
      input.addEventListener("input", () => {
        delete input.dataset.placesSelected;
      });
    });
  }
`
    : String.raw`
  function bindPlacesSearch() {
    document.querySelectorAll("[data-search-form]").forEach((form) => {
      const input = form.querySelector("[data-search-input]");
      const status = form.querySelector("[data-search-status]");
      if (!input) {
        return;
      }

      const showUnavailable = () => {
        if (status) {
          status.textContent = "Google Places search is unavailable. Static directory search is still available.";
        }
      };

      input.addEventListener("focus", showUnavailable, { once: true });
      input.addEventListener("click", showUnavailable, { once: true });
    });
  }
`;

  return String.raw`(() => {
  const botPattern = /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|applebot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|bytespider|crawler|spider|bot)/i;
${placesRuntime}

  function calculateWetBulb(temperature, relativeHumidity) {
    const rh = Math.min(Math.max(relativeHumidity, 5), 99);
    const temp = Math.min(Math.max(temperature, -20), 50);
    const wetBulb =
      temp * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
      Math.atan(temp + rh) -
      Math.atan(rh - 1.676331) +
      0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
      4.686035;

    return Math.round(wetBulb * 100) / 100;
  }

  function isLikelyBot() {
    const ua = navigator.userAgent || "";
    return botPattern.test(ua) || navigator.webdriver === true;
  }

  const analyticsEventFields = {
    location_search_success: ["search_method"], location_search_no_match: ["search_method"],
    current_location_success: [], current_location_failure: ["failure_category"],
    weather_load_success: ["trigger"], weather_load_failure: ["trigger", "failure_category"],
    forecast_view: [], forecast_load_failure: ["failure_category"],
    map_view: [], map_interaction: ["interaction_type"], hotspot_city_click: ["rank_bucket"]
  };
  const analyticsValues = {
    search_method: new Set(["static", "places"]), trigger: new Set(["page_init", "current_location", "places_search"]),
    failure_category: new Set(["denied", "timeout", "unsupported", "http", "invalid_payload", "network", "unknown"]),
    interaction_type: new Set(["pointer", "keyboard", "zoom"]), rank_bucket: new Set(["top_10", "top_25", "top_50", "other"])
  };
  function pageType() { return document.querySelector("[data-forecast-widget]") ? "city" : "directory"; }
  function trackAnalyticsEvent(name, parameters = {}) {
    if (!Object.hasOwn(analyticsEventFields, name) || isLikelyBot() || typeof window.gtag !== "function") return;
    const event = { event_version: 1, page_type: pageType() };
    for (const field of analyticsEventFields[name]) if (analyticsValues[field].has(parameters[field])) event[field] = parameters[field];
    try { window.gtag("event", name, event); } catch {}
  }
  function trackOnce(element, key, name, parameters) {
    if (!element || element.dataset["analytics" + key]) return;
    element.dataset["analytics" + key] = "true";
    trackAnalyticsEvent(name, parameters);
  }
  function failureCategory(error) {
    if (error && typeof error === "object" && error.code === 1) return "denied";
    if (error && typeof error === "object" && error.code === 3) return "timeout";
    if (error && error.analyticsCategory) return error.analyticsCategory;
    return "unknown";
  }

  async function loadSearchIndex() {
    const response = await fetch("/assets/locations.json", { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error("Failed to load search index.");
    }
    return response.json();
  }

  function bindSearch(index) {
    document.querySelectorAll("[data-search-form]").forEach((form) => {
      const input = form.querySelector("[data-search-input]");
      const status = form.querySelector("[data-search-status]");
      if (!input) {
        return;
      }

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const query = input.value.trim().toLowerCase();
        if (!query) {
          if (status) status.textContent = "Enter a city, state, or country.";
          return;
        }

        if (input.dataset.placesSelected === "true") {
          if (status) status.textContent = "Showing selected location.";
          return;
        }

        const exact = index.find((item) => item.label.toLowerCase() === query);
        const partial = exact || index.find((item) => item.label.toLowerCase().includes(query));
        if (!partial) {
          trackOnce(form, "StaticSearchNoMatch", "location_search_no_match", { search_method: "static" });
          if (status) status.textContent = "No matching location found in the static directory.";
          return;
        }

        trackOnce(form, "StaticSearchSuccess", "location_search_success", { search_method: "static" });
        window.location.href = partial.url;
      });
    });
  }

  function weatherElements(widget) {
    return {
      location: widget.querySelector("[data-weather-location]"),
      coords: widget.querySelector("[data-weather-coordinates]"),
      status: widget.querySelector("[data-weather-status]"),
      grid: widget.querySelector("[data-weather-grid]"),
      wetBulb: widget.querySelector("[data-weather-wetbulb]"),
      temp: widget.querySelector("[data-weather-temp]"),
      humidity: widget.querySelector("[data-weather-humidity]"),
      updated: widget.querySelector("[data-weather-updated]"),
      error: widget.querySelector("[data-weather-error]")
    };
  }

  function setWeatherError(widget, message) {
    const el = weatherElements(widget);
    if (el.status) el.status.textContent = "Unavailable";
    if (el.grid) el.grid.hidden = true;
    el.error.hidden = false;
    el.error.textContent = message;
  }

  function formatCoordinates(lat, lon) {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return "";
    return Math.abs(latitude).toFixed(4) + "°" + (latitude < 0 ? "S" : "N") + ", " + Math.abs(longitude).toFixed(4) + "°" + (longitude < 0 ? "W" : "E");
  }

  function renderWeather(widget, payload, requestedName) {
    const el = weatherElements(widget);
    const wetBulb = typeof payload.weather.wetBulb === "number"
      ? payload.weather.wetBulb
      : calculateWetBulb(payload.weather.temperature, payload.weather.humidity);
    const locationName = requestedName || payload.location.name || "Selected Location";
    el.location.textContent = locationName;
    el.coords.textContent = formatCoordinates(payload.location.lat, payload.location.lng);
    if (el.status) el.status.textContent = "Live";
    if (el.grid) el.grid.hidden = false;
    el.wetBulb.textContent = wetBulb.toFixed(2) + "°C";
    el.temp.textContent = payload.weather.temperature.toFixed(2) + "°C";
    el.humidity.textContent = payload.weather.humidity.toFixed(2) + "%";
    el.updated.textContent = new Date(payload.weather.timestamp).toLocaleString();
    el.error.hidden = true;
    el.error.textContent = "";
  }

  let turnstileScriptPromise = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (turnstileScriptPromise) return turnstileScriptPromise;
    turnstileScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Weather verification is unavailable."));
      script.onerror = () => reject(new Error("Weather verification is unavailable."));
      document.head.appendChild(script);
    }).catch((error) => { turnstileScriptPromise = null; throw error; });
    return turnstileScriptPromise;
  }
  async function weatherVerification(widget, sitekey, forecast = false) {
    const el = forecast ? { status: widget.querySelector("[data-forecast-status]"), updated: widget.querySelector("[data-forecast-updated]") } : weatherElements(widget);
    if (el.status) el.status.textContent = "Verifying";
    if (el.updated) el.updated.textContent = forecast ? "Verifying browser before loading forecast..." : "Verifying browser before loading current weather...";
    const attribute = forecast ? "data-forecast-turnstile" : "data-weather-turnstile";
    const container = widget.querySelector("[" + attribute + "]") || document.createElement("div");
    if (!container.parentElement) {
      container.className = "flex justify-center";
      container.setAttribute(attribute, "");
      widget.appendChild(container);
    }
    const api = await loadTurnstile();
    let widgetId;
    try {
      return await new Promise((resolve, reject) => {
        widgetId = api.render(container, {
          sitekey: sitekey,
          action: "weather_refresh",
          execution: "execute",
          appearance: "interaction-only",
          callback: resolve,
          "error-callback": () => reject(new Error("Weather verification failed.")),
          "expired-callback": () => reject(new Error("Weather verification expired.")),
          "timeout-callback": () => reject(new Error("Weather verification timed out."))
        });
        api.execute(widgetId);
      });
    } finally {
      if (widgetId !== undefined) api.remove(widgetId);
      container.replaceChildren();
    }
  }
  async function fetchWeather(widget, lat, lon, requestedName, trigger = "page_init") {
    const el = weatherElements(widget);
    if (el.status) el.status.textContent = "Loading";
    el.updated.textContent = "Fetching latest weather...";
    el.error.hidden = true;
    el.error.textContent = "";
    if (isLikelyBot()) {
      if (el.status) el.status.textContent = "Skipped";
      el.updated.textContent = "Weather fetch skipped for automated client.";
      return;
    }
    const weatherUrl = "/api/weather?lat=" + encodeURIComponent(lat) + "&lon=" + encodeURIComponent(lon);
    let response;
    try {
      response = await fetch(weatherUrl, { method: "GET", headers: { Accept: "application/json" } });
    } catch (error) {
      trackOnce(widget, "WeatherFailure" + trigger, "weather_load_failure", { trigger, failure_category: "network" });
      throw Object.assign(new Error("Weather is temporarily unavailable."), { analyticsCategory: "network" });
    }
    if (response.status === 403) {
      let challenge = null;
      try { challenge = await response.json(); } catch {}
      if (challenge?.code === "verification_required" && typeof challenge.sitekey === "string" && challenge.sitekey) {
        let token;
        try { token = await weatherVerification(widget, challenge.sitekey); }
        catch {
          trackOnce(widget, "WeatherFailure" + trigger, "weather_load_failure", { trigger, failure_category: "http" });
          throw Object.assign(new Error("Weather verification is unavailable. Try again later."), { analyticsCategory: "http" });
        }
        try {
          response = await fetch(weatherUrl, { method: "GET", headers: { Accept: "application/json", "x-weather-turnstile": token } });
        } catch {
          trackOnce(widget, "WeatherFailure" + trigger, "weather_load_failure", { trigger, failure_category: "network" });
          throw Object.assign(new Error("Weather is temporarily unavailable."), { analyticsCategory: "network" });
        }
      }
    }
    if (response.status === 204) {
      if (el.status) el.status.textContent = "Skipped";
      el.updated.textContent = "Weather fetch skipped.";
      return;
    }
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      trackOnce(widget, "WeatherFailure" + trigger, "weather_load_failure", { trigger, failure_category: "http" });
      throw Object.assign(new Error("Failed to refresh weather data."), { analyticsCategory: "http" });
    }
    if (!payload || !payload.weather || !payload.location) {
      trackOnce(widget, "WeatherFailure" + trigger, "weather_load_failure", { trigger, failure_category: "invalid_payload" });
      throw Object.assign(new Error("Failed to refresh weather data."), { analyticsCategory: "invalid_payload" });
    }
    try { renderWeather(widget, payload, requestedName); }
    catch (error) {
      trackOnce(widget, "WeatherFailure" + trigger, "weather_load_failure", { trigger, failure_category: "invalid_payload" });
      throw error;
    }
    trackOnce(widget, "WeatherSuccess" + trigger, "weather_load_success", { trigger });
  }

  async function useCurrentLocation(widget) {
    if (!navigator.geolocation) {
      trackOnce(widget, "CurrentLocationFailure", "current_location_failure", { failure_category: "unsupported" });
      setWeatherError(widget, "Geolocation is not supported by your browser.");
      return;
    }

    const coords = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve(position.coords),
        (error) => reject(error),
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
      );
    });

    widget.dataset.lat = String(coords.latitude);
    widget.dataset.lon = String(coords.longitude);
    widget.dataset.location = "Current Location";
    await fetchWeather(widget, coords.latitude, coords.longitude, "Current Location", "current_location");
    trackOnce(widget, "CurrentLocationSuccess", "current_location_success");
  }

  function bindCurrentLocation(widget) {
    document.querySelectorAll("[data-current-location]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await useCurrentLocation(widget);
        } catch (error) {
          trackOnce(widget, "CurrentLocationFailure", "current_location_failure", { failure_category: failureCategory(error) });
          const message =
            error && typeof error === "object" && "code" in error && error.code === 1
              ? "Location access denied. Allow location access and try again."
              : error instanceof Error
                ? error.message
                : "Failed to get current location.";
          setWeatherError(widget, message);
        }
      });
    });
  }

  async function initWeather(widget) {
    bindCurrentLocation(widget);

    const lat = widget.dataset.lat;
    const lon = widget.dataset.lon;
    const location = widget.dataset.location || "";
    if (lat === "" || lon === "") {
      return;
    }

    try {
      await fetchWeather(widget, lat, lon, location);
    } catch (error) {
      setWeatherError(widget, error instanceof Error ? error.message : "Weather is temporarily unavailable.");
    }
  }

  function forecastDateLabel(date) {
    const parts = date.split("-").map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return date;
    return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12)));
  }

  function runLabel(run) {
    if (!run) return "IFS run";
    return run.id === "snapshot-pinned" ? "Top 50 snapshot's pinned IFS run"
      : run.id === "top50-pinned" ? "Top 50 hotspot run" : "Latest IFS run";
  }

  function runInitialization(run) {
    if (!run.initialization) return "initialization time not confirmed";
    return "initialized " + new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short"
    }).format(new Date(run.initialization));
  }

  function renderForecast(widget, payload) {
    const status = widget.querySelector("[data-forecast-status]");
    const days = widget.querySelector("[data-forecast-days]");
    const error = widget.querySelector("[data-forecast-error]");
    const updated = document.querySelector("[data-forecast-updated]");
    if (!days || !Array.isArray(payload.days) || payload.days.length !== 5) throw new Error("Forecast is temporarily unavailable.");
    const runs = Array.isArray(payload.runs) ? payload.runs : [];
    const today = Number.isSafeInteger(payload.utcOffsetSeconds)
      ? new Date(Date.now() + payload.utcOffsetSeconds * 1000).toISOString().slice(0, 10) : "";
    days.replaceChildren();
    payload.days.forEach((day, index) => {
      const noRemainingPeak = index === 0 && day?.date === today && day.maximumWetBulbC === null && day.peakLocalTime === null;
      if (!day || typeof day.date !== "string" || (!noRemainingPeak && (typeof day.maximumWetBulbC !== "number" || typeof day.peakLocalTime !== "string"))) {
        throw new Error("Forecast is temporarily unavailable.");
      }
      const card = document.createElement("div");
      card.className = "rounded-lg bg-blue-50 p-3 text-center";
      const date = document.createElement("h3");
      date.className = "font-semibold text-blue-900";
      date.textContent = day.date === today ? "Today (remaining hours) · " + forecastDateLabel(day.date) : forecastDateLabel(day.date);
      const value = document.createElement("p");
      value.className = "mt-2 text-2xl font-bold text-blue-700";
      value.textContent = noRemainingPeak ? "No upcoming hourly peak today" : day.maximumWetBulbC.toFixed(1) + "°C";
      const peak = document.createElement("p");
      peak.className = "mt-1 text-xs text-blue-900";
      peak.textContent = noRemainingPeak ? "" : "Peak near " + day.peakLocalTime.slice(11, 16) + " local";
      card.append(date, value, peak);
      if (runs.length > 1) {
        const run = document.createElement("p");
        run.className = "mt-1 text-xs text-gray-600";
        run.textContent = runLabel(runs.find((item) => item.id === day.runId));
        card.append(run);
      }
      days.append(card);
    });
    if (status) status.textContent = "Available";
    if (updated) {
      const retrieved = new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: payload.timezone,
        timeZoneName: "short"
      }).format(new Date(payload.retrievedAt));
      // Each named run is listed; days from different runs are never presented as one run.
      const runText = runs.map((run) => runLabel(run) + ": " + runInitialization(run)).join("; ");
      updated.textContent = "Updated " + retrieved + " (" + payload.timezone + ")." + (runText ? " " + runText + "." : "");
    }
    if (error) {
      error.hidden = true;
      error.textContent = "";
    }
  }

  async function initForecast(widget) {
    const status = widget.querySelector("[data-forecast-status]");
    const error = widget.querySelector("[data-forecast-error]");
    if (isLikelyBot()) {
      if (status) status.textContent = "Forecast fetch skipped for automated client.";
      return;
    }
    const path = widget.dataset.forecastPath;
    if (!path) return;
    try {
      const forecastUrl = "/api/forecast?path=" + encodeURIComponent(path);
      let response;
      try { response = await fetch(forecastUrl, {
        method: "GET",
        headers: { Accept: "application/json" }
      }); } catch { throw Object.assign(new Error("Forecast is temporarily unavailable."), { analyticsCategory: "network" }); }
      if (response.status === 403) {
        let challenge = null;
        try { challenge = await response.json(); } catch {}
        if (challenge?.code === "verification_required" && typeof challenge.sitekey === "string" && challenge.sitekey) {
          let token;
          try { token = await weatherVerification(widget, challenge.sitekey, true); }
          catch { throw Object.assign(new Error("Forecast verification is unavailable. Try again later."), { analyticsCategory: "http" }); }
          try {
            response = await fetch(forecastUrl, { method: "GET", headers: { Accept: "application/json", "x-weather-turnstile": token } });
          } catch { throw Object.assign(new Error("Forecast is temporarily unavailable."), { analyticsCategory: "network" }); }
        }
      }
      if (response.status === 204) {
        if (status) status.textContent = "Forecast fetch skipped.";
        return;
      }
      let payload = null;
      try { payload = await response.json(); } catch {}
      if (!response.ok) throw Object.assign(new Error("Forecast is temporarily unavailable."), { analyticsCategory: "http" });
      if (!payload) throw Object.assign(new Error("Forecast is temporarily unavailable."), { analyticsCategory: "invalid_payload" });
      try { renderForecast(widget, payload); }
      catch { throw Object.assign(new Error("Forecast is temporarily unavailable."), { analyticsCategory: "invalid_payload" }); }
      trackOnce(widget, "ForecastView", "forecast_view");
    } catch (caught) {
      trackOnce(widget, "ForecastFailure", "forecast_load_failure", { failure_category: failureCategory(caught) });
      if (status) status.textContent = "Unavailable";
      if (error) {
        error.hidden = false;
        error.textContent = caught instanceof Error ? caught.message : "Forecast is temporarily unavailable.";
      }
    }
  }

  function bindMapAnalytics() {
    const map = document.querySelector("[data-map]");
    if (!map) return;
    if (typeof IntersectionObserver === "function") {
      const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) { trackOnce(map, "MapView", "map_view"); observer.disconnect(); }
      }), { threshold: [0.5] });
      observer.observe(map);
    }
    map.addEventListener("pointerdown", () => trackOnce(map, "MapInteraction", "map_interaction", { interaction_type: "pointer" }), { once: true });
    map.addEventListener("wheel", () => trackOnce(map, "MapInteraction", "map_interaction", { interaction_type: "zoom" }), { once: true });
    map.addEventListener("keydown", () => trackOnce(map, "MapInteraction", "map_interaction", { interaction_type: "keyboard" }), { once: true });
  }
  function bindHotspotAnalytics() {
    document.querySelectorAll("[data-hotspot-city-link][data-rank-bucket]").forEach((link) => link.addEventListener("click", () => {
      const rank = String(link.dataset.rankBucket || "");
      const rank_bucket = /^(top[_-]?10|1?0)$/.test(rank) ? "top_10" : /^(top[_-]?25|2?5)$/.test(rank) ? "top_25" : /^(top[_-]?50|5?0)$/.test(rank) ? "top_50" : "other";
      trackOnce(link, "HotspotClick", "hotspot_city_click", { rank_bucket });
    }, { once: true }));
  }

  function bindLocalClocks() {
    const clocks = Array.from(document.querySelectorAll("[data-local-clock]"));
    if (!clocks.length) return;
    const formatters = new Map();
    function refresh() {
      const now = new Date();
      for (const clock of clocks) {
        const zone = clock.getAttribute("data-local-clock");
        try {
          let formatter = formatters.get(zone);
          if (!formatter) {
            formatter = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone, timeZoneName: "short" });
            formatters.set(zone, formatter);
          }
          clock.textContent = formatter.format(now);
          clock.dateTime = now.toISOString();
        } catch { clock.textContent = "Local time unavailable"; }
      }
    }
    refresh();
    setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
    window.addEventListener("pageshow", refresh);
  }

  Promise.allSettled([
    Promise.resolve().then(bindPlacesSearch),
    loadSearchIndex().then(bindSearch),
    Promise.resolve().then(bindMapAnalytics),
    Promise.resolve().then(bindHotspotAnalytics),
    Promise.resolve().then(bindLocalClocks),
    ...Array.from(document.querySelectorAll("[data-weather-widget]")).map((widget) => initWeather(widget)),
    ...Array.from(document.querySelectorAll("[data-forecast-widget]")).map((widget) => initForecast(widget))
  ]).catch(() => {});
})();`;
}
