import {
  ROMPS_METHOD,
  ROMPS_METHOD_VERSION,
  calculateRompsLiquidSaturationVaporPressurePa,
  calculateRompsWetBulbFromVaporPressureKelvin,
} from "./romps.ts";

export const OPEN_METEO_PROVIDER = "open-meteo" as const;
// Five-day city forecasts name ECMWF IFS explicitly so they match the Top-50 hotspot model.
export const OPEN_METEO_MODEL = "ecmwf_ifs025" as const;
// Version 3 keys separate IFS results from earlier best_match cache entries.
export const OPEN_METEO_SCHEMA_VERSION = 4 as const;
// Current-day, remaining-hour maxima must not reuse the old future-only cache.
export const FORECAST_SCHEMA_VERSION = 5 as const;
export const OPEN_METEO_MODEL_METADATA_URL = "https://api.open-meteo.com/data/ecmwf_ifs025/static/meta.json" as const;
// Open-Meteo copies new runs across redundant servers for several minutes after availability.
export const OPEN_METEO_RUN_SETTLE_MS = 10 * 60_000;
export const FORECAST_DAYS = 5 as const;
// Preserve five future *complete* local dates near the next daily snapshot rollover.
export const PINNED_FORECAST_HOURS = 193 as const;
export const FORECAST_PHASE_POLICY = "liquid-water" as const;

