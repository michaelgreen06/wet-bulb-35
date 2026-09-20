import { describe, expect, it } from "vitest";
import {
  FORECAST_DAYS,
  buildOpenMeteoForecastUrl,
  calculateFiveDayWetBulbForecast,
  isOpenMeteoSource,
  isWetBulbForecast,
  normalizeOpenMeteoForecast,
} from "../lib/forecast/open-meteo";
import {
  ROMPS_METHOD_VERSION,
  calculateRompsLiquidSaturationVaporPressurePa,
  calculateRompsWetBulbFromVaporPressureKelvin,
} from "../lib/forecast/romps";

const location = {
  path: "/wetbulb-temperature/united-states/texas/houston/",
  name: "Houston, Texas, United States",
  latitude: 29.7604,
  longitude: -95.3698,
};

function upstreamFixture() {
  const time: string[] = [];
  const temperature_2m: number[] = [];
  const dew_point_2m: number[] = [];
  const surface_pressure: number[] = [];
  for (let day = 20; day < 20 + FORECAST_DAYS; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      time.push(`2026-09-${day}T${String(hour).padStart(2, "0")}:00`);
      temperature_2m.push(hour === 15 ? 34 + (day - 20) : 24);
      dew_point_2m.push(hour === 15 ? 25 : 20);
      surface_pressure.push(hour === 15 ? 1000 : 1005);
    }
  }
  return {
    latitude: 29.75,
    longitude: -95.375,
    elevation: 12,
    utc_offset_seconds: -18_000,
    timezone: "America/Chicago",
    hourly_units: {
      time: "iso8601",
      temperature_2m: "°C",
      dew_point_2m: "°C",
      surface_pressure: "hPa",
    },
    hourly: { time, temperature_2m, dew_point_2m, surface_pressure },
  };
}

