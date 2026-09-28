/** Nearest-city links for city pages. Deterministic: same input order gives same output. */
import { getRouteParts, routePathForCity } from "./page-renderer.mjs";

export const NEARBY_LIMIT = 8;
export const HUB_RADIUS_KM = 250;
const CELL_DEG = 0.5;
const MAX_RINGS = 8;
const KM_PER_DEG = 111.195;
const RAD = Math.PI / 180;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

function nearbyLabel(city, other) {
  const parts = [other.name];
  if (other.resolvedAdmin1Code !== city.resolvedAdmin1Code) parts.push(other.resolvedAdmin1Code);
  if (other.resolvedCountryName !== city.resolvedCountryName) parts.push(other.resolvedCountryName);
  return parts.join(", ");
}

/** cities need name, resolvedCountryName, resolvedAdmin1Code, latitude, longitude, outputCitySlug. */
export function computeNearby(cities, hubPaths = new Set()) {
  const points = cities.map((city) => ({ city, path: routePathForCity(city), lat: Number(city.latitude), lon: Number(city.longitude) }));
  const cells = new Map();
  for (const point of points) {
    const key = cellKey(cellRow(point.lat), wrapCol(cellCol(point.lon)));
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(point);
  }
  const hubs = points.filter((point) => hubPaths.has(point.path));
  const result = new Map();

  for (const point of points) {
    const row = cellRow(point.lat);
    const col = cellCol(point.lon);
    const seen = new Set([point.path]);
    const found = [];
    for (let ring = 0; ring <= MAX_RINGS; ring += 1) {
      for (let dr = -ring; dr <= ring; dr += 1) {
        for (let dc = -ring; dc <= ring; dc += 1) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          for (const other of cells.get(cellKey(row + dr, wrapCol(col + dc))) ?? []) {
            if (seen.has(other.path)) continue;
            seen.add(other.path);
            found.push({ point: other, km: haversineKm(point.lat, point.lon, other.lat, other.lon) });
          }
        }
      }
      found.sort((a, b) => a.km - b.km || (a.point.path < b.point.path ? -1 : 1));
      found.length = Math.min(found.length, NEARBY_LIMIT);
      // Anything outside the searched window is at least this far away.
      const coverageKm = ring * CELL_DEG * KM_PER_DEG * Math.min(1, Math.cos(point.lat * RAD));
      if (found.length === NEARBY_LIMIT && found[NEARBY_LIMIT - 1].km <= coverageKm) break;
    }

    let hub = null;
    const kept = new Set([point.path, ...found.map((entry) => entry.point.path)]);
    for (const other of hubs) {
      if (kept.has(other.path)) continue;
      const km = haversineKm(point.lat, point.lon, other.lat, other.lon);
      if (km <= HUB_RADIUS_KM && (!hub || km < hub.km)) hub = { point: other, km };
    }
    if (hub) found.push(hub);

    result.set(point.path, found.map(({ point: other, km }) => ({
      path: other.path,
      label: nearbyLabel(point.city, other.city),
      km: Math.round(km),
    })));
  }
  return result;
}

/** Shard form: [countrySlug, stateSlug, citySlug, label, km]; empty slug means same as the linking city. */
export function compactNearby(city, entries) {
  const self = getRouteParts(city);
  return entries.map(({ path, label, km }) => {
    const [countrySlug, stateSlug, citySlug] = path.split("/").slice(2, 5);
    return [countrySlug === self.countrySlug ? "" : countrySlug, stateSlug === self.stateSlug ? "" : stateSlug, citySlug, label, km];
  });
}

export function expandNearby(countrySlug, stateSlug, compact = []) {
  return compact.map(([country, state, citySlug, label, km]) => ({
    path: `/wetbulb-temperature/${country || countrySlug}/${state || stateSlug}/${citySlug}/`,
    label,
    km,
  }));
}

function cellRow(lat) { return Math.floor(lat / CELL_DEG); }
function cellCol(lon) { return Math.floor(lon / CELL_DEG); }
function wrapCol(col) { const cols = Math.round(360 / CELL_DEG); return ((col % cols) + cols) % cols; }
function cellKey(row, col) { return `${row}:${col}`; }
