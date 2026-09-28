/** Nearest-city links for city pages. Deterministic: same input order gives same output. */
import { getRouteParts, routePathForCity } from "./page-renderer.mjs";

export const NEARBY_LIMIT = 8;
export const HUB_LIMIT = 2;
export const HUB_RADIUS_KM = 150;
export const HUB_MIN_POPULATION = 20000;
const CELL_DEG = 0.5;
const HUB_CELL_DEG = 1;
const HUB_RINGS = 2;
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

function grid(points, cellDeg) {
  const cells = new Map();
  for (const point of points) {
    const key = cellKey(cellIndex(point.lat, cellDeg), wrapCol(cellIndex(point.lon, cellDeg), cellDeg));
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(point);
  }
  return cells;
}

/**
 * cities need name, resolvedCountryName, resolvedAdmin1Code, latitude, longitude, outputCitySlug.
 * population: { "lat,lon": number } from scripts/city-population.v1.json. With it, hubs are cities of
 * at least HUB_MIN_POPULATION ranked by population; without it, hubs are hubPaths (Tier-1) ranked by distance.
 */
export function computeNearby(cities, { hubPaths = new Set(), population = null } = {}) {
  const points = cities.map((city) => ({
    city,
    path: routePathForCity(city),
    lat: Number(city.latitude),
    lon: Number(city.longitude),
    pop: population?.[`${city.latitude},${city.longitude}`] ?? 0,
  }));
  const cells = grid(points, CELL_DEG);
  const hubCells = grid(points.filter((point) => (population ? point.pop >= HUB_MIN_POPULATION : hubPaths.has(point.path))), HUB_CELL_DEG);
  const result = new Map();

  for (const point of points) {
    const row = cellIndex(point.lat, CELL_DEG);
    const col = cellIndex(point.lon, CELL_DEG);
    const seen = new Set([point.path]);
    const found = [];
    for (let ring = 0; ring <= MAX_RINGS; ring += 1) {
      for (let dr = -ring; dr <= ring; dr += 1) {
        for (let dc = -ring; dc <= ring; dc += 1) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          for (const other of cells.get(cellKey(row + dr, wrapCol(col + dc, CELL_DEG))) ?? []) {
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

    const kept = new Set([point.path, ...found.map((entry) => entry.point.path)]);
    const hubs = [];
    const hubRow = cellIndex(point.lat, HUB_CELL_DEG);
    const hubCol = cellIndex(point.lon, HUB_CELL_DEG);
    for (let dr = -HUB_RINGS; dr <= HUB_RINGS; dr += 1) {
      for (let dc = -HUB_RINGS; dc <= HUB_RINGS; dc += 1) {
        for (const other of hubCells.get(cellKey(hubRow + dr, wrapCol(hubCol + dc, HUB_CELL_DEG))) ?? []) {
          if (kept.has(other.path)) continue;
          const km = haversineKm(point.lat, point.lon, other.lat, other.lon);
          if (km <= HUB_RADIUS_KM) hubs.push({ point: other, km });
        }
      }
    }
    hubs.sort((a, b) => b.point.pop - a.point.pop || a.km - b.km || (a.point.path < b.point.path ? -1 : 1));
    found.push(...hubs.slice(0, HUB_LIMIT));

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

function cellIndex(value, cellDeg) { return Math.floor(value / cellDeg); }
function wrapCol(col, cellDeg) { const cols = Math.round(360 / cellDeg); return ((col % cols) + cols) % cols; }
function cellKey(row, col) { return `${row}:${col}`; }
