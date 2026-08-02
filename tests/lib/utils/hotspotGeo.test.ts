import { describe, expect, it } from 'vitest';
import {
  getGoogleMapsSearchUrl,
  getHaversineDistanceKm,
  getWetBulbLocationUrl,
} from '@/lib/utils/hotspotGeo';

describe('hotspot geo utilities', () => {
  it('builds Google Maps search links for raw hotspot coordinates', () => {
    expect(getGoogleMapsSearchUrl(25.9754, 57.0492)).toBe(
      'https://www.google.com/maps/search/?api=1&query=25.9754,57.0492',
    );
  });

  it('calculates haversine distance in kilometers', () => {
    const distanceKm = getHaversineDistanceKm(
      { lat: 40.7128, lon: -74.006 },
      { lat: 34.0522, lon: -118.2437 },
    );

    expect(distanceKm).toBeCloseTo(3935.7, 0);
  });

  it('builds generated location page URLs with existing slug rules', () => {
    expect(getWetBulbLocationUrl({
      name: 'Ho Chi Minh City',
      admin1: 'Ho Chi Minh',
      country: 'Vietnam',
    })).toBe('/wetbulb-temperature/vietnam/ho-chi-minh/ho-chi-minh-city');
  });
});
