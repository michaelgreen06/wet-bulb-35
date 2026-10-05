import {
  calculateRompsLiquidSaturationVaporPressurePa,
  calculateRompsWetBulbFromVaporPressureKelvin,
} from "../forecast/romps.ts";

export const HOTSPOT_OPEN_METEO_PROVIDER = "open-meteo" as const;
export const HOTSPOT_OPEN_METEO_MODEL = "ecmwf_ifs025" as const;
export const HOTSPOT_FORECAST_HOURS = 24 as const;
export const HOTSPOT_OPEN_METEO_PUBLIC_URL = "https://api.open-meteo.com/v1/forecast" as const;
export const HOTSPOT_OPEN_METEO_CUSTOMER_URL = "https://customer-api.open-meteo.com/v1/forecast" as const;
export const HOTSPOT_OPEN_METEO_SINGLE_RUNS_PUBLIC_URL = "https://single-runs-api.open-meteo.com/v1/forecast" as const;
export const HOTSPOT_OPEN_METEO_SINGLE_RUNS_CUSTOMER_URL = "https://customer-single-runs-api.open-meteo.com/v1/forecast" as const;
const APPROVED_OPEN_METEO_URLS = new Set<string>([
  HOTSPOT_OPEN_METEO_PUBLIC_URL,
  HOTSPOT_OPEN_METEO_CUSTOMER_URL,
  HOTSPOT_OPEN_METEO_SINGLE_RUNS_PUBLIC_URL,
  HOTSPOT_OPEN_METEO_SINGLE_RUNS_CUSTOMER_URL,
]);

export interface ModelGridEvidence {
  cellId: string;
  latitude: number;
  longitude: number;
}

export interface HotspotCandidate {
  path: string;
  name: string;
  state: string;
  country: string;
  latitude: number;
  longitude: number;
  selectionReason: "discovery" | "excluded-control";
  grid: ModelGridEvidence | null;
}

export interface HotspotRefinement {
  candidate: HotspotCandidate;
  modelCell: ModelGridEvidence & { elevationM: number };
  maximumWetBulbC: number;
  peakTime: string;
  airTemperatureC: number;
  dewPointC: number;
  surfacePressureHpa: number;
  validFrom: string;
  validTo: string;
}

export interface HotspotOpenMeteoOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  startHour?: string;
  endHour?: string;
  modelInitialization?: string;
}

export class HotspotProviderError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, statusText: string, retryAfter: string | null) {
    super(`Open-Meteo hotspot refinement failed (${status} ${statusText}).`);
    this.name = "HotspotProviderError";
    this.status = status;
    const retryAfterSeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    this.retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? retryAfterSeconds * 1_000
      : null;
  }
}

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

