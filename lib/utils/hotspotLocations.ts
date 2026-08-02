import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HotspotCell, HotspotNearestLocation } from '@/lib/types/hotspots';
import { getHaversineDistanceKm, getWetBulbLocationUrl } from '@/lib/utils/hotspotGeo';

export type ResolvedCity = {
  name: string;
  resolvedCountryName: string;
  resolvedAdmin1Code: string;
  latitude: number;
  longitude: number;
};

export function findNearestResolvedCity(
  lat: number,
  lon: number,
  cities: ResolvedCity[],
): HotspotNearestLocation | null {
  let nearestCity: ResolvedCity | null = null;
  let nearestDistanceKm = Number.POSITIVE_INFINITY;

  for (const city of cities) {
    if (!Number.isFinite(city.latitude) || !Number.isFinite(city.longitude)) {
      continue;
    }

    const distanceKm = getHaversineDistanceKm(
      { lat, lon },
      { lat: city.latitude, lon: city.longitude },
    );

    if (distanceKm < nearestDistanceKm) {
      nearestCity = city;
      nearestDistanceKm = distanceKm;
    }
  }

  if (!nearestCity) {
    return null;
  }

  return {
    name: nearestCity.name,
    admin1: nearestCity.resolvedAdmin1Code,
    country: nearestCity.resolvedCountryName,
    lat: nearestCity.latitude,
    lon: nearestCity.longitude,
    distanceKm: Number(nearestDistanceKm.toFixed(1)),
    url: getWetBulbLocationUrl({
      name: nearestCity.name,
      admin1: nearestCity.resolvedAdmin1Code,
      country: nearestCity.resolvedCountryName,
    }),
  };
}

export function enrichHotspotsWithNearestLocations(
  hotspots: HotspotCell[],
  cities: ResolvedCity[],
): HotspotCell[] {
  return hotspots.map((hotspot) => ({
    ...hotspot,
    nearestLocation: findNearestResolvedCity(hotspot.lat, hotspot.lon, cities) ?? undefined,
  }));
}

export function getResolvedCitiesPath(): string {
  return path.join(process.cwd(), 'scripts', 'resolved_cities.json');
}

export async function loadResolvedCities(): Promise<ResolvedCity[]> {
  const raw = await fs.readFile(getResolvedCitiesPath(), 'utf8');
  return JSON.parse(raw) as ResolvedCity[];
}
