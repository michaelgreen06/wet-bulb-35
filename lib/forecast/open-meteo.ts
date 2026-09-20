import {
  ROMPS_METHOD,
  ROMPS_METHOD_VERSION,
  calculateRompsLiquidSaturationVaporPressurePa,
  calculateRompsWetBulbFromVaporPressureKelvin,
} from "./romps.ts";

export const OPEN_METEO_PROVIDER = "open-meteo" as const;
export const OPEN_METEO_MODEL = "best_match" as const;
export const OPEN_METEO_SCHEMA_VERSION = 2 as const;
export const FORECAST_SCHEMA_VERSION = 2 as const;
export const FORECAST_DAYS = 5 as const;
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

export interface OpenMeteoSource {
  schemaVersion: typeof OPEN_METEO_SCHEMA_VERSION;
  provider: typeof OPEN_METEO_PROVIDER;
  providerModel: typeof OPEN_METEO_MODEL;
  location: ForecastLocation;
  timezone: string;
  utcOffsetSeconds: number;
  elevationM: number;
  retrievedAt: number;
  hourly: NormalizedHourlyObservation[];
}

export interface DailyWetBulbForecast {
  date: string;
  maximumWetBulbC: number;
  peakLocalTime: string;
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
  retrievedAt: number;
  days: DailyWetBulbForecast[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
): OpenMeteoSource {
  if (!validLocation(location) || !finiteNumber(retrievedAt) || retrievedAt <= 0 || !isRecord(value)) {
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
    || !Number.isSafeInteger(value.utc_offset_seconds)
    || !finiteNumber(value.elevation)
    || !finiteNumber(value.latitude)
    || !finiteNumber(value.longitude)) {
    throw new TypeError("Open-Meteo location metadata is invalid.");
  }

  validateFiveDayHourlyCoverage(observations);

  return {
    schemaVersion: OPEN_METEO_SCHEMA_VERSION,
    provider: OPEN_METEO_PROVIDER,
    providerModel: OPEN_METEO_MODEL,
    location: { ...location },
    timezone: value.timezone,
    utcOffsetSeconds: value.utc_offset_seconds as number,
    elevationM: value.elevation,
    retrievedAt,
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
    || !Number.isSafeInteger(value.utcOffsetSeconds)
    || !finiteNumber(value.elevationM)
    || !finiteNumber(value.retrievedAt)
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
    const wetBulbC = calculateRompsWetBulbFromVaporPressureKelvin({
      pressurePa: observation.surfacePressurePa,
      airTemperatureK: observation.temperatureC + 273.15,
      vaporPressurePa: observation.vaporPressurePa,
    }) - 273.15;
    const date = observation.localTime.slice(0, 10);
    const current = byDate.get(date);
    if (!current || wetBulbC > current.maximumWetBulbC) {
      byDate.set(date, {
        date,
        maximumWetBulbC: wetBulbC,
        peakLocalTime: observation.localTime,
      });
    }
  }
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
    retrievedAt: source.retrievedAt,
    days,
  };
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
    && finiteNumber(value.retrievedAt)
    && Array.isArray(value.days)
    && value.days.length === FORECAST_DAYS
    && value.days.every((day) => isRecord(day)
      && typeof day.date === "string"
      && finiteNumber(day.maximumWetBulbC)
      && typeof day.peakLocalTime === "string");
}
