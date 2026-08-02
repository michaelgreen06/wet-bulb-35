import { describe, expect, it } from 'vitest';
import {
  filterPopulatedCities,
  normalizePopulatedCity,
} from '@/lib/utils/inhabitedHotspotLocations';
import type { PopulatedCity } from '@/lib/types/hotspots';

describe('inhabited hotspot city data', () => {
  it('normalizes populated city records and preserves population', () => {
    expect(normalizePopulatedCity({
      name: ' Jacobabad ',
      latitude: '28.281',
      longitude: '68.4388',
      countryCode: 'PK',
      admin1Code: '05',
      population: '170588',
    })).toEqual({
      name: 'Jacobabad',
      latitude: 28.281,
      longitude: 68.4388,
      countryCode: 'PK',
      country: undefined,
      admin1Code: '05',
      admin1: undefined,
      population: 170588,
    });
  });

  it('filters cities strictly above the minimum population and sorts largest first', () => {
    const cities: PopulatedCity[] = [
      { name: 'Small', latitude: 1, longitude: 1, population: 25000 },
      { name: 'Medium', latitude: 2, longitude: 2, population: 50000 },
      { name: 'Large', latitude: 3, longitude: 3, population: 100000 },
    ];

    expect(filterPopulatedCities(cities, 25000).map((city) => city.name)).toEqual([
      'Large',
      'Medium',
    ]);
  });
});
