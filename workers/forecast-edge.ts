import {
  ROMPS_METHOD_VERSION,
} from "../lib/forecast/romps.ts";
import {
  OPEN_METEO_MODEL_METADATA_URL,
  OPEN_METEO_SCHEMA_VERSION,
  FORECAST_SCHEMA_VERSION,
  buildOpenMeteoForecastUrl,
  buildPinnedOpenMeteoForecastUrl,
  calculateFiveDayWetBulbForecast,
  normalizePinnedOpenMeteoForecast,
  isCurrentForecast,
  isOpenMeteoSource,
  isWetBulbForecast,
  localDateAt,
  normalizeOpenMeteoForecast,
  resolveModelInitialization,
  type ForecastLocation,
  type OpenMeteoSource,
  type PinnedDailyForecast,
  type WetBulbForecast,
} from "../lib/forecast/open-meteo.ts";

export const FORECAST_BROWSER_CACHE_CONTROL = "private, no-store, no-cache, max-age=0, must-revalidate";
const FORECAST_CACHE_ENVELOPE_VERSION = 1;
const FORECAST_SOURCE_RECORD_VERSION = 1;
const FORECAST_ERROR = "Forecast is temporarily unavailable.";
const BOT_PATTERN = /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|applebot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|bytespider|crawler|spider|bot)/i;

interface ForecastTunables {
  freshSeconds: number;
  staleSeconds: number;
  timeoutMs: number;
  dailyAttempts: number;
}

interface ForecastEnvelope {
  v: typeof FORECAST_CACHE_ENVELOPE_VERSION;
  key: string;
  payload: WetBulbForecast;
  fetchedAt: number;
  storedAt: number;
  freshUntil: number;
  staleUntil: number;
}

interface ForecastSourceRecord {
  v: typeof FORECAST_SOURCE_RECORD_VERSION;
  key: string;
  source: OpenMeteoSource;
  fetchedAt: number;
  freshUntil: number;
  staleUntil: number;
}

interface ForecastGateBody {
  key: string;
  location: ForecastLocation;
  state: "miss" | "stale";
  modelInitialization?: string | null;
}

interface Storage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  transaction<T>(callback: (storage: Storage) => Promise<T>): Promise<T>;
}

interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

interface ExecutionContextLike {
  waitUntil?(promise: Promise<unknown>): void;
}

interface ForecastEnvironment {
  WEATHER_GATE?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
  };
  FORECAST_FRESH_SECONDS?: string;
  FORECAST_STALE_SECONDS?: string;
  FORECAST_TIMEOUT_MS?: string;
  FORECAST_DAILY_ATTEMPT_LIMIT?: string;
  OPEN_METEO_BASE_URL?: string;
  OPEN_METEO_API_KEY?: string;
  OPEN_METEO_API_MODE?: string;
}

export type ResolveForecastLocation = (path: string) => Promise<ForecastLocation | null>;
export type ResolvePinnedForecast = (path: string) => Promise<string | PinnedDailyForecast | null>;
export const SNAPSHOT_FORECAST_UNAVAILABLE = "__hotspot_snapshot_unavailable__";
const METADATA_TIMEOUT_MS = 2_000;

type ForecastTelemetryEvent = {
  event: "forecast_budget_exhausted" | "forecast_provider_call";
  outcome?: "success" | "timeout" | "upstream_http" | "invalid_payload" | "exception";
  upstream_status?: number | null;
  latency_ms?: number;
  cache_state: "miss" | "stale_refresh";
  reserved_budget_used: number;
  reserved_budget_limit: number;
};

type EmitForecastTelemetry = (event: ForecastTelemetryEvent) => void | Promise<void>;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validLocation(value: unknown): value is ForecastLocation {
  if (value === null || typeof value !== "object") return false;
  const location = value as Record<string, unknown>;
  return typeof location.path === "string"
    && /^\/wetbulb-temperature\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(location.path)
    && typeof location.name === "string"
    && location.name.length > 0
    && finiteNumber(location.latitude)
    && location.latitude >= -90
    && location.latitude <= 90
    && finiteNumber(location.longitude)
    && location.longitude >= -180
    && location.longitude <= 180;
}

