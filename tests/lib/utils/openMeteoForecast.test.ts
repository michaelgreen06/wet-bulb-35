import { describe, expect, it, vi } from 'vitest';
import {
  buildOpenMeteoForecastUrl,
  fetchOpenMeteoBatch,
} from '@/lib/utils/openMeteoForecast';

describe('Open-Meteo forecast client', () => {
  it('builds a multi-coordinate hourly forecast URL', () => {
    const url = new URL(buildOpenMeteoForecastUrl({
      coords: [
        { lat: 10, lon: 20 },
        { lat: -5, lon: 30 },
      ],
      forecastHours: 24,
      landFocused: true,
    }));

    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(url.searchParams.get('latitude')).toBe('10,-5');
    expect(url.searchParams.get('longitude')).toBe('20,30');
    expect(url.searchParams.get('hourly')).toBe('temperature_2m,relative_humidity_2m');
    expect(url.searchParams.get('timezone')).toBe('GMT');
    expect(url.searchParams.get('forecast_hours')).toBe('24');
    expect(url.searchParams.get('cell_selection')).toBe('land');
  });

  it('normalizes a single-object response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        latitude: 10,
        longitude: 20,
        hourly: {
          time: ['2026-06-16T12:00'],
          temperature_2m: [40],
          relative_humidity_2m: [50],
        },
      }),
    } as Response);

    const points = await fetchOpenMeteoBatch({
      coords: [{ lat: 10, lon: 20 }],
      forecastHours: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(points).toHaveLength(1);
    expect(points[0].hourly.temperature_2m).toEqual([40]);
  });

  it('normalizes an array response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [
        {
          latitude: 10,
          longitude: 20,
          hourly: {
            time: ['2026-06-16T12:00'],
            temperature_2m: [40],
            relative_humidity_2m: [50],
          },
        },
        {
          latitude: 15,
          longitude: 25,
          hourly: {
            time: ['2026-06-16T12:00'],
            temperature_2m: [41],
            relative_humidity_2m: [60],
          },
        },
      ],
    } as Response);

    await expect(fetchOpenMeteoBatch({
      coords: [
        { lat: 10, lon: 20 },
        { lat: 15, lon: 25 },
      ],
      forecastHours: 1,
    })).resolves.toHaveLength(2);
  });

  it('throws useful errors for non-200 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => 'bad weather',
    } as Response);

    await expect(fetchOpenMeteoBatch({
      coords: [{ lat: 10, lon: 20 }],
      forecastHours: 1,
    })).rejects.toThrow('Open-Meteo forecast request failed');
  });
});