type OpenMeteoHourlyPayload = {
  time: unknown;
  temperature_2m: unknown;
  dew_point_2m: unknown;
  surface_pressure: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validCoordinate(latitude: unknown, longitude: unknown): boolean {
  return finiteNumber(latitude) && latitude >= -90 && latitude <= 90
    && finiteNumber(longitude) && longitude >= -180 && longitude <= 180;
}

function validCandidate(candidate: HotspotCandidate): boolean {
  return typeof candidate.path === "string"
    && /^\/wetbulb-temperature\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(candidate.path)
    && [candidate.name, candidate.state, candidate.country].every((value) => typeof value === "string" && value.length > 0)
    && validCoordinate(candidate.latitude, candidate.longitude)
    && ((candidate.selectionReason === "discovery"
      && isRecord(candidate.grid)
      && typeof candidate.grid.cellId === "string" && candidate.grid.cellId.length > 0
      && validCoordinate(candidate.grid.latitude, candidate.grid.longitude))
      || (candidate.selectionReason === "excluded-control" && candidate.grid === null));
}

function assertCandidates(candidates: readonly HotspotCandidate[]): void {
  if (!Array.isArray(candidates) || candidates.length === 0 || !candidates.every(validCandidate)) {
    throw new TypeError("Hotspot candidates must have trusted route, coordinate, and discovery-cell identity.");
  }
}

export function buildHotspotOpenMeteoUrl(
  candidates: readonly HotspotCandidate[],
  options: HotspotOpenMeteoOptions = {},
): URL {
  assertCandidates(candidates);
  const defaultUrl = options.modelInitialization
    ? HOTSPOT_OPEN_METEO_SINGLE_RUNS_PUBLIC_URL
    : HOTSPOT_OPEN_METEO_PUBLIC_URL;
  const url = new URL(options.baseUrl ?? defaultUrl);
  const endpoint = `${url.origin}${url.pathname}`;
  if (!APPROVED_OPEN_METEO_URLS.has(endpoint)
    || url.username || url.password || url.port || url.search || url.hash) {
    throw new TypeError("Open-Meteo hotspot endpoint is not approved.");
  }
  url.searchParams.set("latitude", candidates.map((candidate) => candidate.latitude).join(","));
  url.searchParams.set("longitude", candidates.map((candidate) => candidate.longitude).join(","));
  url.searchParams.set("hourly", "temperature_2m,dew_point_2m,surface_pressure");
  if (options.startHour || options.endHour) {
    const startHour = options.startHour ?? "";
    const endHour = options.endHour ?? "";
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(startHour)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(endHour)) {
      throw new TypeError("Open-Meteo fixed hotspot window requires UTC startHour and endHour values.");
    }
    const startMs = Date.parse(`${startHour}:00Z`);
    const endMs = Date.parse(`${endHour}:00Z`);
    if (endMs - startMs !== (HOTSPOT_FORECAST_HOURS - 1) * 3_600_000) {
      throw new TypeError("Open-Meteo fixed hotspot window must contain exactly 24 hourly rows.");
    }
    if (options.modelInitialization) {
      if (endpoint !== HOTSPOT_OPEN_METEO_SINGLE_RUNS_PUBLIC_URL
        && endpoint !== HOTSPOT_OPEN_METEO_SINGLE_RUNS_CUSTOMER_URL) {
        throw new TypeError("Pinned hotspot refinement requires an approved Open-Meteo Single Runs endpoint.");
      }
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(options.modelInitialization)) {
        throw new TypeError("Pinned hotspot refinement requires a UTC model initialization on the hour.");
      }
      const runMs = Date.parse(options.modelInitialization);
      const forecastHours = Math.floor((endMs - runMs) / 3_600_000) + 1;
      if (!Number.isFinite(runMs) || startMs < runMs || forecastHours < HOTSPOT_FORECAST_HOURS || forecastHours > 241) {
        throw new TypeError("Pinned hotspot refinement window is outside the supported model run.");
      }
      url.searchParams.set("run", options.modelInitialization.slice(0, 16));
      url.searchParams.set("forecast_hours", String(forecastHours));
    } else {
      url.searchParams.set("start_hour", startHour);
      url.searchParams.set("end_hour", endHour);
    }
  } else {
    url.searchParams.set("forecast_hours", String(HOTSPOT_FORECAST_HOURS));
  }
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("models", HOTSPOT_OPEN_METEO_MODEL);
  if (options.apiKey?.trim()) url.searchParams.set("apikey", options.apiKey.trim());
  return url;
}

function expectUnit(units: Record<string, unknown>, key: string, expected: string): void {
  if (units[key] !== expected) throw new TypeError(`Open-Meteo returned an unexpected ${key} unit.`);
}

function toUtcIsoHour(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    throw new TypeError("Open-Meteo returned an invalid hourly timestamp.");
  }
  const parsed = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 16) !== value) {
    throw new TypeError("Open-Meteo returned an invalid hourly timestamp.");
  }
  return `${value}:00Z`;
}

function wrappedLongitudeDistance(left: number, right: number): number {
  return Math.abs(((left - right + 540) % 360) - 180);
}

function rounded(value: number, digits: number): string {
  return value.toFixed(digits).replace("-0.", "0.");
}

function modelCell(value: Record<string, unknown>, candidate: HotspotCandidate): HotspotRefinement["modelCell"] {
  const latitude = value.latitude;
  const longitude = value.longitude;
  const elevation = value.elevation;
  if (!finiteNumber(latitude) || latitude < -90 || latitude > 90
    || !finiteNumber(longitude) || longitude < -180 || longitude > 180
    || !finiteNumber(elevation)) {
    throw new TypeError("Open-Meteo response is missing resolved model-cell coordinates or elevation.");
  }
  if (Math.abs(latitude - candidate.latitude) > 2 || wrappedLongitudeDistance(longitude, candidate.longitude) > 2) {
    throw new TypeError("Open-Meteo resolved a model cell implausibly far from the requested city.");
  }
  return {
    cellId: `${rounded(latitude, 4)}:${rounded(longitude, 4)}`,
    latitude,
    longitude,
    elevationM: elevation,
  };
}

