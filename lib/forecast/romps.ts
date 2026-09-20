/*
 * Thermodynamic liquid wet-bulb calculation ported from davidromps/heatindex
 * commit ebe4a831c1c01de071c8debf27863f1ad92b5782 (MIT).
 * Copyright (c) 2025 Yi-Chuan Lu and David M. Romps.
 * Algorithm: Romps (2026), https://doi.org/10.1175/JAMC-D-25-0130.1
 */

export const ROMPS_METHOD = "romps-thermodynamic-liquid" as const;
export const ROMPS_METHOD_VERSION = "2026-heatindex-0.0.2" as const;

const TRIPLE_POINT_K = 273.16;
const TRIPLE_POINT_PA = 611.65;
const E0V = 2.374e6;
const E0S = 0.3337e6;
const RGASA = 287.04;
const RGASV = 461;
const CVA = 719;
const CVV = 1418;
const CVL = 4119;
const CVS = 1861;
const CPA = CVA + RGASA;
const CPV = CVV + RGASV;
const ROOT_TOLERANCE_K = 1e-10;
const MAX_ROOT_ITERATIONS = 1_000;

export interface RompsKelvinInput {
  pressurePa: number;
  airTemperatureK: number;
  relativeHumidity: number;
}

export interface RompsCelsiusInput {
  pressurePa: number;
  airTemperatureC: number;
  relativeHumidityPercent: number;
}

export interface RompsVaporPressureInput {
  pressurePa: number;
  airTemperatureK: number;
  vaporPressurePa: number;
}

function latentHeatEvaporation(temperatureK: number): number {
  return E0V + (CVV - CVL) * (temperatureK - TRIPLE_POINT_K) + RGASV * temperatureK;
}

function saturationVaporPressureLiquid(temperatureK: number): number {
  if (temperatureK <= 0) return 0;
  return TRIPLE_POINT_PA
    * Math.pow(temperatureK / TRIPLE_POINT_K, (CPV - CVL) / RGASV)
    * Math.exp(
      ((E0V - (CVV - CVL) * TRIPLE_POINT_K) / RGASV)
      * (1 / TRIPLE_POINT_K - 1 / temperatureK),
    );
}

export function calculateRompsLiquidSaturationVaporPressurePa(temperatureK: number): number {
  if (!Number.isFinite(temperatureK) || temperatureK <= 0) {
    throw new RangeError("Saturation temperature must be a positive finite number.");
  }
  return saturationVaporPressureLiquid(temperatureK);
}

function saturationVaporPressureIce(temperatureK: number): number {
  if (temperatureK <= 0) return 0;
  return TRIPLE_POINT_PA
    * Math.pow(temperatureK / TRIPLE_POINT_K, (CPV - CVS) / RGASV)
    * Math.exp(
      ((E0V + E0S - (CVV - CVS) * TRIPLE_POINT_K) / RGASV)
      * (1 / TRIPLE_POINT_K - 1 / temperatureK),
    );
}

function saturationSpecificHumidityLiquid(pressurePa: number, temperatureK: number): number {
  if (temperatureK <= 0) return 0;
  const saturationPressure = saturationVaporPressureLiquid(temperatureK);
  if (saturationPressure > pressurePa) return saturationPressure / pressurePa;
  return 1 / (
    (RGASV * pressurePa) / (RGASA * TRIPLE_POINT_PA)
      * Math.pow(TRIPLE_POINT_K / temperatureK, (CPV - CVL) / RGASV)
      * Math.exp(
        -((E0V - (CVV - CVL) * TRIPLE_POINT_K) / RGASV)
        * (1 / TRIPLE_POINT_K - 1 / temperatureK),
      )
    - RGASV / RGASA
    + 1
  );
}

function solveBracketed(
  fn: (value: number) => number,
  lower: number,
  upper: number,
  lowerValue = fn(lower),
  upperValue = fn(upper),
  tolerance = ROOT_TOLERANCE_K,
): number {
  if (!Number.isFinite(lowerValue) || !Number.isFinite(upperValue) || lowerValue * upperValue > 0) {
    throw new RangeError("Romps root is not bracketed.");
  }
  if (lowerValue === 0) return lower;
  if (upperValue === 0) return upper;

  let a = lower;
  let b = upper;
  let fa = lowerValue;
  let fb = upperValue;
  if (Math.abs(fa) < Math.abs(fb)) {
    [a, b] = [b, a];
    [fa, fb] = [fb, fa];
  }
  let c = a;
  let fc = fa;
  let s = b;
  let d = b - a;
  let bisected = true;

  for (let iteration = 0; iteration < MAX_ROOT_ITERATIONS; iteration += 1) {
    if (fa !== fc && fb !== fc) {
      s = (a * fb * fc) / ((fa - fb) * (fa - fc))
        + (b * fa * fc) / ((fb - fa) * (fb - fc))
        + (c * fa * fb) / ((fc - fa) * (fc - fb));
    } else {
      s = b - (fb * (b - a)) / (fb - fa);
    }

    const boundary = (3 * a + b) / 4;
    const outside = !(
      (s > boundary && s < b)
      || (s < boundary && s > b)
    );
    if (
      outside
      || (bisected && Math.abs(s - b) >= Math.abs(b - c) / 2)
      || (!bisected && Math.abs(s - b) >= Math.abs(c - d) / 2)
    ) {
      s = (a + b) / 2;
      bisected = true;
    } else {
      bisected = false;
    }

    const fs = fn(s);
    if (!Number.isFinite(fs)) throw new RangeError("Romps root evaluation was not finite.");
    d = c;
    c = b;
    fc = fb;
    if (fa * fs < 0) {
      b = s;
      fb = fs;
    } else {
      a = s;
      fa = fs;
    }
    if (Math.abs(fa) < Math.abs(fb)) {
      [a, b] = [b, a];
      [fa, fb] = [fb, fa];
    }
    if (Math.abs(b - a) < tolerance) return b;
  }
  throw new RangeError("Romps root solver reached its iteration limit.");
}

