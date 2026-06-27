import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import slugify from "slugify";

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

export function pageHtml(city, options = {}) {
  const siteUrl = options.siteUrl ?? "https://www.wetbulb35.com";
  const cityName = city.name;
  const stateName = city.resolvedAdmin1Code;
  const countryName = city.resolvedCountryName;
  const { countrySlug, stateSlug, citySlug } = getRouteParts(city);
  const urlPath = `/wetbulb-temperature/${countrySlug}/${stateSlug}/${citySlug}/`;
  const canonicalUrl = `${siteUrl}${urlPath}`;
  const fullName = `${cityName}, ${stateName}, ${countryName}`;
  const title = `Wet Bulb Temperature in ${fullName}`;
  const description = `Live wet bulb temperature and weather conditions for ${fullName}.`;
  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Wet Bulb Temperature",
        item: `${siteUrl}/wetbulb-temperature/`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: countryName,
        item: `${siteUrl}/wetbulb-temperature/${countrySlug}/`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: stateName,
        item: `${siteUrl}/wetbulb-temperature/${countrySlug}/${stateSlug}/`,
      },
      {
        "@type": "ListItem",
        position: 4,
        name: cityName,
        item: canonicalUrl,
      },
    ],
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:site_name" content="Wet Bulb Temperature">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/app.css">
  <script type="application/ld+json">${JSON.stringify(breadcrumbData).replaceAll("<", "\\u003c")}</script>
</head>
<body>
  <main class="page">
    <header class="site-header">
      <a href="/" class="brand">Wet Bulb 35</a>
      <nav><a href="/wetbulb-temperature/">Browse</a></nav>
    </header>
    <section class="weather-panel">
      <p class="eyebrow">Current wet bulb temperature</p>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      <dl class="location-data">
        <div><dt>Latitude</dt><dd>${Number(city.latitude).toFixed(4)}</dd></div>
        <div><dt>Longitude</dt><dd>${Number(city.longitude).toFixed(4)}</dd></div>
      </dl>
      <div
        id="weather-widget"
        data-location="${escapeHtml(fullName)}"
        data-lat="${Number(city.latitude)}"
        data-lng="${Number(city.longitude)}"
      >
        <p>Fetching latest weather...</p>
      </div>
    </section>
  </main>
  <script src="/assets/app.js" defer></script>
</body>
</html>
`;
}

export function ensureAssets(outDir) {
  const assetDir = path.join(outDir, "assets");
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(
    path.join(assetDir, "app.css"),
    "body{margin:0;font-family:system-ui,sans-serif;background:#f8fafc;color:#111827}.page{max-width:960px;margin:0 auto;padding:32px 20px}.site-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:40px}.brand{font-weight:800;color:#111827;text-decoration:none}.weather-panel{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:28px;box-shadow:0 1px 2px rgba(0,0,0,.04)}.eyebrow{text-transform:uppercase;font-size:12px;letter-spacing:.08em;color:#0f766e;font-weight:700}h1{font-size:32px;line-height:1.15;margin:0 0 12px}.location-data{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:24px 0}.location-data div{background:#f3f4f6;border-radius:8px;padding:12px}dt{font-size:12px;color:#6b7280}dd{margin:4px 0 0;font-weight:700}@media(max-width:640px){h1{font-size:26px}.location-data{grid-template-columns:1fr}}",
  );
  fs.writeFileSync(
    path.join(assetDir, "app.js"),
    "(()=>{const el=document.getElementById('weather-widget');if(!el)return;const lat=el.dataset.lat,lng=el.dataset.lng;fetch(`/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`).then(r=>r.ok?r.json():Promise.reject()).then(d=>{el.innerHTML=`<p><strong>Temperature:</strong> ${d.weather.temperature.toFixed(2)} C</p><p><strong>Humidity:</strong> ${d.weather.humidity.toFixed(2)}%</p>`}).catch(()=>{el.innerHTML='<p>Weather is temporarily unavailable.</p>'})})();",
  );
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

export function generateStaticSite(options = {}) {
  const started = performance.now();
  const limit = Number(options.limit ?? 10000);
  const outDir = path.resolve(
    String(options.outDir ?? "/private/tmp/wetbulb-static-prototype"),
  );
  const siteUrl = options.siteUrl ?? "https://www.wetbulb35.com";
  const sourceFile = path.resolve(
    String(options.sourceFile ?? "scripts/resolved_cities.json"),
  );

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  ensureAssets(outDir);

  const sourceCities = JSON.parse(fs.readFileSync(sourceFile, "utf8")).slice(
    0,
    limit,
  );
  const { cities, collisionGroups, collisionRows } = prepareCities(sourceCities);
  let written = 0;

  for (const city of cities) {
    const { countrySlug, stateSlug, citySlug } = getRouteParts(city);

    if (!countrySlug || !stateSlug || !citySlug) {
      continue;
    }

    const pageDir = path.join(
      outDir,
      "wetbulb-temperature",
      countrySlug,
      stateSlug,
      citySlug,
    );
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(
      path.join(pageDir, "index.html"),
      pageHtml(city, { siteUrl }),
    );
    written += 1;
  }

  const elapsedSeconds = (performance.now() - started) / 1000;
  return {
    outDir,
    requested: limit,
    written,
    collisionGroups,
    collisionRows,
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    pagesPerSecond: Number((written / elapsedSeconds).toFixed(1)),
  };
}

function main() {
  const args = parseArgs();
  const result = generateStaticSite({
    limit: args.get("limit") ?? 10000,
    outDir: args.get("out") ?? "/private/tmp/wetbulb-static-prototype",
    siteUrl: args.get("site") ?? "https://www.wetbulb35.com",
  });

  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