function normalizeOneResponse(
  value: unknown,
  candidate: HotspotCandidate,
  window?: { startHour: string; endHour: string },
): HotspotRefinement {
  if (!isRecord(value) || !isRecord(value.hourly) || !isRecord(value.hourly_units)) {
    throw new TypeError("Open-Meteo hourly forecast is missing.");
  }
  const units = value.hourly_units;
  expectUnit(units, "time", "iso8601");
  expectUnit(units, "temperature_2m", "°C");
  expectUnit(units, "dew_point_2m", "°C");
  expectUnit(units, "surface_pressure", "hPa");

  const hourly = value.hourly as OpenMeteoHourlyPayload;
  const arrays = [hourly.time, hourly.temperature_2m, hourly.dew_point_2m, hourly.surface_pressure];
  if (!arrays.every(Array.isArray)) throw new TypeError("Open-Meteo hourly arrays are missing.");
  const [times, temperatures, dewPoints, pressures] = arrays as unknown[][];
  if (times.length === 0 || temperatures.length !== times.length
    || dewPoints.length !== times.length || pressures.length !== times.length) {
    throw new TypeError("Open-Meteo hourly forecast must contain aligned rows.");
  }

  const requestedStart = window ? `${window.startHour}:00Z` : null;
  const requestedEnd = window ? `${window.endHour}:00Z` : null;
  const selectedIndices = times
    .map((rawTime, index) => typeof rawTime === "string" ? { index, time: toUtcIsoHour(rawTime) } : null)
    .filter((entry): entry is { index: number; time: string } => entry !== null
      && (!requestedStart || (entry.time >= requestedStart && entry.time <= requestedEnd!)))
    .map((entry) => entry.index);
  if (selectedIndices.length !== HOTSPOT_FORECAST_HOURS) {
    throw new TypeError("Open-Meteo hourly forecast does not contain the requested 24-hour window.");
  }

  let maximumWetBulbC = Number.NEGATIVE_INFINITY;
  let peakTime = "";
  let airTemperatureC = Number.NaN;
  let dewPointC = Number.NaN;
  let surfacePressureHpa = Number.NaN;
  let validFrom = "";
  let firstMs = 0;
  for (const [windowIndex, index] of selectedIndices.entries()) {
    const pressureHpa = pressures[index];
    if (typeof times[index] !== "string" || !finiteNumber(temperatures[index])
      || !finiteNumber(dewPoints[index]) || !finiteNumber(pressureHpa) || pressureHpa <= 0) {
      throw new TypeError(`Open-Meteo hourly row ${index} is invalid.`);
    }
    const time = toUtcIsoHour(times[index] as string);
    const timestamp = Date.parse(time);
    if (windowIndex === 0) {
      firstMs = timestamp;
      validFrom = time;
    } else if (timestamp !== firstMs + windowIndex * 3_600_000) {
      throw new TypeError("Open-Meteo hourly timestamps are not in exact UTC order.");
    }
    const temperatureC = temperatures[index] as number;
    const clampedDewPointC = Math.min(dewPoints[index] as number, temperatureC);
    const vaporPressurePa = calculateRompsLiquidSaturationVaporPressurePa(clampedDewPointC + 273.15);
    const wetBulbC = calculateRompsWetBulbFromVaporPressureKelvin({
      pressurePa: pressureHpa * 100,
      airTemperatureK: temperatureC + 273.15,
      vaporPressurePa,
    }) - 273.15;
    if (wetBulbC > maximumWetBulbC) {
      maximumWetBulbC = wetBulbC;
      peakTime = time;
      airTemperatureC = temperatureC;
      dewPointC = clampedDewPointC;
      surfacePressureHpa = pressureHpa;
    }
  }
  const validTo = new Date(firstMs + HOTSPOT_FORECAST_HOURS * 3_600_000).toISOString().replace(".000Z", "Z");
  return {
    candidate: { ...candidate, grid: candidate.grid ? { ...candidate.grid } : null },
    modelCell: modelCell(value, candidate),
    maximumWetBulbC,
    peakTime,
    airTemperatureC,
    dewPointC,
    surfacePressureHpa,
    validFrom,
    validTo,
  };
}

export function normalizeHotspotOpenMeteoResponse(
  value: unknown,
  candidates: readonly HotspotCandidate[],
  window?: { startHour: string; endHour: string },
): HotspotRefinement[] {
  assertCandidates(candidates);
  const responses = Array.isArray(value) ? value : [value];
  if (responses.length !== candidates.length) {
    throw new TypeError("Open-Meteo multi-location response count did not match the trusted request order.");
  }
  const refinements = responses.map((response, index) => normalizeOneResponse(response, candidates[index], window));
  const validFrom = refinements[0].validFrom;
  const validTo = refinements[0].validTo;
  if (!refinements.every((refinement) => refinement.validFrom === validFrom && refinement.validTo === validTo)) {
    throw new TypeError("Open-Meteo multi-location responses did not share one 24-hour UTC forecast window.");
  }
  return refinements;
}

