import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PopulatedCity } from '@/lib/types/hotspots';

const COORD_PRECISION = 4;

type RawPopulatedCity = {
  name?: unknown;
  countryCode?: unknown;
  country?: unknown;
  admin1Code?: unknown;
  admin1?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  population?: unknown;
};

export function getPopulatedCitiesPath(): string {
  return path.join(process.cwd(), 'scripts', 'populated_cities.json');
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }

  return Number.NaN;
}

function roundCoord(value: number): number {
  return Number(value.toFixed(COORD_PRECISION));
}

export function normalizePopulatedCity(raw: RawPopulatedCity): PopulatedCity | null {
  const latitude = toNumber(raw.latitude);
  const longitude = toNumber(raw.longitude);
  const population = toNumber(raw.population);

  if (
    typeof raw.name !== 'string' ||
    raw.name.trim() === '' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(population) ||
    population <= 0
  ) {
    return null;
  }

  return {
    name: raw.name.trim(),
    countryCode: typeof raw.countryCode === 'string' ? raw.countryCode : undefined,
    country: typeof raw.country === 'string' ? raw.country : undefined,
    admin1Code: typeof raw.admin1Code === 'string' ? raw.admin1Code : undefined,
    admin1: typeof raw.admin1 === 'string' ? raw.admin1 : undefined,
    latitude: roundCoord(latitude),
    longitude: roundCoord(longitude),
    population: Math.trunc(population),
  };
}

export function filterPopulatedCities(
  cities: PopulatedCity[],
  minPopulation: number,
): PopulatedCity[] {
  return cities
    .filter((city) => city.population > minPopulation)
    .sort((a, b) => b.population - a.population || a.name.localeCompare(b.name));
}

export async function loadPopulatedCities(): Promise<PopulatedCity[]> {
  let raw: string;

  try {
    raw = await fs.readFile(getPopulatedCitiesPath(), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        'Missing scripts/populated_cities.json. Run `node scripts/create-populated-cities.js` before generating inhabited hotspots.',
      );
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as RawPopulatedCity[];

  if (!Array.isArray(parsed)) {
    throw new Error('scripts/populated_cities.json must contain a JSON array.');
  }

  return parsed
    .map((city) => normalizePopulatedCity(city))
    .filter((city): city is PopulatedCity => city !== null);
}
