export const BROWSER_CACHE_CONTROL = "private, no-store, no-cache, max-age=0, must-revalidate";
export const BOT_PATTERN = /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|applebot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|bytespider|crawler|spider|bot)/i;
const CACHE_ENVELOPE_VERSION = 1;
const ERROR_INVALID = { error: "Valid lat and lon are required." };
const ERROR_REFRESH = { error: "Failed to refresh weather data." };

const OBSERVABILITY_UNKNOWN_VERSION = "unknown";

function deploymentVersion(env) {
  const id = env?.CF_VERSION_METADATA?.id;
  return typeof id === "string" && id.trim() ? id : OBSERVABILITY_UNKNOWN_VERSION;
}

function safeSampleRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0;
}

async function canonicalKeyHash(key) {
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Emits only fixed, allowlisted fields. Logging is deliberately best-effort. */
export function createObservability({
  deploymentVersion: version = OBSERVABILITY_UNKNOWN_VERSION,
  logger = (event) => console.log(JSON.stringify(event)),
  htmlSampleRate = 0,
  hashCanonicalKey = canonicalKeyHash,
} = {}) {
  const deployment_version = typeof version === "string" && version.trim() ? version : OBSERVABILITY_UNKNOWN_VERSION;
  const emit = (event) => {
    try {
      const result = logger?.(event);
      if (result?.catch) result.catch(() => {});
    } catch {}
  };
  const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const providerOutcome = new Set(["success", "timeout", "upstream_http", "invalid_payload", "exception"]);

  const weatherEvent = (input) => {
    switch (input?.event) {
      case "weather_cache_hit": return { event: "weather_cache_hit", deployment_version, cache_state: "fresh" };
      case "weather_cache_stale": return { event: "weather_cache_stale", deployment_version, cache_state: "stale" };
      case "weather_cache_miss": return { event: "weather_cache_miss", deployment_version, cache_state: "miss" };
      case "weather_bot_skip": return { event: "weather_bot_skip", deployment_version, cache_state: "none" };
      case "weather_validation_failure": return { event: "weather_validation_failure", deployment_version, cache_state: "none" };
      case "weather_budget_exhausted": return {
        event: "weather_budget_exhausted", deployment_version,
        cache_state: input.cache_state === "stale_refresh" ? "stale_refresh" : "miss",
        reserved_budget_used: integer(input.reserved_budget_used), reserved_budget_limit: integer(input.reserved_budget_limit),
      };
      case "weather_provider_call": return {
        event: "weather_provider_call", deployment_version,
        outcome: providerOutcome.has(input.outcome) ? input.outcome : "exception",
        upstream_status: Number.isSafeInteger(input.upstream_status) && input.upstream_status >= 100 && input.upstream_status <= 599 ? input.upstream_status : null,
        latency_ms: integer(input.latency_ms),
        cache_state: input.cache_state === "stale_refresh" ? "stale_refresh" : "miss",
        reserved_budget_used: integer(input.reserved_budget_used), reserved_budget_limit: integer(input.reserved_budget_limit),
      };
      default: return null;
    }
  };
  const keyed = (input, key, executionContext) => {
    const event = weatherEvent(input);
    if (!event) return Promise.resolve();
    const pending = Promise.resolve()
      .then(() => hashCanonicalKey(key))
      .catch(() => null)
      .then((canonical_key_hash) => emit({ ...event, canonical_key_hash: typeof canonical_key_hash === "string" && /^[a-f0-9]{64}$/.test(canonical_key_hash) ? canonical_key_hash : null }));
    try { executionContext?.waitUntil?.(pending); } catch {}
    return pending;
  };
  return {
    weather(event, key, executionContext) { return keyed(event, key, executionContext); },
    weatherUnkeyed(event) { const safe = weatherEvent(event); if (safe) emit(safe); },
    html(outcome) {
      if (Math.random() >= htmlSampleRate || !new Set(["hit", "miss", "stale"]).has(outcome)) return;
      emit({ event: "html_cache_outcome", deployment_version, outcome, cache_state: outcome, route_class: "html" });
    },
  };
}

function observabilityFor(env) {
  return env?.OBSERVABILITY && typeof env.OBSERVABILITY.weather === "function"
    ? env.OBSERVABILITY
    : createObservability({
      deploymentVersion: deploymentVersion(env),
      htmlSampleRate: safeSampleRate(env?.HTML_CACHE_EVENT_SAMPLE_RATE),
      // Test/local harnesses may opt out explicitly; staging never sets this binding.
      logger: env?.OBSERVABILITY_DISABLED === "true" ? () => {} : undefined,
    });
}

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
  const observability = observabilityFor(env);
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { allow: "GET" });
  if (isBlockedBot(request.headers.get("user-agent"))) {
    observability.weatherUnkeyed({ event: "weather_bot_skip", cache_state: "none" });
    return new Response(null, { status: 204 });
  }
  const coords = parseWeatherCoordinates(new URL(request.url).searchParams);
  if (!coords) {
    observability.weatherUnkeyed({ event: "weather_validation_failure", cache_state: "none" });
    return json(ERROR_INVALID, 400);
  }

  const key = weatherKey(coords);
  const now = Date.now();
  const cache = globalThis.caches?.default;
  const cached = await readEnvelope(cache, request, key);
  if (cached && now < cached.freshUntil) {
    observability.weather({ event: "weather_cache_hit", cache_state: "fresh" }, key, executionContext);
    return browser(cached.payload);
  }
  if (cached && now < cached.staleUntil) {
    observability.weather({ event: "weather_cache_stale", cache_state: "stale" }, key, executionContext);
    const refresh = callGate(env, key, coords, "stale")
      .then((envelope) => writeEnvelope(cache, request, key, envelope))
      .catch(() => {});
    executionContext?.waitUntil?.(refresh);
    return browser(cached.payload);
  }

  observability.weather({ event: "weather_cache_miss", cache_state: "miss" }, key, executionContext);
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
    if (!Number.isSafeInteger(limit) || limit <= 0) return { reserved: false, used: 0, limit: 0 };
    const day = new Date().toISOString().slice(0, 10);
    const key = `attempts:${day}`;
    return this.state.storage.transaction(async (storage) => {
      const current = (await storage.get(key)) ?? 0;
      if (!Number.isSafeInteger(current) || current < 0 || current >= limit) return { reserved: false, used: Number.isSafeInteger(current) && current >= 0 ? current : 0, limit };
      await storage.put(key, current + 1);
      return { reserved: true, used: current + 1, limit };
    });
  }

  async refresh({ key, lat, lon, state }) {
    const now = Date.now();
    const stored = await this.state.storage.get(`weather:${key}`);
    const storedIsValid = validEnvelope(stored, key);
    if (storedIsValid && now < stored.freshUntil) return stored;
    const stale = storedIsValid && now < stored.staleUntil ? stored : null;

    if (!this.env.OPENWEATHER_API_KEY) {
      if (stale) return stale;
      throw new Error("OpenWeather API key is not configured. Please check your environment variables.");
    }
    const reservation = await this.reserveAttempt();
    if (!reservation.reserved) {
      observabilityFor(this.env).weather({ event: "weather_budget_exhausted", cache_state: state === "stale" ? "stale_refresh" : "miss", reserved_budget_used: reservation.used, reserved_budget_limit: reservation.limit }, key);
      if (stale) return stale;
      throw new Error(ERROR_REFRESH.error);
    }

    const { timeoutMs, freshSeconds, staleSeconds } = weatherTunables(this.env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let outcome = "exception";
    let upstreamStatus = null;
    try {
      const url = new URL("https://api.openweathermap.org/data/2.5/weather");
      url.searchParams.set("lat", canonicalNumber(lat));
      url.searchParams.set("lon", canonicalNumber(lon));
      url.searchParams.set("appid", this.env.OPENWEATHER_API_KEY);
      const response = await fetch(url.toString(), { signal: controller.signal }); // one attempt; deliberately no retry
      upstreamStatus = Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      if (!response.ok) {
        outcome = "upstream_http";
        throw providerError(response);
      }
      let payload;
      try { payload = transformOpenWeather(await response.json()); }
      catch {
        outcome = "invalid_payload";
        throw new Error(ERROR_REFRESH.error);
      }
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
      outcome = "success";
      return envelope;
    } catch (error) {
      if (controller.signal.aborted) outcome = "timeout";
      if (stale) return stale;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("Failed to fetch weather data. Please check your internet connection and try again.");
      }
      throw error instanceof Error ? error : new Error("Failed to fetch weather data. Please check your internet connection and try again.");
    } finally {
      clearTimeout(timer);
      await observabilityFor(this.env).weather({
        event: "weather_provider_call",
        outcome,
        upstream_status: upstreamStatus,
        latency_ms: Math.max(0, Date.now() - startedAt),
        cache_state: state === "stale" ? "stale_refresh" : "miss",
        reserved_budget_used: reservation.used,
        reserved_budget_limit: reservation.limit,
      }, key);
    }
  }
}
