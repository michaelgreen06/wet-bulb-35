import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import slugify from "slugify";

const DEFAULT_SITE_URL = "https://www.wetbulb35.com";
const DEFAULT_OUT_DIR = "/private/tmp/wetbulb-static-prototype";
const DEFAULT_SOURCE_FILE = "scripts/resolved_cities.json";
const PUBLIC_DIR = path.resolve("public");
const STATIC_TAILWIND_INPUT = path.resolve("scripts/static-tailwind.css");
const BOT_PATTERN =
  /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|applebot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|bytespider|crawler|spider|bot)/i;

export function parseArgs(argv = process.argv.slice(2)) {
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

export function createSiteData(sourceCities) {
  const { cities, collisionGroups, collisionRows } = prepareCities(sourceCities);
  const countriesMap = new Map();
  const statesMap = new Map();

  for (const city of cities) {
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
      cities: [...state.cities].sort((a, b) => {
        const nameCompare = a.name.localeCompare(b.name);
        if (nameCompare !== 0) {
          return nameCompare;
        }

        return routePathForCity(a).localeCompare(routePathForCity(b));
      }),
    }))
    .sort((a, b) =>
      `${a.countryName}/${a.stateName}`.localeCompare(`${b.countryName}/${b.stateName}`),
    );

  const cityRoutes = new Set(cities.map(routePathForCity));
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

  const searchIndex = cities.map((city) => ({
    label: `${city.name}, ${city.resolvedAdmin1Code}, ${city.resolvedCountryName}`,
    url: routePathForCity(city),
    lat: Number(city.latitude),
    lon: Number(city.longitude),
  }));

  return {
    cities,
    countries,
    states,
    pageRoutes,
    cityRoutes,
    collisionGroups,
    collisionRows,
    searchIndex,
  };
}