export function forecastKey(path: string, modelInitialization: string | null = null): string {
  return `forecast:v${FORECAST_SCHEMA_VERSION}:${ROMPS_METHOD_VERSION}:run:${modelInitialization ?? "latest"}:path:${path}`;
}

function sourceKey(path: string): string {
  return `open-meteo:v${OPEN_METEO_SCHEMA_VERSION}:path:${path}`;
}

export function forecastTunables(env: ForecastEnvironment): ForecastTunables {
  const positiveNumber = (name: keyof ForecastEnvironment, fallback: number): number => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const configuredLimit = Number(env.FORECAST_DAILY_ATTEMPT_LIMIT);
  return {
    freshSeconds: positiveNumber("FORECAST_FRESH_SECONDS", 10_800),
    staleSeconds: positiveNumber("FORECAST_STALE_SECONDS", 43_200),
    timeoutMs: positiveNumber("FORECAST_TIMEOUT_MS", 5_000),
    dailyAttempts: Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 0,
  };
}

function json(payload: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
}

function browser(payload: WetBulbForecast): Response {
  return json(payload, 200, { "cache-control": FORECAST_BROWSER_CACHE_CONTROL });
}

function isForecastEnvelope(value: unknown, expectedKey: string): value is ForecastEnvelope {
  if (value === null || typeof value !== "object") return false;
  const envelope = value as Record<string, unknown>;
  return envelope.v === FORECAST_CACHE_ENVELOPE_VERSION
    && envelope.key === expectedKey
    && isWetBulbForecast(envelope.payload)
    && finiteNumber(envelope.fetchedAt)
    && finiteNumber(envelope.storedAt)
    && finiteNumber(envelope.freshUntil)
    && finiteNumber(envelope.staleUntil)
    && envelope.fetchedAt <= envelope.storedAt
    && envelope.storedAt <= envelope.freshUntil
    && envelope.freshUntil <= envelope.staleUntil;
}

function isSourceRecord(value: unknown, expectedKey: string): value is ForecastSourceRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.v === FORECAST_SOURCE_RECORD_VERSION
    && record.key === expectedKey
    && isOpenMeteoSource(record.source)
    && finiteNumber(record.fetchedAt)
    && finiteNumber(record.freshUntil)
    && finiteNumber(record.staleUntil)
    && record.fetchedAt <= record.freshUntil
    && record.freshUntil <= record.staleUntil;
}

function forecastCacheUrl(request: Request, key: string): string {
  return new URL(`/__forecast_cache__/${encodeURIComponent(key)}`, request.url).toString();
}

async function readCache(cache: CacheLike | undefined, request: Request, key: string): Promise<ForecastEnvelope | null> {
  if (!cache) return null;
  try {
    const response = await cache.match(forecastCacheUrl(request, key));
    if (!response?.ok) return null;
    const value: unknown = await response.json();
    return isForecastEnvelope(value, key) ? value : null;
  } catch {
    return null;
  }
}

async function writeCache(cache: CacheLike | undefined, request: Request, key: string, envelope: ForecastEnvelope): Promise<void> {
  if (!cache || !isForecastEnvelope(envelope, key)) return;
  const remainingSeconds = Math.ceil((envelope.staleUntil - Date.now()) / 1_000);
  if (remainingSeconds <= 0) return;
  try {
    await cache.put(
      forecastCacheUrl(request, key),
      json(envelope, 200, { "cache-control": `public, max-age=${remainingSeconds}` }),
    );
  } catch {
    // A cache write must never turn a valid forecast into a user-visible failure.
  }
}