export interface ForecastLocation {
  path: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface NormalizedHourlyObservation {
  localTime: string;
  temperatureC: number;
  dewPointC: number;
  vaporPressurePa: number;
  surfacePressurePa: number;
}

export type ForecastRunId = "latest" | "snapshot-pinned" | "top50-pinned";

/** One named IFS run. A null initialization means Open-Meteo could not confirm which run answered. */
export interface ForecastModelRun {
  id: ForecastRunId;
  model: typeof OPEN_METEO_MODEL;
  initialization: string | null;
  retrievedAt: number;
}

export interface OpenMeteoSource {
  schemaVersion: typeof OPEN_METEO_SCHEMA_VERSION;
  provider: typeof OPEN_METEO_PROVIDER;
  providerModel: typeof OPEN_METEO_MODEL;
  location: ForecastLocation;
  timezone: string;
  utcOffsetSeconds: number;
  elevationM: number;
  retrievedAt: number;
  modelInitialization: string | null;
  hourly: NormalizedHourlyObservation[];
}

export interface DailyWetBulbForecast {
  date: string;
  /** Null only for today's slot after its last available future model hour. */
  maximumWetBulbC: number | null;
  peakLocalTime: string | null;
  runId: ForecastRunId;
}

/** Daily maxima precomputed from a Top-50 snapshot's pinned Open-Meteo Single Runs request. */
export interface PinnedDailyForecast {
  initialization: string;
  retrievedAt: string;
  timezone: string;
  utcOffsetSeconds: number;
  days: Array<{ date: string; maximumWetBulbC: number; peakLocalTime: string }>;
}

export interface WetBulbForecast {
  schemaVersion: typeof FORECAST_SCHEMA_VERSION;
  method: typeof ROMPS_METHOD;
  methodVersion: typeof ROMPS_METHOD_VERSION;
  phasePolicy: typeof FORECAST_PHASE_POLICY;
  provider: typeof OPEN_METEO_PROVIDER;
  providerModel: typeof OPEN_METEO_MODEL;
  location: ForecastLocation;
  timezone: string;
  utcOffsetSeconds: number;
  retrievedAt: number;
  runs: ForecastModelRun[];
  days: DailyWetBulbForecast[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const ISO_UTC_HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_UTC_OFFSET_SECONDS = 14 * 3_600;

function validInitialization(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC_HOUR.test(value) && Number.isFinite(Date.parse(value));
}

function validUtcOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && Math.abs(value as number) <= MAX_UTC_OFFSET_SECONDS;
}

/** Local calendar date for a fixed provider UTC offset. */
export function localDateAt(utcOffsetSeconds: number, now: number): string {
  return new Date(now + utcOffsetSeconds * 1_000).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Resolves the IFS initialization from Open-Meteo model metadata read after the forecast response.
 * The run is attributed only when it was available, plus a settling margin, before the forecast
 * request started; otherwise an older run may have answered and the initialization stays null.
 */
export function resolveModelInitialization(metadata: unknown, requestStartedAt: number): string | null {
  if (!isRecord(metadata) || !finiteNumber(requestStartedAt)) return null;
  const initialization = metadata.last_run_initialisation_time;
  const availability = metadata.last_run_availability_time;
  if (!Number.isSafeInteger(initialization) || !Number.isSafeInteger(availability)
    || (initialization as number) <= 0 || (availability as number) < (initialization as number)) return null;
  if ((availability as number) * 1_000 + OPEN_METEO_RUN_SETTLE_MS > requestStartedAt) return null;
  const iso = new Date((initialization as number) * 1_000).toISOString().replace(".000Z", "Z");
  return validInitialization(iso) ? iso : null;
}

function validLocation(location: ForecastLocation): boolean {
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

export function buildOpenMeteoForecastUrl(location: Pick<ForecastLocation, "latitude" | "longitude">): URL {
  if (!finiteNumber(location.latitude) || location.latitude < -90 || location.latitude > 90
    || !finiteNumber(location.longitude) || location.longitude < -180 || location.longitude > 180) {
    throw new RangeError("Forecast coordinates are invalid.");
  }
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("hourly", "temperature_2m,dew_point_2m,surface_pressure");
  url.searchParams.set("forecast_days", String(FORECAST_DAYS));
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("models", OPEN_METEO_MODEL);
  return url;
}

/** Requests one canonical city from the snapshot's exact IFS run. */
export function buildPinnedOpenMeteoForecastUrl(
  location: Pick<ForecastLocation, "latitude" | "longitude">,
  initialization: string,
): URL {
  if (!validInitialization(initialization)) throw new TypeError("Pinned forecast initialization is invalid.");
  const url = new URL("https://single-runs-api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("hourly", "temperature_2m,dew_point_2m,surface_pressure");
  // An older current snapshot may still be valid near the next daily rollover.
  // Eight days from initialization covers five future local dates across UTC offsets.
  url.searchParams.set("forecast_hours", String(PINNED_FORECAST_HOURS));
  url.searchParams.set("run", initialization.slice(0, 16));
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("models", OPEN_METEO_MODEL);
  return url;
}

function expectUnit(units: Record<string, unknown>, key: string, accepted: string[]): void {
  if (typeof units[key] !== "string" || !accepted.includes(units[key] as string)) {
    throw new TypeError(`Open-Meteo returned an unexpected ${key} unit.`);
  }
}

// Open-Meteo labels every hour with one fixed UTC offset for the whole response and
// always returns 24 rows per local day, including across DST transitions.
function validateFiveDayHourlyCoverage(observations: NormalizedHourlyObservation[]): void {
  if (observations.length !== FORECAST_DAYS * 24) {
    throw new TypeError("Open-Meteo did not return complete hourly coverage.");
  }
  const firstDay = Date.parse(`${observations[0].localTime.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(firstDay)) throw new TypeError("Open-Meteo returned an invalid local date.");
  observations.forEach((observation, index) => {
    const expectedDate = new Date(firstDay + Math.floor(index / 24) * 86_400_000).toISOString().slice(0, 10);
    const expectedTime = `${expectedDate}T${String(index % 24).padStart(2, "0")}:00`;
    if (observation.localTime !== expectedTime) {
      throw new TypeError("Open-Meteo hourly timestamps contain gaps or duplicates.");
    }
  });
}

export function normalizeOpenMeteoForecast(
  value: unknown,
  location: ForecastLocation,
  retrievedAt: number,
  modelInitialization: string | null = null,
): OpenMeteoSource {
  if (!validLocation(location) || !finiteNumber(retrievedAt) || retrievedAt <= 0 || !isRecord(value)
    || (modelInitialization !== null && !validInitialization(modelInitialization))) {
    throw new TypeError("Open-Meteo forecast metadata is invalid.");
  }
  const hourly = value.hourly;
  const units = value.hourly_units;
  if (!isRecord(hourly) || !isRecord(units)) throw new TypeError("Open-Meteo hourly forecast is missing.");
  expectUnit(units, "temperature_2m", ["°C"]);
  expectUnit(units, "dew_point_2m", ["°C"]);
  expectUnit(units, "surface_pressure", ["hPa"]);
  expectUnit(units, "time", ["iso8601"]);

  const times = hourly.time;
  const temperatures = hourly.temperature_2m;
  const dewPoints = hourly.dew_point_2m;
  const pressures = hourly.surface_pressure;
  if (![times, temperatures, dewPoints, pressures].every(Array.isArray)) {
    throw new TypeError("Open-Meteo hourly arrays are missing.");
  }
  const length = (times as unknown[]).length;
  if (length === 0 || length > FORECAST_DAYS * 24
    || (temperatures as unknown[]).length !== length
    || (dewPoints as unknown[]).length !== length
    || (pressures as unknown[]).length !== length) {
    throw new TypeError("Open-Meteo hourly arrays are misaligned.");
  }

  const observations: NormalizedHourlyObservation[] = [];
  for (let index = 0; index < length; index += 1) {
    const localTime = (times as unknown[])[index];
    const temperatureC = (temperatures as unknown[])[index];
    const dewPointC = (dewPoints as unknown[])[index];
    const surfacePressureHpa = (pressures as unknown[])[index];
    if (typeof localTime !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localTime)
      || !finiteNumber(temperatureC)
      || !finiteNumber(dewPointC)
      || !finiteNumber(surfacePressureHpa) || surfacePressureHpa <= 0) {
      throw new TypeError(`Open-Meteo hourly row ${index} is invalid.`);
    }
    // Dew point cannot physically exceed air temperature; clamp provider noise to saturation.
    const clampedDewPointC = Math.min(dewPointC, temperatureC);
    observations.push({
      localTime,
      temperatureC,
      dewPointC: clampedDewPointC,
      vaporPressurePa: calculateRompsLiquidSaturationVaporPressurePa(clampedDewPointC + 273.15),
      surfacePressurePa: surfacePressureHpa * 100,
    });
  }

  if (typeof value.timezone !== "string" || value.timezone.length === 0
    || !validUtcOffset(value.utc_offset_seconds)
    || !finiteNumber(value.elevation)
    || !finiteNumber(value.latitude)
    || !finiteNumber(value.longitude)) {
    throw new TypeError("Open-Meteo location metadata is invalid.");
  }

  validateFiveDayHourlyCoverage(observations);
  // The five local dates must begin with the location's current date; a lagging provider
  // must not turn past days into a "five-day" forecast.
  if (observations[0].localTime.slice(0, 10) !== localDateAt(value.utc_offset_seconds as number, retrievedAt)) {
    throw new TypeError("Open-Meteo forecast does not begin on the current local date.");
  }

  return {
    schemaVersion: OPEN_METEO_SCHEMA_VERSION,
    provider: OPEN_METEO_PROVIDER,
    providerModel: OPEN_METEO_MODEL,
    location: { ...location },
    timezone: value.timezone,
    utcOffsetSeconds: value.utc_offset_seconds as number,
    elevationM: value.elevation,
    retrievedAt,
    modelInitialization,
    hourly: observations,
  };
}

export function isOpenMeteoSource(value: unknown): value is OpenMeteoSource {
  if (!isRecord(value)
    || value.schemaVersion !== OPEN_METEO_SCHEMA_VERSION
    || value.provider !== OPEN_METEO_PROVIDER
    || value.providerModel !== OPEN_METEO_MODEL
    || !isRecord(value.location)
    || !validLocation(value.location as unknown as ForecastLocation)
    || typeof value.timezone !== "string"
    || !validUtcOffset(value.utcOffsetSeconds)
    || !finiteNumber(value.elevationM)
    || !finiteNumber(value.retrievedAt)
    || (value.modelInitialization !== null && !validInitialization(value.modelInitialization))
    || !Array.isArray(value.hourly)
    || value.hourly.length === 0) return false;
  const validRows = value.hourly.every((row) => isRecord(row)
    && typeof row.localTime === "string"
    && finiteNumber(row.temperatureC)
    && finiteNumber(row.dewPointC)
    && row.dewPointC <= row.temperatureC
    && finiteNumber(row.vaporPressurePa)
    && row.vaporPressurePa >= 0
    && finiteNumber(row.surfacePressurePa)
    && row.surfacePressurePa > 0
    && row.vaporPressurePa <= row.surfacePressurePa);
  if (!validRows) return false;
  try {
    validateFiveDayHourlyCoverage(value.hourly as NormalizedHourlyObservation[]);
    return true;
  } catch {
    return false;
  }
}

export function calculateFiveDayWetBulbForecast(source: OpenMeteoSource): WetBulbForecast {
  if (!isOpenMeteoSource(source)) throw new TypeError("Normalized Open-Meteo source is invalid.");
  const byDate = new Map<string, DailyWetBulbForecast>();
  for (const observation of source.hourly) {
    const hourStart = Date.parse(`${observation.localTime}:00Z`) - source.utcOffsetSeconds * 1_000;
    if (hourStart <= source.retrievedAt) continue;
    const wetBulbC = calculateRompsWetBulbFromVaporPressureKelvin({
      pressurePa: observation.surfacePressurePa,
      airTemperatureK: observation.temperatureC + 273.15,
      vaporPressurePa: observation.vaporPressurePa,
    }) - 273.15;
    const date = observation.localTime.slice(0, 10);
    const current = byDate.get(date);
    if (!current || current.maximumWetBulbC === null || wetBulbC > current.maximumWetBulbC) {
      byDate.set(date, {
        date,
        maximumWetBulbC: wetBulbC,
        peakLocalTime: observation.localTime,
        runId: "latest",
      });
    }
  }
  const today = localDateAt(source.utcOffsetSeconds, source.retrievedAt);
  if (!byDate.has(today)) byDate.set(today, { date: today, maximumWetBulbC: null, peakLocalTime: null, runId: "latest" });
  const days = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  if (days.length !== FORECAST_DAYS) throw new TypeError("Forecast aggregation did not produce five days.");
  return {
    schemaVersion: FORECAST_SCHEMA_VERSION,
    method: ROMPS_METHOD,
    methodVersion: ROMPS_METHOD_VERSION,
    phasePolicy: FORECAST_PHASE_POLICY,
    provider: OPEN_METEO_PROVIDER,
    providerModel: OPEN_METEO_MODEL,
    location: { ...source.location },
    timezone: source.timezone,
    utcOffsetSeconds: source.utcOffsetSeconds,
    retrievedAt: source.retrievedAt,
    runs: [{ id: "latest", model: OPEN_METEO_MODEL, initialization: source.modelInitialization, retrievedAt: source.retrievedAt }],
    days,
  };
}

function validRun(value: unknown): value is ForecastModelRun {
  return isRecord(value)
    && (value.id === "latest" || value.id === "snapshot-pinned" || value.id === "top50-pinned")
    && value.model === OPEN_METEO_MODEL
    && (value.initialization === null || validInitialization(value.initialization))
    && ((value.id !== "snapshot-pinned" && value.id !== "top50-pinned") || value.initialization !== null)
    && finiteNumber(value.retrievedAt)
    && (value.retrievedAt as number) > 0;
}

export function isWetBulbForecast(value: unknown): value is WetBulbForecast {
  return isRecord(value)
    && value.schemaVersion === FORECAST_SCHEMA_VERSION
    && value.method === ROMPS_METHOD
    && value.methodVersion === ROMPS_METHOD_VERSION
    && value.phasePolicy === FORECAST_PHASE_POLICY
    && value.provider === OPEN_METEO_PROVIDER
    && value.providerModel === OPEN_METEO_MODEL
    && isRecord(value.location)
    && validLocation(value.location as unknown as ForecastLocation)
    && typeof value.timezone === "string"
    && validUtcOffset(value.utcOffsetSeconds)
    && finiteNumber(value.retrievedAt)
    && Array.isArray(value.runs)
    && value.runs.length >= 1
    && value.runs.length <= 2
    && value.runs.every(validRun)
    && new Set(value.runs.map((run) => (run as ForecastModelRun).id)).size === value.runs.length
    && Array.isArray(value.days)
    && value.days.length === FORECAST_DAYS
    && value.days.every((day, index) => isRecord(day)
      && typeof day.date === "string"
      && LOCAL_DATE.test(day.date)
      && (index === 0 || day.date === addDays((value.days as DailyWetBulbForecast[])[0].date, index))
      && ((index === 0 && day.maximumWetBulbC === null && day.peakLocalTime === null)
        || (finiteNumber(day.maximumWetBulbC) && typeof day.peakLocalTime === "string"
          && day.peakLocalTime.slice(0, 10) === day.date))
      && (value.runs as ForecastModelRun[]).some((run) => run.id === day.runId))
    && (value.runs as ForecastModelRun[]).every((run) => (value.days as DailyWetBulbForecast[]).some((day) => day.runId === run.id));
}

/** Both forecast types start today; an elapsed current-day peak cannot remain cached. */
export function isCurrentForecast(forecast: WetBulbForecast, now: number): boolean {
  const today = localDateAt(forecast.utcOffsetSeconds, now);
  const first = forecast.days[0];
  if (first?.date !== today) return false;
  if (first.peakLocalTime === null && first.maximumWetBulbC === null) return true;
  if (first.peakLocalTime === null) return false;
  const peakStart = Date.parse(`${first.peakLocalTime}:00Z`) - forecast.utcOffsetSeconds * 1_000;
  return Number.isFinite(peakStart) && peakStart > now;
}

function validPinnedForecast(value: unknown): value is PinnedDailyForecast {
  return isRecord(value)
    && validInitialization(value.initialization)
    && typeof value.retrievedAt === "string"
    && Number.isFinite(Date.parse(value.retrievedAt))
    && typeof value.timezone === "string"
    && value.timezone.length > 0
    && validUtcOffset(value.utcOffsetSeconds)
    && Array.isArray(value.days)
    && value.days.every((day) => isRecord(day)
      && typeof day.date === "string"
      && LOCAL_DATE.test(day.date)
      && finiteNumber(day.maximumWetBulbC)
      && typeof day.peakLocalTime === "string"
      && day.peakLocalTime.slice(0, 10) === day.date);
}

/**
 * Combines a Top-50 location's pinned-run daily maxima with the latest explicit IFS run.
 * Pinned days are used wherever the pinned run covers a complete local date; every other
 * day comes from the latest run and is labeled with that run. Returns null when the
 * required five current local dates cannot be covered.
 */
export function combinePinnedForecast(
  location: ForecastLocation,
  pinned: PinnedDailyForecast,
  latest: WetBulbForecast | null,
  now: number,
): WetBulbForecast | null {
  if (!validLocation(location) || !validPinnedForecast(pinned)) return null;
  if (latest && (!isWetBulbForecast(latest) || latest.location.path !== location.path || !isCurrentForecast(latest, now))) {
    latest = null;
  }
  const offset = latest?.utcOffsetSeconds ?? pinned.utcOffsetSeconds;
  if (latest && latest.utcOffsetSeconds !== pinned.utcOffsetSeconds) return latest;
  const today = localDateAt(offset, now);
  const pinnedByDate = new Map(pinned.days.map((day) => [day.date, day]));
  const pinnedRun: ForecastModelRun = {
    id: "top50-pinned",
    model: OPEN_METEO_MODEL,
    initialization: pinned.initialization,
    retrievedAt: Date.parse(pinned.retrievedAt),
  };
  const days: DailyWetBulbForecast[] = [];
  for (let index = 0; index < FORECAST_DAYS; index += 1) {
    const date = addDays(today, index);
    const pinnedDay = pinnedByDate.get(date);
    if (pinnedDay) {
      days.push({ ...pinnedDay, runId: "top50-pinned" });
      continue;
    }
    const latestDay = latest?.days.find((day) => day.date === date);
    if (!latestDay) return null;
    days.push({ ...latestDay, runId: "latest" });
  }
  if (!days.some((day) => day.runId === "top50-pinned")) return latest;
  const latestRun = latest?.runs.find((run) => run.id === "latest");
  const usesLatest = days.some((day) => day.runId === "latest");
  const combined: WetBulbForecast = {
    schemaVersion: FORECAST_SCHEMA_VERSION,
    method: ROMPS_METHOD,
    methodVersion: ROMPS_METHOD_VERSION,
    phasePolicy: FORECAST_PHASE_POLICY,
    provider: OPEN_METEO_PROVIDER,
    providerModel: OPEN_METEO_MODEL,
    location: { ...location },
    timezone: latest?.timezone ?? pinned.timezone,
    utcOffsetSeconds: offset,
    retrievedAt: usesLatest && latest ? latest.retrievedAt : pinnedRun.retrievedAt,
    runs: usesLatest && latestRun ? [pinnedRun, { ...latestRun }] : [pinnedRun],
    days,
  };
  return isWetBulbForecast(combined) ? combined : null;
}

/** Validates one exact-run payload: remaining hours today and four complete future local dates. */
export function normalizePinnedOpenMeteoForecast(
  value: unknown,
  location: ForecastLocation,
  retrievedAt: number,
  initialization: string,
): WetBulbForecast {
  if (!validLocation(location) || !finiteNumber(retrievedAt) || !validInitialization(initialization) || !isRecord(value)
    || !isRecord(value.hourly) || !isRecord(value.hourly_units)) throw new TypeError("Pinned Open-Meteo forecast is invalid.");
  const hourly = value.hourly;
  const units = value.hourly_units;
  expectUnit(units, "time", ["iso8601"]);
  expectUnit(units, "temperature_2m", ["°C"]);
  expectUnit(units, "dew_point_2m", ["°C"]);
  expectUnit(units, "surface_pressure", ["hPa"]);
  if (typeof value.timezone !== "string" || !validUtcOffset(value.utc_offset_seconds)) throw new TypeError("Pinned Open-Meteo timezone metadata is invalid.");
  const arrays = [hourly.time, hourly.temperature_2m, hourly.dew_point_2m, hourly.surface_pressure];
  if (!arrays.every(Array.isArray) || arrays.some((items) => (items as unknown[]).length !== PINNED_FORECAST_HOURS)) throw new TypeError("Pinned Open-Meteo forecast must contain the full run horizon.");
  const [times, temperatures, dewPoints, pressures] = arrays as unknown[][];
  const offset = value.utc_offset_seconds as number;
  const start = Date.parse(initialization);
  const today = localDateAt(offset, retrievedAt);
  let expectedRemainingHours = 0;
  const byDate = new Map<string, Array<{ time: string; temperature: number; dewPoint: number; pressure: number }>>();
  for (let index = 0; index < PINNED_FORECAST_HOURS; index += 1) {
    const time = new Date(start + index * 3_600_000 + offset * 1_000).toISOString().slice(0, 16);
    if (times[index] !== time) throw new TypeError("Pinned Open-Meteo timestamps do not start at the requested initialization.");
    if (time.slice(0, 10) < today || (time.slice(0, 10) === today && start + index * 3_600_000 <= retrievedAt)) continue;
    if (time.slice(0, 10) === today) expectedRemainingHours += 1;
    const temperature = temperatures[index]; const dewPoint = dewPoints[index]; const pressure = pressures[index];
    if (temperature === null || dewPoint === null || pressure === null) continue;
    if (!finiteNumber(temperature) || !finiteNumber(dewPoint) || !finiteNumber(pressure) || pressure <= 0) throw new TypeError(`Pinned Open-Meteo hourly row ${index} is invalid.`);
    const entries = byDate.get(time.slice(0, 10)) ?? [];
    entries.push({ time, temperature, dewPoint: Math.min(dewPoint, temperature), pressure });
    byDate.set(time.slice(0, 10), entries);
  }
  const days: DailyWetBulbForecast[] = [];
  if (expectedRemainingHours === 0) days.push({ date: today, maximumWetBulbC: null, peakLocalTime: null, runId: "snapshot-pinned" });
  for (const [date, entries] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (date === today ? entries.length !== expectedRemainingHours : entries.length !== 24) continue;
    let maximumWetBulbC = Number.NEGATIVE_INFINITY; let peakLocalTime = "";
    for (const entry of entries) {
      const wetBulbC = calculateRompsWetBulbFromVaporPressureKelvin({ pressurePa: entry.pressure * 100, airTemperatureK: entry.temperature + 273.15, vaporPressurePa: calculateRompsLiquidSaturationVaporPressurePa(entry.dewPoint + 273.15) }) - 273.15;
      if (wetBulbC > maximumWetBulbC) { maximumWetBulbC = wetBulbC; peakLocalTime = entry.time; }
    }
    days.push({ date, maximumWetBulbC, peakLocalTime, runId: "snapshot-pinned" });
  }
  if (days.length < FORECAST_DAYS || days[0]?.date !== today
    || days.some((day, index) => index > 0 && day.date !== addDays(days[0].date, index))) {
    throw new TypeError("Pinned IFS run does not cover today’s remaining hours and four complete future local dates.");
  }
  const forecast: WetBulbForecast = { schemaVersion: FORECAST_SCHEMA_VERSION, method: ROMPS_METHOD, methodVersion: ROMPS_METHOD_VERSION, phasePolicy: FORECAST_PHASE_POLICY, provider: OPEN_METEO_PROVIDER, providerModel: OPEN_METEO_MODEL, location: { ...location }, timezone: value.timezone, utcOffsetSeconds: offset, retrievedAt, runs: [{ id: "snapshot-pinned", model: OPEN_METEO_MODEL, initialization, retrievedAt }], days: days.slice(0, FORECAST_DAYS) };
  if (!isWetBulbForecast(forecast)) throw new TypeError("Pinned Open-Meteo forecast is malformed.");
  return forecast;
}
