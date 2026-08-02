import fs from "node:fs";
import path from "node:path";
import { generateStaticSite } from "./prototype-static-generator.mjs";

const OUTPUT_DIR = path.resolve(".vercel/output");
const STATIC_DIR = path.join(OUTPUT_DIR, "static");
const WEATHER_FUNCTION_DIR = path.join(OUTPUT_DIR, "functions/api/weather.func");
const INHABITED_FUNCTION_DIR = path.join(OUTPUT_DIR, "functions/api/inhabited-hotspots.func");
const INHABITED_SNAPSHOT_PATH = path.resolve("public/data/hotspots/inhabited-latest.json");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function weatherFunctionSource() {
  return String.raw`const BOT_PATTERN =
  /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|applebot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|bytespider|crawler|spider|bot)/i;

function isBlockedBot(userAgent) {
  return Boolean(userAgent && BOT_PATTERN.test(userAgent));
}

function kelvinToCelsius(kelvin) {
  return kelvin - 273.15;
}

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

function setJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function fetchWeatherData(lat, lon) {
  const apiKey =
    process.env.OPENWEATHER_API_KEY || process.env.NEXT_PUBLIC_OPENWEATHER_API_KEY;
  if (!apiKey) {
    throw new Error("OpenWeather API key is not configured. Please check your environment variables.");
  }

  const url = "https://api.openweathermap.org/data/2.5/weather?lat=" +
    encodeURIComponent(lat) +
    "&lon=" +
    encodeURIComponent(lon) +
    "&appid=" +
    encodeURIComponent(apiKey);
  const response = await fetch(url);
  const statusText = response.statusText || "";

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Invalid API key. Please check your OpenWeather API key configuration.");
    }
    if (response.status === 404) {
      throw new Error("Weather data not found for this location. Please try a different location.");
    }
    if (response.status === 429) {
      throw new Error("Too many requests to weather service. Please try again later.");
    }
    throw new Error("Weather service error (" + response.status + (statusText ? ": " + statusText : "") + "). Please try again later.");
  }

  const data = await response.json();
  const temperature = kelvinToCelsius(Number(data?.main?.temp));
  const humidity = Number(data?.main?.humidity);
  const locationLat = Number(data?.coord?.lat);
  const locationLon = Number(data?.coord?.lon);

  if (!Number.isFinite(temperature) || !Number.isFinite(humidity) || !Number.isFinite(locationLat) || !Number.isFinite(locationLon)) {
    throw new Error("Weather service returned invalid data.");
  }

  return {
    location: {
      name: typeof data?.name === "string" ? data.name : "Selected Location",
      lat: locationLat,
      lng: locationLon,
    },
    weather: {
      temperature,
      humidity,
      wetBulb: calculateWetBulb(temperature, humidity),
      timestamp: Number(data?.dt) * 1000,
    },
  };
}

module.exports = async function weatherHandler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    setJson(res, 405, { error: "Method not allowed." });
    return;
  }

  if (isBlockedBot(req.headers?.["user-agent"])) {
    res.statusCode = 204;
    res.end();
    return;
  }

  const requestUrl = new URL(req.url || "http://localhost/api/weather", "http://localhost");
  const lat = Number(req.query?.lat ?? requestUrl.searchParams.get("lat"));
  const lon = Number(req.query?.lon ?? requestUrl.searchParams.get("lon"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    setJson(res, 400, { error: "Valid lat and lon are required." });
    return;
  }

  try {
    const weatherData = await fetchWeatherData(lat, lon);
    res.setHeader(
      "Cache-Control",
      "private, no-store, no-cache, max-age=0, must-revalidate",
    );
    setJson(res, 200, weatherData);
  } catch (error) {
    setJson(res, 500, {
      error: error instanceof Error ? error.message : "Failed to refresh weather data.",
    });
  }
};
`;
}