async function callGate(
  env: ForecastEnvironment,
  body: ForecastGateBody,
): Promise<ForecastEnvelope> {
  const { key, location, state } = body;
  if (!env.WEATHER_GATE) throw new Error(FORECAST_ERROR);
  const id = env.WEATHER_GATE.idFromName("WeatherGate");
  const response = await env.WEATHER_GATE.get(id).fetch("https://weather-gate/forecast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(FORECAST_ERROR);
  const envelope: unknown = await response.json();
  if (!isForecastEnvelope(envelope, key)) throw new Error(FORECAST_ERROR);
  return envelope;
}

export async function forecastResponse(
  request: Request,
  env: ForecastEnvironment,
  executionContext: ExecutionContextLike | undefined,
  resolveLocation: ResolveForecastLocation,
  injectedCache?: CacheLike,
  resolvePinned?: ResolvePinnedForecast,
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { allow: "GET" });
  if (BOT_PATTERN.test(request.headers.get("user-agent") || "")) return new Response(null, { status: 204 });
  const path = new URL(request.url).searchParams.get("path");
  if (!path || !/^\/wetbulb-temperature\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(path)) {
    return json({ error: "A canonical location path is required." }, 400);
  }
  let location: ForecastLocation | null;
  try {
    location = await resolveLocation(path);
  } catch {
    return json({ error: FORECAST_ERROR }, 500);
  }
  if (!location || !validLocation(location) || location.path !== path) {
    return json({ error: "Forecast is not available for this location." }, 404);
  }

  let resolvedPinned: string | PinnedDailyForecast | null = null;
  try { resolvedPinned = resolvePinned ? await resolvePinned(path) : null; } catch { resolvedPinned = SNAPSHOT_FORECAST_UNAVAILABLE; }
  const modelInitialization = typeof resolvedPinned === "string" ? resolvedPinned : null;
  if (modelInitialization === SNAPSHOT_FORECAST_UNAVAILABLE) {
    return json({ error: "Forecast unavailable: the current hotspot snapshot is unavailable." }, 503);
  }
  const key = forecastKey(path, modelInitialization);
  const now = Date.now();
  const respond = (payload: WetBulbForecast): Response => browser(payload);
  const cache = injectedCache ?? (globalThis as typeof globalThis & { caches?: { default?: CacheLike } }).caches?.default;
  const stored = await readCache(cache, request, key);
  // Past local dates are never served as a five-day forecast, even inside the stale window.
  const cached = stored && isCurrentForecast(stored.payload, now) ? stored : null;
  if (cached && now < cached.freshUntil) return respond(cached.payload);
  if (cached && now < cached.staleUntil) {
    const refresh = callGate(env, { key, location, state: "stale", modelInitialization })
      .then((envelope) => writeCache(cache, request, key, envelope))
      .catch(() => undefined);
    executionContext?.waitUntil?.(refresh);
    return respond(cached.payload);
  }

  try {
    const envelope = await callGate(env, { key, location, state: "miss", modelInitialization });
    if (!isCurrentForecast(envelope.payload, Date.now())) throw new Error(FORECAST_ERROR);
    await writeCache(cache, request, key, envelope);
    return respond(envelope.payload);
  } catch {
    return json({ error: FORECAST_ERROR }, 500);
  }
}

export function validForecastGateRequest(value: unknown): value is ForecastGateBody {
  if (value === null || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  const modelInitialization = body.modelInitialization;
  const initialization = typeof modelInitialization === "string" ? modelInitialization : null;
  return typeof body.key === "string"
    && validLocation(body.location)
    && (modelInitialization === undefined || modelInitialization === null || (typeof modelInitialization === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(modelInitialization)))
    && body.key === forecastKey(body.location.path, initialization)
    && (body.state === "miss" || body.state === "stale");
}

async function reserveForecastAttempt(storage: Storage, limit: number): Promise<{ reserved: boolean; used: number; limit: number }> {
  if (!Number.isSafeInteger(limit) || limit <= 0) return { reserved: false, used: 0, limit: 0 };
  const day = new Date().toISOString().slice(0, 10);
  const key = `forecast-attempts:${day}`;
  return storage.transaction(async (transaction) => {
    const current = (await transaction.get(key)) ?? 0;
    if (!Number.isSafeInteger(current) || (current as number) < 0 || (current as number) >= limit) {
      return { reserved: false, used: Number.isSafeInteger(current) && (current as number) >= 0 ? current as number : 0, limit };
    }
    await transaction.put(key, (current as number) + 1);
    return { reserved: true, used: (current as number) + 1, limit };
  });
}

/**
 * Labels the IFS run from Open-Meteo's lightweight model metadata, read after the forecast.
 * This static file is not a weighted forecast call; any failure leaves the run unconfirmed.
 */
async function readModelInitialization(url: URL, requestStartedAt: number): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
    if (!response.ok) return null;
    return resolveModelInitialization(await response.json(), requestStartedAt);
  } catch {
    return null;
  }
}