function pageShell({
  siteUrl,
  routePath,
  title,
  description,
  breadcrumbData,
  mainContent,
}) {
  const canonical = canonicalUrl(siteUrl, routePath);
  const imageUrl = `${siteUrl}/images/wetbulb-default.jpg`;
  const jsonLd = safeJson(breadcrumbData);

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
  <script type="application/ld+json">${jsonLd}</script>
</head>
<body>
  ${mainContent}
  <script src="/assets/app.js" defer></script>
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
      Disclaimer: The wet-bulb temperatures shown are estimates calculated using the Stull formula.
      For more information about wet-bulb temperature calculations, visit
      <a href="https://www.omnicalculator.com/physics/wet-bulb" target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:text-blue-600 underline">Omni Calculator&apos;s Wet-Bulb Temperature Calculator</a>.
    </p>
  </div>`;
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
        class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
        lat && lon ? `${Number(lat).toFixed(4)}°N, ${Number(lon).toFixed(4)}°E` : "Search or use your current location to load weather."
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
        <p class="text-lg text-gray-600" data-weather-updated>${lat && lon ? "Fetching latest weather..." : "Waiting for weather"}</p>
      </div>
    </div>
    <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" data-weather-error hidden></div>
  </div>`;
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

function renderAppFrame(content) {
  return `<main class="min-h-screen bg-gray-50 py-8 px-4">
    <div class="max-w-4xl mx-auto space-y-8">
      ${renderHeader()}
      <div class="space-y-6">${content}</div>
    </div>
    ${renderFooter()}
  </main>`;
}

export function pageHtml(city, options = {}) {
  const siteUrl = options.siteUrl ?? DEFAULT_SITE_URL;
  const cityName = city.name;
  const stateName = city.resolvedAdmin1Code;
  const countryName = city.resolvedCountryName;
  const { countrySlug, stateSlug, citySlug } = getRouteParts(city);
  const routePath = `/wetbulb-temperature/${countrySlug}/${stateSlug}/${citySlug}/`;
  const fullName = `${cityName}, ${stateName}, ${countryName}`;
  const title = `Wet Bulb Temperature in ${fullName}`;
  const description = `Live wet bulb temperature and weather conditions for ${fullName}.`;
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

  const cityContent = `
    ${renderSearchBox()}
    ${renderCurrentLocationButton({ wrapperClass: "mt-8" })}
    ${renderWeatherWidget({
      locationName: fullName,
      lat: Number(city.latitude),
      lon: Number(city.longitude),
      mode: "city",
    })}
    ${renderDisclaimer()}
  `;

  return pageShell({
    siteUrl,
    routePath,
    title,
    description,
    breadcrumbData,
    mainContent: renderAppFrame(cityContent),
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
    ${renderWeatherWidget({ mode: "home" })}
    ${renderDisclaimer()}
  `;

  return pageShell({
    siteUrl,
    routePath,
    title,
    description,
    breadcrumbData,
    mainContent: renderAppFrame(content),
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

  const content = `
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
    mainContent: renderAppFrame(content),
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

  const stateCards = country.states.map(
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
    mainContent: renderAppFrame(content),
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
    mainContent: renderAppFrame(content),
  });
}

export function clientRuntimeSource({ placesApiKey = process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY ?? "" } = {}) {
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

              try {
                await fetchWeather(widget, lat, lng, label);
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
          if (status) status.textContent = "No matching location found in the static directory.";
          return;
        }

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

  function renderWeather(widget, payload, requestedName) {
    const el = weatherElements(widget);
    const wetBulb = typeof payload.weather.wetBulb === "number"
      ? payload.weather.wetBulb
      : calculateWetBulb(payload.weather.temperature, payload.weather.humidity);
    const locationName = requestedName || payload.location.name || "Selected Location";
    el.location.textContent = locationName;
    el.coords.textContent = payload.location.lat.toFixed(4) + "°N, " + payload.location.lng.toFixed(4) + "°E";
    if (el.status) el.status.textContent = "Live";
    if (el.grid) el.grid.hidden = false;
    el.wetBulb.textContent = wetBulb.toFixed(2) + "°C";
    el.temp.textContent = payload.weather.temperature.toFixed(2) + "°C";
    el.humidity.textContent = payload.weather.humidity.toFixed(2) + "%";
    el.updated.textContent = new Date(payload.weather.timestamp).toLocaleString();
    el.error.hidden = true;
    el.error.textContent = "";
  }

  async function fetchWeather(widget, lat, lon, requestedName) {
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

    const response = await fetch("/api/weather?lat=" + encodeURIComponent(lat) + "&lon=" + encodeURIComponent(lon), {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });

    if (response.status === 204) {
      if (el.status) el.status.textContent = "Skipped";
      el.updated.textContent = "Weather fetch skipped.";
      return;
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }

    if (!response.ok || !payload) {
      throw new Error(payload && payload.error ? payload.error : "Failed to refresh weather data.");
    }

    renderWeather(widget, payload, requestedName);
  }

  async function useCurrentLocation(widget) {
    if (!navigator.geolocation) {
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
    await fetchWeather(widget, coords.latitude, coords.longitude, "Current Location");
  }

  function bindCurrentLocation(widget) {
    document.querySelectorAll("[data-current-location]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await useCurrentLocation(widget);
        } catch (error) {
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
    if (!lat || !lon) {
      return;
    }

    try {
      await fetchWeather(widget, lat, lon, location);
    } catch (error) {
      setWeatherError(widget, error instanceof Error ? error.message : "Weather is temporarily unavailable.");
    }
  }

  Promise.allSettled([
    Promise.resolve().then(bindPlacesSearch),
    loadSearchIndex().then(bindSearch),
    ...Array.from(document.querySelectorAll("[data-weather-widget]")).map((widget) => initWeather(widget))
  ]).catch(() => {});
})();`;
}

export function buildStaticCss(outDir) {
  const assetDir = path.join(outDir, "assets");
  fs.mkdirSync(assetDir, { recursive: true });
  const tailwindBin = path.resolve("node_modules/.bin/tailwindcss");
  execFileSync(
    tailwindBin,
    ["-i", STATIC_TAILWIND_INPUT, "-o", path.join(assetDir, "app.css"), "--minify"],
    { stdio: "pipe" },
  );
}

export function ensureAssets(outDir, siteData, options = {}) {
  const assetDir = path.join(outDir, "assets");
  fs.mkdirSync(assetDir, { recursive: true });
  buildStaticCss(outDir);
  fs.writeFileSync(path.join(assetDir, "app.js"), clientRuntimeSource({
    placesApiKey: options.placesApiKey,
  }));
  fs.writeFileSync(
    path.join(assetDir, "locations.json"),
    JSON.stringify(siteData.searchIndex),
  );
}

function copyPublicAssets(outDir) {
  if (!fs.existsSync(PUBLIC_DIR)) {
    return;
  }

  fs.cpSync(PUBLIC_DIR, outDir, { recursive: true });
}

function writeHtmlPage(outDir, routePath, html) {
  const targetDir =
    routePath === "/"
      ? outDir
      : path.join(outDir, routePath.replace(/^\/|\/$/g, ""));
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "index.html"), html);
}

export function generateStaticSite(options = {}) {
  const started = performance.now();
  const limit = Number(options.limit ?? 10000);
  const outDir = path.resolve(String(options.outDir ?? DEFAULT_OUT_DIR));
  const siteUrl = options.siteUrl ?? DEFAULT_SITE_URL;
  const sourceFile = path.resolve(String(options.sourceFile ?? DEFAULT_SOURCE_FILE));
  const placesApiKey = options.placesApiKey ?? process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY ?? "";

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const sourceCities = JSON.parse(fs.readFileSync(sourceFile, "utf8")).slice(0, limit);
  const siteData = createSiteData(sourceCities);

  copyPublicAssets(outDir);
  ensureAssets(outDir, siteData, { placesApiKey });

  writeHtmlPage(outDir, "/", renderHomePage(siteData, { siteUrl }));
  writeHtmlPage(outDir, "/wetbulb-temperature/", renderBrowsePage(siteData, { siteUrl }));

  for (const country of siteData.countries) {
    writeHtmlPage(
      outDir,
      `/wetbulb-temperature/${country.slug}/`,
      renderCountryPage(country, { siteUrl }),
    );
  }

  for (const state of siteData.states) {
    writeHtmlPage(
      outDir,
      `/wetbulb-temperature/${state.countrySlug}/${state.stateSlug}/`,
      renderStatePage(state, { siteUrl }),
    );
  }

  for (const city of siteData.cities) {
    writeHtmlPage(outDir, routePathForCity(city), pageHtml(city, { siteUrl }));
  }

  const written = siteData.pageRoutes.size;
  const elapsedSeconds = (performance.now() - started) / 1000;
  return {
    outDir,
    requested: limit,
    written,
    collisionGroups: siteData.collisionGroups,
    collisionRows: siteData.collisionRows,
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    pagesPerSecond: Number((written / elapsedSeconds).toFixed(1)),
  };
}

function main() {
  const args = parseArgs();
  const result = generateStaticSite({
    limit: args.get("limit") ?? 10000,
    outDir: args.get("out") ?? DEFAULT_OUT_DIR,
    siteUrl: args.get("site") ?? DEFAULT_SITE_URL,
  });

  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export const STATIC_BOT_PATTERN = BOT_PATTERN;
