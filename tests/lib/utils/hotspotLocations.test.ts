import { describe, expect, it } from 'vitest';
import {
  enrichHotspotsWithNearestLocations,
  findNearestResolvedCity,
  type ResolvedCity,
} from '@/lib/utils/hotspotLocations';
import type { HotspotCell } from '@/lib/types/hotspots';

const cities: ResolvedCity[] = [
  {
    name: 'Muscat',
    resolvedAdmin1Code: 'Muscat',
    resolvedCountryName: 'Oman',
    latitude: 23.5841,
    longitude: 58.4078,
  },
  {
    name: 'Dubai',
    resolvedAdmin1Code: 'Dubai',
    resolvedCountryName: 'United Arab Emirates',
    latitude: 25.2048,
    longitude: 55.2708,
  },
];

const hotspot: HotspotCell = {
  lat: 25.2,
  lon: 55.3,
  peakTempC: 42,
  peakTempTime: '2026-06-17T12:00:00Z',
  rhAtPeakTemp: 55,
  peakWetBulbC: 31,
  peakWetBulbTime: '2026-06-17T13:00:00Z',
  hotHours: [],
};

describe('hotspot location enrichment', () => {
  it('selects the nearest resolved city and includes generated page metadata', () => {
    expect(findNearestResolvedCity(25.2, 55.3, cities)).toMatchObject({
      name: 'Dubai',
      admin1: 'Dubai',
      country: 'United Arab Emirates',
      url: '/wetbulb-temperature/united-arab-emirates/dubai/dubai',
    });
  });

  it('enriches hotspot snapshots with nearestLocation', () => {
    const [enriched] = enrichHotspotsWithNearestLocations([hotspot], cities);

    expect(enriched.nearestLocation).toMatchObject({
      name: 'Dubai',
      distanceKm: expect.any(Number),
    });
  });
});
