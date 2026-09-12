export const BROWSER_CACHE_CONTROL = "private, no-store, no-cache, max-age=0, must-revalidate";
export const BOT_PATTERN = /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|applebot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|bytespider|crawler|spider|bot)/i;
const CACHE_ENVELOPE_VERSION = 1;
const ERROR_INVALID = { error: "Valid lat and lon are required." };
const ERROR_REFRESH = { error: "Failed to refresh weather data." };

export function isBlockedBot(userAgent) { return Boolean(userAgent && BOT_PATTERN.test(userAgent)); }

export function parseWeatherCoordinates(searchParams) {
  const rawLat = searchParams.get("lat");
  const rawLon = searchParams.get("lon");
  if (rawLat === null || rawLon === null || rawLat.trim() === "" || rawLon.trim() === "") return null;
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

export function canonicalNumber(value) { return Object.is(value, -0) ? "0" : String(value); }
export function weatherKey({ lat, lon }) { return `weather:v1:lat:${canonicalNumber(lat)}:lon:${canonicalNumber(lon)}`; }
export function weatherCacheUrl(request, key) { return new URL(`/__weather_cache__/${encodeURIComponent(key)}`, request.url).toString(); }

export function weatherTunables(env) {
  const positiveNumber = (name, fallback) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const configuredLimit = Number(env.WEATHER_DAILY_ATTEMPT_LIMIT);
  return {
    freshSeconds: positiveNumber("WEATHER_FRESH_SECONDS", 300),
    staleSeconds: positiveNumber("WEATHER_STALE_SECONDS", 600),
    timeoutMs: positiveNumber("WEATHER_TIMEOUT_MS", 5000),
    dailyAttempts: Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 0,
  };
}

export function calculateWetBulb(temperature, humidity) {
  if (temperature < -20 || temperature > 50 || humidity < 5 || humidity > 99) throw new Error("Temperature or humidity out of valid range for Stull formula");
  const value = temperature * Math.atan(.151977 * Math.sqrt(humidity + 8.313659)) + Math.atan(temperature + humidity) - Math.atan(humidity - 1.676331) + .00391838 * Math.pow(humidity, 1.5) * Math.atan(.023101 * humidity) - 4.686035;
  return Math.round(value * 100) / 100;
}

export function kelvinToCelsius(kelvin) { return Math.round((kelvin - 273.15) * 100) / 100; }

export function transformOpenWeather(data) {
  if (!data || typeof data.name !== "string" || !data.coord || !Number.isFinite(data.coord.lat) || !Number.isFinite(data.coord.lon) || !data.main || !Number.isFinite(data.main.temp) || !Number.isFinite(data.main.humidity) || !Number.isFinite(data.dt)) throw new Error("Failed to refresh weather data.");
  const temperature = kelvinToCelsius(data.main.temp);
  return {
    location: { name: data.name, lat: data.coord.lat, lng: data.coord.lon },
    weather: {
      temperature,
      humidity: data.main.humidity,
      wetBulb: calculateWetBulb(temperature, data.main.humidity),
      timestamp: data.dt * 1000,
    },
  };
}

function validPayload(payload) {
  return payload !== null && typeof payload === "object"
    && payload.location !== null && typeof payload.location === "object"
    && typeof payload.location.name === "string"
    && Number.isFinite(payload.location.lat) && Number.isFinite(payload.location.lng)
    && payload.weather !== null && typeof payload.weather === "object"
    && Number.isFinite(payload.weather.temperature) && Number.isFinite(payload.weather.humidity)
    && Number.isFinite(payload.weather.wetBulb) && Number.isFinite(payload.weather.timestamp);
}

function validEnvelope(value, expectedKey) {
  return value !== null && typeof value === "object"
    && value.v === CACHE_ENVELOPE_VERSION
    && value.key === expectedKey
    && validPayload(value.payload)
    && Number.isFinite(value.fetchedAt)
    && Number.isFinite(value.storedAt)
    && Number.isFinite(value.freshUntil)
    && Number.isFinite(value.staleUntil)
    && value.fetchedAt <= value.storedAt
    && value.storedAt <= value.freshUntil
    && value.freshUntil <= value.staleUntil;
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
}
function browser(payload) { return json(payload, 200, { "cache-control": BROWSER_CACHE_CONTROL }); }

async function readEnvelope(cache, request, key) {
  if (!cache) return null;
  try {
    const response = await cache.match(weatherCacheUrl(request, key));
    if (!response?.ok) return null;
    const value = await response.json();
    return validEnvelope(value, key) ? value : null;
  } catch { return null; }
}

async function writeEnvelope(cache, request, key, envelope) {
  if (!cache || !validEnvelope(envelope, key)) return;
  const remainingSeconds = Math.ceil((envelope.staleUntil - Date.now()) / 1000);
  if (remainingSeconds <= 0) return;
  try {
    await cache.put(
      weatherCacheUrl(request, key),
      json(envelope, 200, { "cache-control": `public, max-age=${remainingSeconds}` }),
    );
  } catch {}
}

async function callGate(env, key, coords, state) {
  if (!env.WEATHER_GATE) throw new Error(ERROR_REFRESH.error);
  const id = env.WEATHER_GATE.idFromName("WeatherGate");
  const response = await env.WEATHER_GATE.get(id).fetch("https://weather-gate/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, ...coords, state }),
  });
  if (!response.ok) {
    let message = ERROR_REFRESH.error;
    try {
      const body = await response.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {}
    throw new Error(message);
  }
  const envelope = await response.json();
  if (!validEnvelope(envelope, key)) throw new Error(ERROR_REFRESH.error);
  return envelope;
}

export async function weatherResponse(request, env, executionContext) {
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { allow: "GET" });
  if (isBlockedBot(request.headers.get("user-agent"))) return new Response(null, { status: 204 });
  const coords = parseWeatherCoordinates(new URL(request.url).searchParams);
  if (!coords) return json(ERROR_INVALID, 400);

  const key = weatherKey(coords);
  const now = Date.now();
  const cache = globalThis.caches?.default;
  const cached = await readEnvelope(cache, request, key);
  if (cached && now < cached.freshUntil) return browser(cached.payload);
  if (cached && now < cached.staleUntil) {
    const refresh = callGate(env, key, coords, "stale")
      .then((envelope) => writeEnvelope(cache, request, key, envelope))
      .catch(() => {});
    executionContext?.waitUntil?.(refresh);
    return browser(cached.payload);
  }

  try {
    const envelope = await callGate(env, key, coords, "miss");
    await writeEnvelope(cache, request, key, envelope);
    return browser(envelope.payload);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : ERROR_REFRESH.error }, 500);
  }
}