describe("Open-Meteo forecast adapter", () => {
  it("requests exactly the five-day, three-variable MVP contract", () => {
    const url = buildOpenMeteoForecastUrl(location);
    expect(url.origin + url.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(url.searchParams.get("hourly")).toBe("temperature_2m,dew_point_2m,surface_pressure");
    expect(url.searchParams.get("forecast_days")).toBe("5");
    expect(url.searchParams.get("timezone")).toBe("auto");
    expect(url.searchParams.get("models")).toBe("best_match");
  });

  it("normalizes units, pressure, vapor pressure, and complete local-time rows", () => {
    const source = normalizeOpenMeteoForecast(upstreamFixture(), location, 1_700_000_000_000);
    expect(source.hourly).toHaveLength(120);
    expect(source.hourly[0]).toEqual({
      localTime: "2026-09-20T00:00",
      temperatureC: 24,
      dewPointC: 20,
      vaporPressurePa: calculateRompsLiquidSaturationVaporPressurePa(293.15),
      surfacePressurePa: 100_500,
    });
    expect(source.timezone).toBe("America/Chicago");
    expect(isOpenMeteoSource(source)).toBe(true);
  });

  it("uses dew point to avoid cold-phase RH ambiguity before selecting each local day's maximum", () => {
    const source = normalizeOpenMeteoForecast(upstreamFixture(), location, 1_700_000_000_000);
    const forecast = calculateFiveDayWetBulbForecast(source);
    expect(forecast.days).toHaveLength(5);
    expect(forecast.days[0].peakLocalTime).toBe("2026-09-20T15:00");
    expect(forecast.days[0].maximumWetBulbC).toBeCloseTo(calculateRompsWetBulbFromVaporPressureKelvin({
      pressurePa: 100_000,
      airTemperatureK: 34 + 273.15,
      vaporPressurePa: calculateRompsLiquidSaturationVaporPressurePa(25 + 273.15),
    }) - 273.15, 10);
    expect(forecast.methodVersion).toBe(ROMPS_METHOD_VERSION);
    expect(isWetBulbForecast(forecast)).toBe(true);
  });

  it("derives subfreezing vapor pressure from dew point without a provider RH phase assumption", () => {
    const cold = upstreamFixture();
    cold.hourly.temperature_2m.fill(-5);
    cold.hourly.dew_point_2m.fill(-7);
    const source = normalizeOpenMeteoForecast(cold, location, 1_700_000_000_000);
    const expectedVaporPressure = calculateRompsLiquidSaturationVaporPressurePa(266.15);
    expect(source.hourly[0].vaporPressurePa).toBe(expectedVaporPressure);
    const forecast = calculateFiveDayWetBulbForecast(source);
    expect(forecast.days[0].maximumWetBulbC).toBeCloseTo(calculateRompsWetBulbFromVaporPressureKelvin({
      pressurePa: 100_500,
      airTemperatureK: 268.15,
      vaporPressurePa: expectedVaporPressure,
    }) - 273.15, 10);
  });

  it("accepts Open-Meteo's fixed-offset 24-row days across a DST transition", () => {
    // Live provider behavior: America/Chicago 2026-11-01 still arrives as 00:00..23:00 with one 01:00.
    const fall = upstreamFixture();
    fall.hourly.time = fall.hourly.time.map((value) => {
      const day = Number(value.slice(8, 10));
      return `2026-${day < 22 ? "10" : "11"}-${String(day < 22 ? day + 10 : day - 21).padStart(2, "0")}${value.slice(10)}`;
    });
    expect(fall.hourly.time).toContain("2026-11-01T01:00");
    expect(normalizeOpenMeteoForecast(fall, location, Date.now()).hourly).toHaveLength(120);
  });

  it("rejects 23-hour and 25-hour days", () => {
    const spring = upstreamFixture();
    const missing = spring.hourly.time.indexOf("2026-09-21T02:00");
    for (const values of Object.values(spring.hourly)) values.splice(missing, 1);
    expect(() => normalizeOpenMeteoForecast(spring, location, Date.now())).toThrow(/coverage/);

    const fall = upstreamFixture();
    const repeated = fall.hourly.time.indexOf("2026-09-21T01:00");
    for (const values of Object.values(fall.hourly)) values.splice(repeated, 0, values[repeated] as never);
    expect(() => normalizeOpenMeteoForecast(fall, location, Date.now())).toThrow(/coverage|misaligned/);
  });

  it("rejects bad units, misaligned arrays, gaps, duplicates, and incomplete days", () => {
    const badUnit = upstreamFixture();
    badUnit.hourly_units.surface_pressure = "Pa";
    expect(() => normalizeOpenMeteoForecast(badUnit, location, Date.now())).toThrow(/unit/);

    const misaligned = upstreamFixture();
    misaligned.hourly.temperature_2m.pop();
    expect(() => normalizeOpenMeteoForecast(misaligned, location, Date.now())).toThrow(/misaligned/);

    const gap = upstreamFixture();
    const missing = gap.hourly.time.indexOf("2026-09-21T02:00");
    for (const values of Object.values(gap.hourly)) values.splice(missing, 1);
    const secondMissing = gap.hourly.time.indexOf("2026-09-21T03:00");
    for (const values of Object.values(gap.hourly)) values.splice(secondMissing, 1);
    expect(() => normalizeOpenMeteoForecast(gap, location, Date.now())).toThrow(/coverage|incomplete/);

    const duplicate = upstreamFixture();
    duplicate.hourly.time[25] = duplicate.hourly.time[24];
    expect(() => normalizeOpenMeteoForecast(duplicate, location, Date.now())).toThrow(/gaps or duplicates/);

    const incomplete = upstreamFixture();
    for (const key of Object.keys(incomplete.hourly) as Array<keyof typeof incomplete.hourly>) {
      incomplete.hourly[key] = incomplete.hourly[key].slice(0, 96) as never;
    }
    expect(() => normalizeOpenMeteoForecast(incomplete, location, Date.now())).toThrow(/coverage/);
  });
});
