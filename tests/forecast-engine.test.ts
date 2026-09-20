import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ROMPS_METHOD,
  ROMPS_METHOD_VERSION,
  calculateRompsWetBulbCelsius,
  calculateRompsWetBulbKelvin,
} from "../lib/forecast/romps";

const referenceVectors = [
  ["published example", 100_000, 310, 0.5, 300.796982564553],
  ["saturated warm", 101_325, 300, 1, 300],
  ["dry warm", 101_325, 300, 0, 282.266332743183],
  ["hot and humid", 101_325, 308.15, 0.7, 303.207645217496],
  ["high elevation", 70_000, 303.15, 0.3, 289.659852282606],
  ["low pressure", 50_000, 300, 0.5, 291.052496488317],
  ["below triple point", 90_000, 268.15, 0.7, 266.550977075616],
  ["triple-point saturated", 100_000, 273.16, 1, 273.16],
  ["liquid/ice bistable regime", 100_000, 283.3, 0, 273.524509361457],
] as const;

describe("Romps thermodynamic liquid wet bulb", () => {
  it.each(referenceVectors)("matches the pinned reference: %s", (_name, pressurePa, airTemperatureK, relativeHumidity, expected) => {
    expect(calculateRompsWetBulbKelvin({ pressurePa, airTemperatureK, relativeHumidity })).toBeCloseTo(expected, 8);
  });

  it("matches 500 deterministic vectors from the pinned official implementation", () => {
    const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/romps-reference-vectors.v1.json", import.meta.url), "utf8"));
    expect(fixture.source).toEqual({
      package: "heatindex",
      version: "0.0.2",
      commit: "ebe4a831c1c01de071c8debf27863f1ad92b5782",
      sourceArchiveSha256: "14f9bcdb26d758458d7187503a90647764e02cb1f79315470d890aacb561ec2b",
    });
    expect(fixture.points).toBe(500);
    let maximumErrorK = 0;
    for (const vector of fixture.vectors) {
      const calculated = calculateRompsWetBulbKelvin(vector);
      maximumErrorK = Math.max(maximumErrorK, Math.abs(calculated - vector.wetBulbK));
    }
    expect(maximumErrorK).toBeLessThan(1e-8);
  });

  it("keeps calculation precision separate from display rounding", () => {
    const value = calculateRompsWetBulbCelsius({
      pressurePa: 100_000,
      airTemperatureC: 36.85,
      relativeHumidityPercent: 50,
    });
    expect(value).toBeCloseTo(27.646982564553, 8);
    expect(value).not.toBe(27.65);
  });

  it("publishes a stable method identity", () => {
    expect(ROMPS_METHOD).toBe("romps-thermodynamic-liquid");
    expect(ROMPS_METHOD_VERSION).toBe("2026-heatindex-0.0.2");
  });

  it("rejects malformed and nonphysical inputs", () => {
    const valid = { pressurePa: 100_000, airTemperatureK: 300, relativeHumidity: 0.5 };
    for (const pressurePa of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => calculateRompsWetBulbKelvin({ ...valid, pressurePa })).toThrow();
    }
    for (const airTemperatureK of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => calculateRompsWetBulbKelvin({ ...valid, airTemperatureK })).toThrow();
    }
    for (const relativeHumidity of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => calculateRompsWetBulbKelvin({ ...valid, relativeHumidity })).toThrow();
    }
    expect(() => calculateRompsWetBulbKelvin({ pressurePa: 1_000, airTemperatureK: 350, relativeHumidity: 1 })).toThrow();
  });

  it("obeys core physical invariants across representative conditions", () => {
    for (const pressurePa of [50_000, 70_000, 101_325]) {
      for (const airTemperatureK of [268.15, 283.15, 303.15, 318.15]) {
        let previous = Number.NEGATIVE_INFINITY;
        for (const relativeHumidity of [0, 0.2, 0.5, 0.8, 1]) {
          const wetBulbK = calculateRompsWetBulbKelvin({ pressurePa, airTemperatureK, relativeHumidity });
          expect(Number.isFinite(wetBulbK)).toBe(true);
          expect(wetBulbK).toBeLessThanOrEqual(airTemperatureK + 1e-9);
          expect(wetBulbK).toBeGreaterThanOrEqual(previous - 1e-9);
          previous = wetBulbK;
        }
      }
    }
  });
});
