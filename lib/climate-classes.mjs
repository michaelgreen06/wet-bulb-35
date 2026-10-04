/** Worker-safe climate-context helpers shared by the asset build, renderer and Worker. */

/** Beck et al. v3 legend values 1-30, with the labels already reviewed for the Popular-40 pilot. */
export const KOPPEN_CLASSES = [null,
  ["Af", "Tropical rainforest"], ["Am", "Tropical monsoon"], ["Aw", "Tropical savanna"],
  ["BWh", "Hot desert"], ["BWk", "Cold desert"], ["BSh", "Hot steppe"], ["BSk", "Cold steppe"],
  ["Csa", "Temperate, dry summer, hot summer"], ["Csb", "Temperate, dry summer, warm summer"],
  ["Csc", "Temperate, dry summer, cold summer"], ["Cwa", "Temperate, dry winter, hot summer"],
  ["Cwb", "Temperate, dry winter, warm summer"], ["Cwc", "Temperate, dry winter, cold summer"],
  ["Cfa", "Temperate, no dry season, hot summer"], ["Cfb", "Temperate, no dry season, warm summer"],
  ["Cfc", "Temperate, no dry season, cold summer"], ["Dsa", "Cold, dry summer, hot summer"],
  ["Dsb", "Cold, dry summer, warm summer"], ["Dsc", "Cold, dry summer, cold summer"],
  ["Dsd", "Cold, dry summer, very cold winter"], ["Dwa", "Cold, dry winter, hot summer"],
  ["Dwb", "Cold, dry winter, warm summer"], ["Dwc", "Cold, dry winter, cold summer"],
  ["Dwd", "Cold, dry winter, very cold winter"], ["Dfa", "Cold, no dry season, hot summer"],
  ["Dfb", "Cold, no dry season, warm summer"], ["Dfc", "Cold, no dry season, cold summer"],
  ["Dfd", "Cold, no dry season, very cold winter"], ["ET", "Polar tundra"], ["EF", "Polar frost"],
];

export function validCell(cell) {
  return Array.isArray(cell) && cell.length === 13
    && cell.slice(0, 12).every((tenths) => Number.isInteger(tenths) && tenths >= -1000 && tenths <= 600)
    && Number.isInteger(cell[12]) && cell[12] > 0 && cell[12] < 4096
    && cell.slice(0, 12).every((tenths, index) => !(cell[12] & (1 << index)) || tenths === Math.max(...cell.slice(0, 12)));
}

export function validClimateTuple(tuple, cellCount) {
  return Array.isArray(tuple) && tuple.length === 2
    && (tuple[0] === null || (Number.isInteger(tuple[0]) && tuple[0] >= 1 && tuple[0] <= 30))
    && (tuple[1] === null || (Number.isInteger(tuple[1]) && tuple[1] >= 0 && tuple[1] < cellCount));
}

/** Expand a compact tuple and cell table into render-ready values. */
export function expandClimate(tuple, cells) {
  if (!Array.isArray(tuple)) return null;
  const [koppen, cellIndex] = tuple;
  const cell = cellIndex === null ? null : cells?.[cellIndex];
  const climate = {
    koppen: koppen === null ? null : { code: KOPPEN_CLASSES[koppen][0], label: KOPPEN_CLASSES[koppen][1] },
    nasaPower: cell ? {
      monthlyC: cell.slice(0, 12).map((tenths) => tenths / 10),
      peakMonths: cell.slice(0, 12).flatMap((_, index) => (cell[12] & (1 << index) ? [index + 1] : [])),
    } : null,
  };
  return climate.koppen || climate.nasaPower ? climate : null;
}

/** Per-shard memoized expansion: routes sharing a class and NASA cell share one frozen, read-only object. */
export function createClimateExpander(cells) {
  const expanded = new Map();
  return (tuple) => {
    if (!Array.isArray(tuple)) return null;
    const key = `${tuple[0]}:${tuple[1]}`;
    if (!expanded.has(key)) {
      const climate = expandClimate(tuple, cells);
      if (climate) {
        Object.freeze(climate.koppen);
        if (climate.nasaPower) { Object.freeze(climate.nasaPower.monthlyC); Object.freeze(climate.nasaPower.peakMonths); Object.freeze(climate.nasaPower); }
        Object.freeze(climate);
      }
      expanded.set(key, climate);
    }
    return expanded.get(key);
  };
}
