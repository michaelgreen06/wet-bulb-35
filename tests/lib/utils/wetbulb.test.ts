import { describe, expect, it } from 'vitest';
import { calculateForecastWetBulb, calculateWetBulb } from '@/lib/utils/wetbulb';

describe('wet-bulb utilities', () => {
  it('keeps calculateWetBulb strict for existing callers', () => {
    expect(() => calculateWetBulb(35, 100)).toThrow();
    expect(() => calculateWetBulb(51, 50)).toThrow();
  });

  it('returns plausible values for hot dry and hot humid forecast conditions', () => {
    expect(calculateForecastWetBulb(45, 10)).toBeLessThan(35);
    expect(calculateForecastWetBulb(38, 60)).toBeGreaterThan(30);
  });

  it('clamps forecast humidity into the Stull formula range', () => {
    expect(() => calculateForecastWetBulb(35, 100)).not.toThrow();
    expect(calculateForecastWetBulb(35, 100)).toBe(calculateForecastWetBulb(35, 99));
    expect(calculateForecastWetBulb(35, 1)).toBe(calculateForecastWetBulb(35, 5));
  });

  it('rejects non-finite forecast values', () => {
    expect(() => calculateForecastWetBulb(Number.NaN, 50)).toThrow();
    expect(() => calculateForecastWetBulb(35, Number.POSITIVE_INFINITY)).toThrow();
  });
});