function inhabitedHotspotsFunctionSource() {
  return String.raw`const fs = require("node:fs");
const path = require("node:path");

const CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=3600";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isIsoDateString(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isValidHotspot(value) {
  if (!isObject(value)) return false;
  const city = value.city;
  return (
    isFiniteNumber(value.lat) &&
    isFiniteNumber(value.lon) &&
    isFiniteNumber(value.peakTempC) &&
    isIsoDateString(value.peakTempTime) &&
    isFiniteNumber(value.rhAtPeakTemp) &&
    isFiniteNumber(value.peakWetBulbC) &&
    isIsoDateString(value.peakWetBulbTime) &&
    Array.isArray(value.hotHours) &&
    isObject(city) &&
    typeof city.name === "string" &&
    isFiniteNumber(city.latitude) &&
    isFiniteNumber(city.longitude) &&
    isFiniteNumber(city.population)
  );
}

function validateSnapshot(value) {
  if (!isObject(value)) return false;
  const scan = value.scan;
  const thresholds = value.thresholds;
  const snapshot = value.snapshot;
  const hotspots = value.hotspots;

  if (
    value.schemaVersion !== 1 ||
    typeof value.label !== "string" ||
    !isObject(scan) ||
    scan.algorithm !== "grid-cell-v1" ||
    !isFiniteNumber(scan.forecastHours) ||
    !isFiniteNumber(scan.candidateCities) ||
    !isFiniteNumber(scan.citiesScanned) ||
    !isFiniteNumber(scan.batchCount) ||
    !isIsoDateString(scan.generatedAt) ||
    !isObject(thresholds) ||
    !isFiniteNumber(thresholds.tempC) ||
    !isFiniteNumber(thresholds.wetBulbC) ||
    !isFiniteNumber(value.minPopulation) ||
    !isFiniteNumber(value.limit) ||
    !Array.isArray(hotspots) ||
    !isObject(snapshot) ||
    !["cron", "manual"].includes(snapshot.generatedBy) ||
    snapshot.source !== "open-meteo" ||
    (snapshot.expiresAt !== undefined && !isIsoDateString(snapshot.expiresAt))
  ) {
    return false;
  }

  for (let index = 0; index < hotspots.length; index += 1) {
    if (!isValidHotspot(hotspots[index])) return false;
    if (
      index > 0 &&
      hotspots[index].peakWetBulbC > hotspots[index - 1].peakWetBulbC
    ) {
      return false;
    }
  }

  return true;
}

function setJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readBlobSnapshot() {
  const url = (process.env.INHABITED_HOTSPOT_DATA_URL || "").trim();
  if (!url) return null;

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) return null;

  const payload = await response.json();
  return validateSnapshot(payload) ? payload : null;
}

function readBundledSnapshot() {
  const filePath = path.join(__dirname, "inhabited-latest.json");
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!validateSnapshot(payload)) {
    throw new Error("Bundled inhabited hotspot snapshot is invalid.");
  }
  return payload;
}

module.exports = async function inhabitedHotspotsHandler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    setJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const blobSnapshot = await readBlobSnapshot().catch(() => null);
  const source = blobSnapshot ? "blob" : "bundled-fallback";
  const payload = blobSnapshot || readBundledSnapshot();

  res.setHeader("Cache-Control", CACHE_CONTROL);
  res.setHeader("X-Hotspot-Data-Source", source);
  setJson(res, 200, payload);
};
`;
}

function writeNodeFunction(functionDir, source, extraFiles = []) {
  fs.mkdirSync(functionDir, { recursive: true });
  fs.writeFileSync(path.join(functionDir, "index.js"), source);
  for (const extraFile of extraFiles) {
    fs.copyFileSync(extraFile.from, path.join(functionDir, extraFile.to));
  }
  writeJson(path.join(functionDir, "package.json"), {
    type: "commonjs",
  });
  writeJson(path.join(functionDir, ".vc-config.json"), {
    runtime: "nodejs22.x",
    handler: "index.js",
    launcherType: "Nodejs",
    shouldAddHelpers: true,
  });
}

export function buildVercelOutput() {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(STATIC_DIR, { recursive: true });

  const result = generateStaticSite({
    outDir: STATIC_DIR,
    limit: 130684,
  });

  writeNodeFunction(WEATHER_FUNCTION_DIR, weatherFunctionSource());
  writeNodeFunction(INHABITED_FUNCTION_DIR, inhabitedHotspotsFunctionSource(), [
    { from: INHABITED_SNAPSHOT_PATH, to: "inhabited-latest.json" },
  ]);
  writeJson(path.join(OUTPUT_DIR, "config.json"), {
    version: 3,
    routes: [
      {
        src: "^/api/inhabited-hotspots$",
        dest: "/api/inhabited-hotspots",
      },
      {
        src: "^/api/weather$",
        dest: "/api/weather",
      },
      {
        handle: "filesystem",
      },
    ],
  });

  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(buildVercelOutput(), null, 2));
}