function providerError(response) {
  const statusText = response.statusText || "";
  if (response.status === 401) return new Error("Invalid API key. Please check your OpenWeather API key configuration.");
  if (response.status === 404) return new Error("Weather data not found for this location. Please try a different location.");
  if (response.status === 429) return new Error("Too many requests to weather service. Please try again later.");
  return new Error(`Weather service error (${response.status}${statusText ? `: ${statusText}` : ""}). Please try again later.`);
}

/** The sole OpenWeather caller. One globally named instance is bound as WEATHER_GATE. */
export class WeatherGate {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.inFlight = new Map();
  }

  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/refresh") return new Response("Not found", { status: 404 });
    let body;
    try { body = await request.json(); } catch { return json(ERROR_INVALID, 400); }
    if (!this.validRequest(body)) return json(ERROR_INVALID, 400);

    if (!this.inFlight.has(body.key)) {
      this.inFlight.set(body.key, this.refresh(body).finally(() => this.inFlight.delete(body.key)));
    }
    try {
      return json(await this.inFlight.get(body.key));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : ERROR_REFRESH.error }, 500);
    }
  }

  validRequest(body) {
    return body !== null && typeof body === "object"
      && Number.isFinite(body.lat) && Number.isFinite(body.lon)
      && body.lat >= -90 && body.lat <= 90 && body.lon >= -180 && body.lon <= 180
      && body.key === weatherKey({ lat: body.lat, lon: body.lon })
      && (body.state === "miss" || body.state === "stale");
  }

  async reserveAttempt() {
    const limit = weatherTunables(this.env).dailyAttempts;
    if (!Number.isSafeInteger(limit) || limit <= 0) return false;
    const day = new Date().toISOString().slice(0, 10);
    const key = `attempts:${day}`;
    return this.state.storage.transaction(async (storage) => {
      const current = (await storage.get(key)) ?? 0;
      if (!Number.isSafeInteger(current) || current < 0 || current >= limit) return false;
      await storage.put(key, current + 1);
      return true;
    });
  }

  async refresh({ key, lat, lon }) {
    const now = Date.now();
    const stored = await this.state.storage.get(`weather:${key}`);
    const storedIsValid = validEnvelope(stored, key);
    if (storedIsValid && now < stored.freshUntil) return stored;
    const stale = storedIsValid && now < stored.staleUntil ? stored : null;

    if (!this.env.OPENWEATHER_API_KEY) {
      if (stale) return stale;
      throw new Error("OpenWeather API key is not configured. Please check your environment variables.");
    }
    if (!(await this.reserveAttempt())) {
      if (stale) return stale;
      throw new Error(ERROR_REFRESH.error);
    }

    const { timeoutMs, freshSeconds, staleSeconds } = weatherTunables(this.env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL("https://api.openweathermap.org/data/2.5/weather");
      url.searchParams.set("lat", canonicalNumber(lat));
      url.searchParams.set("lon", canonicalNumber(lon));
      url.searchParams.set("appid", this.env.OPENWEATHER_API_KEY);
      const response = await fetch(url.toString(), { signal: controller.signal }); // one attempt; deliberately no retry
      if (!response.ok) throw providerError(response);
      const payload = transformOpenWeather(await response.json());
      const storedAt = Date.now();
      const envelope = {
        v: CACHE_ENVELOPE_VERSION,
        key,
        payload,
        fetchedAt: storedAt,
        storedAt,
        freshUntil: storedAt + freshSeconds * 1000,
        staleUntil: storedAt + staleSeconds * 1000,
      };
      await this.state.storage.put(`weather:${key}`, envelope);
      return envelope;
    } catch (error) {
      if (stale) return stale;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("Failed to fetch weather data. Please check your internet connection and try again.");
      }
      throw error instanceof Error ? error : new Error("Failed to fetch weather data. Please check your internet connection and try again.");
    } finally {
      clearTimeout(timer);
    }
  }
}
