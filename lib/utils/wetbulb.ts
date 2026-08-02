/**
 * Calculates wet-bulb temperature using Stull's formula.
 * @param temperature Temperature in Celsius
 * @param relativeHumidity Relative humidity (in %, between 5 and 99)
 * @returns Wet-bulb temperature in Celsius
 */
export function calculateWetBulb(temperature: number, relativeHumidity: number): number {
  // Validate input ranges
  if (temperature < -20 || temperature > 50 || relativeHumidity < 5 || relativeHumidity > 99) {
    throw new Error('Temperature or humidity out of valid range for Stull formula');
  }

  // Use relativeHumidity as percent (do not convert to fraction)
  const wetBulb = temperature * Math.atan(0.151977 * Math.sqrt(relativeHumidity + 8.313659)) +
                  Math.atan(temperature + relativeHumidity) -
                  Math.atan(relativeHumidity - 1.676331) +
                  0.00391838 * Math.pow(relativeHumidity, 1.5) * Math.atan(0.023101 * relativeHumidity) -
                  4.686035;

  // Round to 2 decimal places
  return Math.round(wetBulb * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Forecast-safe wet-bulb calculation for weather model arrays.
 * Keeps the public strict helper unchanged while clamping RH into Stull's range.
 */
export function calculateForecastWetBulb(
  temperature: number,
  relativeHumidity: number,
): number {
  if (!Number.isFinite(temperature) || !Number.isFinite(relativeHumidity)) {
    throw new Error('Temperature and humidity must be finite numbers');
  }

  const formulaHumidity = clamp(relativeHumidity, 5, 99);

  const wetBulb = temperature * Math.atan(0.151977 * Math.sqrt(formulaHumidity + 8.313659)) +
                  Math.atan(temperature + formulaHumidity) -
                  Math.atan(formulaHumidity - 1.676331) +
                  0.00391838 * Math.pow(formulaHumidity, 1.5) * Math.atan(0.023101 * formulaHumidity) -
                  4.686035;

  return Math.round(wetBulb * 100) / 100;
}

/**
 * Converts temperature from Kelvin to Celsius
 */
export function kelvinToCelsius(kelvin: number): number {
  return Math.round((kelvin - 273.15) * 100) / 100;
}
