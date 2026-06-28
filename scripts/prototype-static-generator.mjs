import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import slugify from "slugify";

const DEFAULT_SITE_URL = "https://www.wetbulb35.com";
const DEFAULT_OUT_DIR = "/private/tmp/wetbulb-static-prototype";
const DEFAULT_SOURCE_FILE = "scripts/resolved_cities.json";
const PUBLIC_DIR = path.resolve("public");
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
  bodyClass = "",
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
<body class="${bodyClass}">
  ${mainContent}
  <script src="/assets/app.js" defer></script>
</body>
</html>
`;
}

function renderHeader() {
  return `<header class="site-header">
    <a href="/" class="brand">
      <span class="brand-mark">35</span>
      <span>
        <strong>Wet Bulb Temperature</strong>
        <small>Live weather and heat-risk lookup</small>
      </span>
    </a>
    <nav class="header-nav">
      <a href="/">Home</a>
      <a href="/wetbulb-temperature/">Browse</a>
    </nav>
  </header>`;
}

function renderFooter() {
  const year = new Date().getFullYear();
  return `<footer class="site-footer">
    <div>
      <p>© ${year} Wet Bulb Temperature Monitor</p>
      <p>Contact: <a href="mailto:info@wetbulb35.com">info@wetbulb35.com</a></p>
    </div>
    <p class="footer-note">Wet-bulb values are estimated with the Stull formula.</p>
  </footer>`;
}

function renderDisclaimer() {
  return `<section class="disclaimer">
    <p>
      Disclaimer: Wet-bulb temperatures shown here are estimates using the Stull formula.
      For a reference explanation, visit
      <a href="https://www.omnicalculator.com/physics/wet-bulb" target="_blank" rel="noopener noreferrer">Omni Calculator&apos;s Wet-Bulb Temperature Calculator</a>.
    </p>
  </section>`;
}

function renderSearchPanel({ title = "Search for a location", showCurrentLocation = true }) {
  return `<section class="utility-panel">
    <div class="utility-copy">
      <p class="eyebrow">Current wet bulb temperature</p>
      <h2>${escapeHtml(title)}</h2>
      <p>Search by city, then jump straight to a static location page and refresh live conditions only when needed.</p>
    </div>
    <form class="search-form" data-search-form>
      <label class="search-label" for="location-search">Location search</label>
      <div class="search-row">
        <input id="location-search" name="query" type="search" placeholder="Search for a city, state, or country" autocomplete="off" list="location-options" data-search-input>
        <button type="submit">View location</button>
      </div>
      <datalist id="location-options"></datalist>
      <p class="search-help" data-search-status>Popular example: Denver, North Carolina, United States.</p>
    </form>
    ${
      showCurrentLocation
        ? `<button class="secondary-button" type="button" data-current-location>Use Current Location</button>`
        : ""
    }
  </section>`;
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

  return `<section class="weather-card" ${attrs}>
    <div class="weather-card__head">
      <div>
        <p class="eyebrow">Live conditions</p>
        <h2 data-weather-location>${escapeHtml(locationName || "Choose a location")}</h2>
        <p class="weather-coordinates" data-weather-coordinates>${
          lat && lon ? `${Number(lat).toFixed(4)}°, ${Number(lon).toFixed(4)}°` : "Search or use your current location to load weather."
        }</p>
      </div>
      <span class="status-pill" data-weather-status>Idle</span>
    </div>
    <div class="weather-grid">
      <article><h3>Wet Bulb</h3><p data-weather-wetbulb>--</p></article>
      <article><h3>Air Temp</h3><p data-weather-temp>--</p></article>
      <article><h3>Humidity</h3><p data-weather-humidity>--</p></article>
      <article><h3>Last Updated</h3><p data-weather-updated>Waiting for weather</p></article>
    </div>
    <p class="weather-error" data-weather-error hidden></p>
  </section>`;
}

function renderHero() {
  return `<section class="hero">
    <div>
      <p class="eyebrow">Heat-risk lookup</p>
      <h1>Current Wet Bulb Temperature</h1>
      <p class="hero-copy">Track live wet-bulb temperature for any location and browse our static city directory by country and state.</p>
    </div>
    <div class="hero-actions">
      <a class="primary-link" href="/wetbulb-temperature/">Browse all countries</a>
      <span class="hero-note">Fast static pages, live weather only on demand.</span>
    </div>
  </section>`;
}

function renderListSection({ title, kicker, items, emptyMessage }) {
  return `<section class="list-section">
    <div class="section-heading">
      <p class="eyebrow">${escapeHtml(kicker)}</p>
      <h1>${escapeHtml(title)}</h1>
    </div>
    ${
      items.length
        ? `<div class="list-grid">${items.join("")}</div>`
        : `<div class="empty-state"><p>${escapeHtml(emptyMessage)}</p></div>`
    }
  </section>`;
}

function renderAppFrame(content) {
  return `<div class="page-shell">
    ${renderHeader()}
    <main class="page-main">${content}</main>
    ${renderFooter()}
  </div>`;
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
    ${renderSearchPanel({ title: `Search locations from ${countryName} or anywhere else` })}
    ${renderWeatherWidget({
      locationName: fullName,
      lat: Number(city.latitude),
      lon: Number(city.longitude),
      mode: "city",
    })}
    <nav class="breadcrumbs">
      <a href="/wetbulb-temperature/">Countries</a>
      <a href="/wetbulb-temperature/${countrySlug}/">${escapeHtml(countryName)}</a>
      <a href="/wetbulb-temperature/${countrySlug}/${stateSlug}/">${escapeHtml(stateName)}</a>
      <span>${escapeHtml(cityName)}</span>
    </nav>
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

  const highlightedCountries = siteData.countries.slice(0, 12).map(
    (country) => `<a class="list-card" href="/wetbulb-temperature/${country.slug}/">
      <strong>${escapeHtml(country.name)}</strong>
      <span>${country.count} locations</span>
    </a>`,
  );

  const content = `
    ${renderHero()}
    ${renderSearchPanel({ title: "Search any city or use your current location" })}
    ${renderWeatherWidget({ mode: "home" })}
    ${renderListSection({
      title: "Browse by Country",
      kicker: "Static directory",
      items: highlightedCountries,
      emptyMessage: "No countries available.",
    })}
    ${renderDisclaimer()}
  `;

  return pageShell({
    siteUrl,
    routePath,
    title,
    description,
    breadcrumbData,
    bodyClass: "home-page",
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
    (country) => `<a class="list-card" href="/wetbulb-temperature/${country.slug}/">
      <strong>${escapeHtml(country.name)}</strong>
      <span>${country.count} locations</span>
    </a>`,
  );

  const content = `
    ${renderSearchPanel({ title: "Jump directly to a city page" })}
    ${renderListSection({
      title: "Browse Wet Bulb Temperature by Country",
      kicker: "All countries",
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
    (state) => `<a class="list-card" href="/wetbulb-temperature/${country.slug}/${state.slug}/">
      <strong>${escapeHtml(state.name)}</strong>
      <span>${state.count} locations</span>
    </a>`,
  );

  const content = `
    ${renderSearchPanel({ title: `Search within ${country.name} or anywhere` })}
    <nav class="breadcrumbs">
      <a href="/wetbulb-temperature/">Countries</a>
      <span>${escapeHtml(country.name)}</span>
    </nav>
    ${renderListSection({
      title: `Browse ${country.name} by State/Province`,
      kicker: "Country directory",
      items: stateCards,
      emptyMessage: "No states or provinces found for this country.",
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
    return `<a class="list-card" href="${href}">
      <strong>${escapeHtml(city.name)}</strong>
      <span>${Number(city.latitude).toFixed(2)}°, ${Number(city.longitude).toFixed(2)}°</span>
    </a>`;
  });

  const content = `
    ${renderSearchPanel({ title: `Search cities in ${state.stateName}` })}
    <nav class="breadcrumbs">
      <a href="/wetbulb-temperature/">Countries</a>
      <a href="/wetbulb-temperature/${state.countrySlug}/">${escapeHtml(state.countryName)}</a>
      <span>${escapeHtml(state.stateName)}</span>
    </nav>
    ${renderListSection({
      title: `Cities in ${state.stateName}, ${state.countryName}`,
      kicker: "State directory",
      items: cityCards,
      emptyMessage: "No cities found for this state or province.",
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

function clientRuntimeSource() {
  return String.raw`(() => {
  const botPattern = /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|applebot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|bytespider|crawler|spider|bot)/i;

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
    const options = document.getElementById("location-options");
    if (options) {
      options.innerHTML = index.slice(0, 2500).map((item) => '<option value="' + item.label.replaceAll('"', "&quot;") + '"></option>').join("");
    }

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
      wetBulb: widget.querySelector("[data-weather-wetbulb]"),
      temp: widget.querySelector("[data-weather-temp]"),
      humidity: widget.querySelector("[data-weather-humidity]"),
      updated: widget.querySelector("[data-weather-updated]"),
      error: widget.querySelector("[data-weather-error]")
    };
  }

  function setWeatherError(widget, message) {
    const el = weatherElements(widget);
    el.status.textContent = "Unavailable";
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
    el.coords.textContent = payload.location.lat.toFixed(4) + "°, " + payload.location.lng.toFixed(4) + "°";
    el.status.textContent = "Live";
    el.wetBulb.textContent = wetBulb.toFixed(2) + "°C";
    el.temp.textContent = payload.weather.temperature.toFixed(2) + "°C";
    el.humidity.textContent = payload.weather.humidity.toFixed(2) + "%";
    el.updated.textContent = new Date(payload.weather.timestamp).toLocaleString();
    el.error.hidden = true;
    el.error.textContent = "";
  }

  async function fetchWeather(widget, lat, lon, requestedName) {
    const el = weatherElements(widget);
    el.status.textContent = "Loading";
    el.updated.textContent = "Fetching latest weather...";
    el.error.hidden = true;
    el.error.textContent = "";

    if (isLikelyBot()) {
      el.status.textContent = "Skipped";
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
      el.status.textContent = "Skipped";
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
    loadSearchIndex().then(bindSearch),
    ...Array.from(document.querySelectorAll("[data-weather-widget]")).map((widget) => initWeather(widget))
  ]).catch(() => {});
})();`;
}

function stylesheetSource() {
  return `:root{
  --bg:#f4f7fb;
  --surface:#ffffff;
  --surface-strong:#0f172a;
  --border:#d9e2ec;
  --text:#0f172a;
  --muted:#526277;
  --accent:#0f766e;
  --accent-2:#f59e0b;
  --shadow:0 22px 40px rgba(15,23,42,.08);
  --radius:24px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:radial-gradient(circle at top,#fff 0,#eef5ff 38%,#f4f7fb 100%);color:var(--text);font:16px/1.5 Arial,Helvetica,sans-serif}
a{color:inherit}
.page-shell{max-width:1120px;margin:0 auto;padding:24px 18px 48px}
.site-header,.utility-panel,.hero,.weather-card,.list-section,.disclaimer,.site-footer{background:rgba(255,255,255,.94);border:1px solid var(--border);box-shadow:var(--shadow);border-radius:var(--radius)}
.site-header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:18px 22px;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:14px;text-decoration:none}
.brand-mark{display:grid;place-items:center;width:52px;height:52px;border-radius:16px;background:linear-gradient(135deg,var(--accent),#38bdf8);color:#fff;font-weight:800;font-size:20px}
.brand strong,.hero h1,.section-heading h1,.utility-copy h2,.weather-card__head h2{display:block}
.brand small,.hero-note,.search-help,.weather-coordinates,.footer-note{color:var(--muted)}
.header-nav{display:flex;gap:14px;flex-wrap:wrap}
.header-nav a,.breadcrumbs a{color:var(--accent);text-decoration:none}
.page-main{display:grid;gap:18px}
.hero{display:grid;grid-template-columns:1.4fr .9fr;gap:24px;padding:30px}
.hero h1{font-size:clamp(2.2rem,4vw,3.7rem);line-height:1.02;margin:.2rem 0 .75rem}
.hero-copy{max-width:50ch;color:var(--muted);font-size:1.05rem}
.hero-actions{display:flex;flex-direction:column;justify-content:flex-end;gap:14px}
.primary-link,.search-row button,.secondary-button{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:999px;padding:13px 18px;font-weight:700;text-decoration:none;cursor:pointer}
.primary-link,.search-row button{background:var(--surface-strong);color:#fff}
.secondary-button{background:#ecfeff;color:var(--accent);border:1px solid #a5f3fc}
.utility-panel{display:grid;grid-template-columns:1.1fr 1fr auto;gap:18px;padding:24px}
.utility-copy p,.section-heading p,.weather-card__head p{margin:0}
.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:.74rem;font-weight:700;color:var(--accent)}
.utility-copy h2,.section-heading h1,.weather-card__head h2{margin:.35rem 0 .45rem}
.search-form{display:grid;gap:10px}
.search-label{font-weight:700}
.search-row{display:flex;gap:10px}
.search-row input{flex:1;min-width:0;padding:14px 16px;border-radius:16px;border:1px solid var(--border);font:inherit}
.weather-card{padding:26px}
.weather-card__head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:18px}
.status-pill{padding:8px 12px;border-radius:999px;background:#ecfeff;color:var(--accent);font-weight:700}
.weather-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.weather-grid article{padding:18px;border-radius:20px;background:#f8fbff;border:1px solid #dbeafe}
.weather-grid h3{margin:0 0 8px;font-size:.95rem;color:var(--muted)}
.weather-grid p{margin:0;font-size:1.35rem;font-weight:800}
.weather-error{margin:16px 0 0;padding:14px 16px;border-radius:16px;background:#fff1f2;border:1px solid #fecdd3;color:#be123c}
.breadcrumbs{display:flex;gap:10px;flex-wrap:wrap;font-size:.95rem;color:var(--muted)}
.breadcrumbs span::before,.breadcrumbs a+a::before{content:"/";margin-right:10px;color:#94a3b8}
.breadcrumbs a:first-child::before{content:""}
.list-section{padding:24px}
.list-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:18px}
.list-card{display:grid;gap:4px;padding:18px;border-radius:20px;text-decoration:none;background:linear-gradient(180deg,#fff,#f8fbff);border:1px solid var(--border);transition:transform .12s ease,border-color .12s ease}
.list-card:hover{transform:translateY(-2px);border-color:#7dd3fc}
.list-card span{color:var(--muted)}
.empty-state{padding:18px;border-radius:18px;background:#f8fafc;color:var(--muted);margin-top:16px}
.disclaimer,.site-footer{padding:20px 22px}
.disclaimer p,.site-footer p{margin:0}
.site-footer{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
@media (max-width:960px){
  .hero,.utility-panel{grid-template-columns:1fr}
  .weather-grid,.list-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (max-width:640px){
  .page-shell{padding:14px 12px 40px}
  .site-header{padding:16px;align-items:flex-start;flex-direction:column}
  .search-row,.weather-card__head{flex-direction:column}
  .search-row button,.secondary-button,.primary-link{width:100%}
  .weather-grid,.list-grid{grid-template-columns:1fr}
}`;
}

export function ensureAssets(outDir, siteData) {
  const assetDir = path.join(outDir, "assets");
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(path.join(assetDir, "app.css"), stylesheetSource());
  fs.writeFileSync(path.join(assetDir, "app.js"), clientRuntimeSource());
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

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const sourceCities = JSON.parse(fs.readFileSync(sourceFile, "utf8")).slice(0, limit);
  const siteData = createSiteData(sourceCities);

  copyPublicAssets(outDir);
  ensureAssets(outDir, siteData);

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