export async function refineHotspotCandidates(
  candidates: readonly HotspotCandidate[],
  fetchImplementation: FetchImplementation = fetch,
  options: HotspotOpenMeteoOptions = {},
): Promise<HotspotRefinement[]> {
  const url = buildHotspotOpenMeteoUrl(candidates, options);
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
    ? options.timeoutMs as number
    : 30_000;
  const response = await fetchImplementation(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok) {
    throw new HotspotProviderError(response.status, response.statusText, response.headers.get("retry-after"));
  }
  const window = options.startHour && options.endHour
    ? { startHour: options.startHour, endHour: options.endHour }
    : undefined;
  const refinements = normalizeHotspotOpenMeteoResponse(await response.json(), candidates, window);
  if (options.startHour) {
    const expectedStart = `${options.startHour}:00Z`;
    const expectedEnd = new Date(Date.parse(expectedStart) + HOTSPOT_FORECAST_HOURS * 3_600_000).toISOString().replace(".000Z", "Z");
    if (refinements.some((entry) => entry.validFrom !== expectedStart || entry.validTo !== expectedEnd)) {
      throw new TypeError("Open-Meteo response did not match the requested fixed hotspot window.");
    }
  }
  return refinements;
}

/** Steps 0..144 of one pinned IFS run: the longest horizon Open-Meteo serves for every cycle. */
export const HOTSPOT_PINNED_FORECAST_HOURS = 145 as const;

export interface HotspotPinnedDailyForecast {
  path: string;
  initialization: string;
  retrievedAt: string;
  timezone: string;
  utcOffsetSeconds: number;
  days: Array<{ date: string; maximumWetBulbC: number; peakLocalTime: string }>;
}

function localIsoHour(ms: number, offsetSeconds: number): string {
  return new Date(ms + offsetSeconds * 1_000).toISOString().slice(0, 16);
}

/**
 * Requests local-time hourly values from the same pinned run for published Top-50 locations only,
 * so city five-day views can reuse that run without refining every global-scan candidate for 120 hours.
 */
export function buildPinnedDailyForecastUrl(
  candidates: readonly HotspotCandidate[],
  options: { baseUrl?: string; apiKey?: string; modelInitialization: string },
): URL {
  assertCandidates(candidates);
  const url = new URL(options.baseUrl ?? HOTSPOT_OPEN_METEO_SINGLE_RUNS_PUBLIC_URL);
  const endpoint = `${url.origin}${url.pathname}`;
  if ((endpoint !== HOTSPOT_OPEN_METEO_SINGLE_RUNS_PUBLIC_URL && endpoint !== HOTSPOT_OPEN_METEO_SINGLE_RUNS_CUSTOMER_URL)
    || url.username || url.password || url.port || url.search || url.hash) {
    throw new TypeError("Pinned five-day refinement requires an approved Open-Meteo Single Runs endpoint.");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(options.modelInitialization)) {
    throw new TypeError("Pinned five-day refinement requires a UTC model initialization on the hour.");
  }
  url.searchParams.set("latitude", candidates.map((candidate) => candidate.latitude).join(","));
  url.searchParams.set("longitude", candidates.map((candidate) => candidate.longitude).join(","));
  url.searchParams.set("hourly", "temperature_2m,dew_point_2m,surface_pressure");
  url.searchParams.set("run", options.modelInitialization.slice(0, 16));
  url.searchParams.set("forecast_hours", String(HOTSPOT_PINNED_FORECAST_HOURS));
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("models", HOTSPOT_OPEN_METEO_MODEL);
  if (options.apiKey?.trim()) url.searchParams.set("apikey", options.apiKey.trim());
  return url;
}

