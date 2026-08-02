import { toSlug } from '@/lib/utils/string';

const EARTH_RADIUS_KM = 6371;

export type Coordinate = {
  lat: number;
  lon: number;
};

export type WetBulbLocationSlugParts = {
  name: string;
  admin1: string;
  country: string;
};

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function getGoogleMapsSearchUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

export function getHaversineDistanceKm(from: Coordinate, to: Coordinate): number {
  const latDelta = toRadians(to.lat - from.lat);
  const lonDelta = toRadians(to.lon - from.lon);
  const fromLat = toRadians(from.lat);
  const toLat = toRadians(to.lat);

  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(lonDelta / 2) ** 2;

  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function getWetBulbLocationUrl(location: WetBulbLocationSlugParts): string {
  return [
    '/wetbulb-temperature',
    toSlug(location.country),
    toSlug(location.admin1),
    toSlug(location.name),
  ].join('/');
}