function liquidSaturationTemperature(vaporPressurePa: number): number {
  if (vaporPressurePa === 0) return 0;
  if (!Number.isFinite(vaporPressurePa) || vaporPressurePa < 0) {
    throw new RangeError("Vapor pressure must be finite and nonnegative.");
  }
  let upper = TRIPLE_POINT_K;
  while (saturationVaporPressureLiquid(upper) < vaporPressurePa) {
    upper *= 1.25;
    if (!Number.isFinite(upper) || upper > 2_000) {
      throw new RangeError("Unable to bracket liquid saturation temperature.");
    }
  }
  return solveBracketed(
    (temperatureK) => saturationVaporPressureLiquid(temperatureK) - vaporPressurePa,
    0,
    upper,
    -vaporPressurePa,
    saturationVaporPressureLiquid(upper) - vaporPressurePa,
  );
}

export function calculateRompsWetBulbFromVaporPressureKelvin(input: RompsVaporPressureInput): number {
  const { pressurePa, airTemperatureK, vaporPressurePa } = input;
  if (![pressurePa, airTemperatureK, vaporPressurePa].every(Number.isFinite)) {
    throw new TypeError("Romps inputs must be finite numbers.");
  }
  if (pressurePa <= 0) throw new RangeError("Air pressure must be positive.");
  if (airTemperatureK <= 0) throw new RangeError("Air temperature must be positive.");
  if (vaporPressurePa < 0 || vaporPressurePa > pressurePa) {
    throw new RangeError("Water-vapor partial pressure cannot exceed air pressure.");
  }

  const vaporMassFraction = (RGASA * vaporPressurePa)
    / (RGASV * pressurePa - RGASV * vaporPressurePa + RGASA * vaporPressurePa);
  const moistHeatCapacity = (1 - vaporMassFraction) * CPA + vaporMassFraction * CPV;
  const lower = liquidSaturationTemperature(vaporPressurePa);
  const upper = Math.min(airTemperatureK, liquidSaturationTemperature(pressurePa));
  const residual = (wetBulbK: number): number => {
    const saturatedMassFraction = saturationSpecificHumidityLiquid(pressurePa, wetBulbK);
    return moistHeatCapacity * (wetBulbK - airTemperatureK) * (1 - saturatedMassFraction)
      + (saturatedMassFraction - vaporMassFraction) * latentHeatEvaporation(wetBulbK);
  };
  const lowerResidual = residual(lower);
  const upperResidual = residual(upper);
  if (lowerResidual === 0) return lower;
  if (upperResidual === 0 || lowerResidual * upperResidual > 0) return upper;
  return solveBracketed(residual, lower, upper, lowerResidual, upperResidual);
}

export function calculateRompsWetBulbKelvin(input: RompsKelvinInput): number {
  const { pressurePa, airTemperatureK, relativeHumidity } = input;
  if (![pressurePa, airTemperatureK, relativeHumidity].every(Number.isFinite)) {
    throw new TypeError("Romps inputs must be finite numbers.");
  }
  if (relativeHumidity < 0 || relativeHumidity > 1) {
    throw new RangeError("Relative humidity must be between 0 and 1.");
  }
  const saturationPressure = airTemperatureK > TRIPLE_POINT_K
    ? saturationVaporPressureLiquid(airTemperatureK)
    : saturationVaporPressureIce(airTemperatureK);
  return calculateRompsWetBulbFromVaporPressureKelvin({
    pressurePa,
    airTemperatureK,
    vaporPressurePa: relativeHumidity * saturationPressure,
  });
}

export function calculateRompsWetBulbCelsius(input: RompsCelsiusInput): number {
  const { pressurePa, airTemperatureC, relativeHumidityPercent } = input;
  if (!Number.isFinite(airTemperatureC) || !Number.isFinite(relativeHumidityPercent)) {
    throw new TypeError("Romps inputs must be finite numbers.");
  }
  return calculateRompsWetBulbKelvin({
    pressurePa,
    airTemperatureK: airTemperatureC + 273.15,
    relativeHumidity: relativeHumidityPercent / 100,
  }) - 273.15;
}