function normalizeOnePinnedDaily(
  value: unknown,
  candidate: HotspotCandidate,
  initialization: string,
  retrievedAt: string,
): HotspotPinnedDailyForecast {
  if (!isRecord(value) || !isRecord(value.hourly) || !isRecord(value.hourly_units)) {
    throw new TypeError("Open-Meteo pinned hourly forecast is missing.");
  }
  const units = value.hourly_units;
  expectUnit(units, "time", "iso8601");
  expectUnit(units, "temperature_2m", "°C");
  expectUnit(units, "dew_point_2m", "°C");
  expectUnit(units, "surface_pressure", "hPa");
  const offset = value.utc_offset_seconds;
  if (typeof value.timezone !== "string" || value.timezone.length === 0
    || !Number.isSafeInteger(offset) || Math.abs(offset as number) > 14 * 3_600) {
    throw new TypeError("Open-Meteo pinned forecast timezone metadata is invalid.");
  }
  const hourly = value.hourly as OpenMeteoHourlyPayload;
  const arrays = [hourly.time, hourly.temperature_2m, hourly.dew_point_2m, hourly.surface_pressure];
  if (!arrays.every(Array.isArray)) throw new TypeError("Open-Meteo pinned hourly arrays are missing.");
  const [times, temperatures, dewPoints, pressures] = arrays as unknown[][];
  if (times.length !== HOTSPOT_PINNED_FORECAST_HOURS || [temperatures, dewPoints, pressures].some((values) => values.length !== times.length)) {
    throw new TypeError("Open-Meteo pinned hourly forecast must contain the full pinned run horizon.");
  }
  const initializationMs = Date.parse(initialization);
  const byDate = new Map<string, { hours: number; maximumWetBulbC: number; peakLocalTime: string }>();
  for (let index = 0; index < times.length; index += 1) {
    const expected = localIsoHour(initializationMs + index * 3_600_000, offset as number);
    if (times[index] !== expected) throw new TypeError("Open-Meteo pinned hourly timestamps do not start at the pinned initialization.");
    const temperatureC = temperatures[index];
    const dewPointC = dewPoints[index];
    const pressureHpa = pressures[index];
    // Missing values mark the end of the run's coverage; incomplete local dates are dropped below.
    if (temperatureC === null || dewPointC === null || pressureHpa === null) continue;
    if (!finiteNumber(temperatureC) || !finiteNumber(dewPointC) || !finiteNumber(pressureHpa) || pressureHpa <= 0) {
      throw new TypeError(`Open-Meteo pinned hourly row ${index} is invalid.`);
    }
    const clampedDewPointC = Math.min(dewPointC, temperatureC);
    const wetBulbC = calculateRompsWetBulbFromVaporPressureKelvin({
      pressurePa: pressureHpa * 100,
      airTemperatureK: temperatureC + 273.15,
      vaporPressurePa: calculateRompsLiquidSaturationVaporPressurePa(clampedDewPointC + 273.15),
    }) - 273.15;
    const date = expected.slice(0, 10);
    const current = byDate.get(date) ?? { hours: 0, maximumWetBulbC: Number.NEGATIVE_INFINITY, peakLocalTime: "" };
    current.hours += 1;
    if (wetBulbC > current.maximumWetBulbC) {
      current.maximumWetBulbC = wetBulbC;
      current.peakLocalTime = expected;
    }
    byDate.set(date, current);
  }
  // Open-Meteo reports one fixed offset per response, so every complete local date has 24 rows.
  const days = [...byDate.entries()]
    .filter(([, day]) => day.hours === 24)
    .map(([date, day]) => ({ date, maximumWetBulbC: Number(day.maximumWetBulbC.toFixed(3)), peakLocalTime: day.peakLocalTime }))
    .sort((left, right) => left.date.localeCompare(right.date));
  return {
    path: candidate.path,
    initialization,
    retrievedAt,
    timezone: value.timezone,
    utcOffsetSeconds: offset as number,
    days,
  };
}

export function normalizePinnedDailyForecastResponse(
  value: unknown,
  candidates: readonly HotspotCandidate[],
  initialization: string,
  retrievedAt: string,
): HotspotPinnedDailyForecast[] {
  assertCandidates(candidates);
  const responses = Array.isArray(value) ? value : [value];
  if (responses.length !== candidates.length) {
    throw new TypeError("Open-Meteo pinned response count did not match the trusted request order.");
  }
  return responses.map((response, index) => normalizeOnePinnedDaily(response, candidates[index], initialization, retrievedAt));
}

export async function fetchPinnedDailyForecasts(
  candidates: readonly HotspotCandidate[],
  fetchImplementation: FetchImplementation = fetch,
  options: { baseUrl?: string; apiKey?: string; timeoutMs?: number; modelInitialization: string; now?: () => Date },
): Promise<HotspotPinnedDailyForecast[]> {
  const url = buildPinnedDailyForecastUrl(candidates, options);
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0 ? options.timeoutMs as number : 30_000;
  const response = await fetchImplementation(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok) throw new HotspotProviderError(response.status, response.statusText, response.headers.get("retry-after"));
  const retrievedAt = (options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  return normalizePinnedDailyForecastResponse(await response.json(), candidates, options.modelInitialization, retrievedAt);
}