function createEnvelope(key: string, source: OpenMeteoSource, storedAt: number, tunables: ForecastTunables): ForecastEnvelope {
  const payload = calculateFiveDayWetBulbForecast(source);
  const freshUntil = source.retrievedAt + tunables.freshSeconds * 1_000;
  return {
    v: FORECAST_CACHE_ENVELOPE_VERSION,
    key,
    payload,
    fetchedAt: source.retrievedAt,
    storedAt,
    freshUntil: Math.max(storedAt, freshUntil),
    staleUntil: Math.max(storedAt, source.retrievedAt + tunables.staleSeconds * 1_000),
  };
}

export async function refreshForecast(
  storage: Storage,
  env: ForecastEnvironment,
  body: ForecastGateBody,
  emitTelemetry?: EmitForecastTelemetry,
): Promise<ForecastEnvelope> {
  if (!validForecastGateRequest(body)) throw new TypeError("Invalid forecast refresh request.");
  const tunables = forecastTunables(env);
  const now = Date.now();
  const storedResult = await storage.get(`forecast-result:${body.key}`);
  const validResult = isForecastEnvelope(storedResult, body.key) && isCurrentForecast(storedResult.payload, now) ? storedResult : null;
  if (validResult && now < validResult.freshUntil) return validResult;
  const staleResult = validResult && now < validResult.staleUntil ? validResult : null;

  if (body.modelInitialization) {
    const initialization = body.modelInitialization;
    const apiMode = env.OPEN_METEO_API_MODE?.trim();
    if (apiMode !== "public-noncommercial" && apiMode !== "customer-commercial") throw new Error("Open-Meteo usage mode is not approved.");
    const apiKey = env.OPEN_METEO_API_KEY?.trim();
    if (apiMode === "customer-commercial" && !apiKey) throw new Error("Open-Meteo customer endpoint requires an API key.");
    const reservation = await reserveForecastAttempt(storage, tunables.dailyAttempts);
    if (!reservation.reserved) throw new Error(FORECAST_ERROR);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), tunables.timeoutMs);
    try {
      const url = buildPinnedOpenMeteoForecastUrl(body.location, initialization);
      if (apiMode === "customer-commercial") { url.host = "customer-single-runs-api.open-meteo.com"; url.searchParams.set("apikey", apiKey as string); }
      const configuredBase = env.OPEN_METEO_BASE_URL?.trim();
      if (configuredBase) { const base = new URL(configuredBase); url.protocol = base.protocol; url.host = base.host; }
      if (!url.hostname.endsWith("single-runs-api.open-meteo.com")) throw new Error("Pinned forecasts require an approved Open-Meteo Single Runs endpoint.");
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(FORECAST_ERROR);
      const payload = normalizePinnedOpenMeteoForecast(await response.json(), body.location, Date.now(), initialization);
      const storedAt = Date.now();
      const envelope: ForecastEnvelope = { v: FORECAST_CACHE_ENVELOPE_VERSION, key: body.key, payload, fetchedAt: payload.retrievedAt, storedAt, freshUntil: Math.max(storedAt, payload.retrievedAt + tunables.freshSeconds * 1_000), staleUntil: Math.max(storedAt, payload.retrievedAt + tunables.staleSeconds * 1_000) };
      await storage.put(`forecast-result:${body.key}`, envelope);
      return envelope;
    } finally { clearTimeout(timer); }
  }

  const rawKey = sourceKey(body.location.path);
  const storedSource = await storage.get(`forecast-source:${rawKey}`);
  const sourceRecord = isSourceRecord(storedSource, rawKey)
    && storedSource.source.hourly[0].localTime.slice(0, 10) === localDateAt(storedSource.source.utcOffsetSeconds, now)
    ? storedSource
    : null;
  let source = sourceRecord && now < sourceRecord.freshUntil ? sourceRecord.source : null;

  if (!source) {
    const apiMode = env.OPEN_METEO_API_MODE?.trim();
    if (apiMode !== "public-noncommercial" && apiMode !== "customer-commercial") {
      if (staleResult) return staleResult;
      throw new Error("Open-Meteo usage mode is not approved.");
    }
    const apiKey = env.OPEN_METEO_API_KEY?.trim();
    if (apiMode === "customer-commercial" && !apiKey) {
      if (staleResult) return staleResult;
      throw new Error("Open-Meteo customer endpoint requires an API key.");
    }
    const reservation = await reserveForecastAttempt(storage, tunables.dailyAttempts);
    const cacheState = body.state === "stale" ? "stale_refresh" : "miss";
    if (!reservation.reserved) {
      try {
        await emitTelemetry?.({
          event: "forecast_budget_exhausted",
          cache_state: cacheState,
          reserved_budget_used: reservation.used,
          reserved_budget_limit: reservation.limit,
        });
      } catch {}
      if (staleResult) return staleResult;
      throw new Error(FORECAST_ERROR);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), tunables.timeoutMs);
    const startedAt = Date.now();
    let outcome: ForecastTelemetryEvent["outcome"] = "exception";
    let upstreamStatus: number | null = null;
    const approvedUrl = (url: URL): URL => {
      if (apiMode === "customer-commercial") {
        url.host = "customer-api.open-meteo.com";
        url.searchParams.set("apikey", apiKey as string);
      }
      const configuredBase = env.OPEN_METEO_BASE_URL?.trim();
      if (configuredBase) {
        const base = new URL(configuredBase);
        url.protocol = base.protocol;
        url.host = base.host;
      }
      if (url.hostname.startsWith("customer-") && apiMode !== "customer-commercial") {
        throw new Error("Open-Meteo customer endpoint requires an API key.");
      }
      return url;
    };
    try {
      const url = approvedUrl(buildOpenMeteoForecastUrl(body.location));
      const requestStartedAt = Date.now();
      const response = await fetch(url, { signal: controller.signal });
      upstreamStatus = response.status;
      if (!response.ok) {
        outcome = "upstream_http";
        throw new Error(FORECAST_ERROR);
      }
      let upstream: unknown;
      try {
        upstream = await response.json();
        const retrievedAt = Date.now();
        const modelInitialization = await readModelInitialization(approvedUrl(new URL(OPEN_METEO_MODEL_METADATA_URL)), requestStartedAt);
        source = normalizeOpenMeteoForecast(upstream, body.location, retrievedAt, modelInitialization);
        const record: ForecastSourceRecord = {
          v: FORECAST_SOURCE_RECORD_VERSION,
          key: rawKey,
          source,
          fetchedAt: retrievedAt,
          freshUntil: retrievedAt + tunables.freshSeconds * 1_000,
          staleUntil: retrievedAt + tunables.staleSeconds * 1_000,
        };
        await storage.put(`forecast-source:${rawKey}`, record);
        outcome = "success";
      } catch {
        outcome = "invalid_payload";
        throw new Error(FORECAST_ERROR);
      }
    } catch (error) {
      if (controller.signal.aborted) outcome = "timeout";
      if (staleResult) return staleResult;
      throw error instanceof Error ? error : new Error(FORECAST_ERROR);
    } finally {
      clearTimeout(timer);
      try {
        await emitTelemetry?.({
          event: "forecast_provider_call",
          outcome,
          upstream_status: upstreamStatus,
          latency_ms: Math.max(0, Date.now() - startedAt),
          cache_state: cacheState,
          reserved_budget_used: reservation.used,
          reserved_budget_limit: reservation.limit,
        });
      } catch {}
    }
  }

  const storedAt = Date.now();
  const envelope = createEnvelope(body.key, source, storedAt, tunables);
  await storage.put(`forecast-result:${body.key}`, envelope);
  return envelope;
}
