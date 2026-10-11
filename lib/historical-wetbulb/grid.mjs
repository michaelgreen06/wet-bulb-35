/* Worker-safe port of scripts/historical-wetbulb/era5land_grid.py; parity-tested against it. */
const LAT_CELLS = 1801, LON_CELLS = 3600, TIE_TENTHS = 1e-5;
export const HISTORY_BUCKET_DEGREES = 2;

function index(offsetTenths) {
  const below = Math.floor(offsetTenths);
  const tie = Math.abs(offsetTenths - below - 0.5) < TIE_TENTHS;
  return [tie ? below + 1 : Math.floor(offsetTenths + 0.5), tie];
}

/** Nearest ARCO ERA5-Land 0.1° cell; exact half-cell ties take the north/east cell. */
export function mapEra5LandCell(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new TypeError('Invalid route coordinate');
  }
  let [ilat, latTie] = index((latitude + 90) * 10);
  let shifted = (longitude + 179.9) * 10;
  if (shifted < -0.5) shifted += LON_CELLS;
  let [ilon, lonTie] = index(shifted);
  ilon = ((ilon % LON_CELLS) + LON_CELLS) % LON_CELLS;
  ilat = Math.min(Math.max(ilat, 0), LAT_CELLS - 1);
  const cell = [Number((-90 + ilat / 10).toFixed(1)), Number((-179.9 + ilon / 10).toFixed(1))];
  return { cell, gridIndex: [ilat, ilon], tile: [Math.floor(ilat / 4), Math.floor(ilon / 8)], tie: latTie || lonTie };
}

export function historyGroupKey(cell, timeZone) {
  return `${cell[0].toFixed(1)},${cell[1].toFixed(1)}|${timeZone}`;
}

/** Static shard holding this cell's records (2° × 2° geographic bucket). */
export function historyBucketKey(cell) {
  const lat = Math.floor(cell[0] / HISTORY_BUCKET_DEGREES) * HISTORY_BUCKET_DEGREES;
  const lon = Math.floor(cell[1] / HISTORY_BUCKET_DEGREES) * HISTORY_BUCKET_DEGREES;
  return `${lat < 0 ? 's' : 'n'}${Math.abs(lat)}${lon < 0 ? 'w' : 'e'}${Math.abs(lon)}`;
}
