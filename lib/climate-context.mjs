/** All-location climate context: Köppen-Geiger class plus optional NASA POWER monthly mean wet bulb. */
import crypto from "node:crypto";
import fs from "node:fs";
import { validCell, validClimateTuple } from "./climate-classes.mjs";

export { KOPPEN_CLASSES, expandClimate } from "./climate-classes.mjs";

export const BECK_ZIP_SHA256 = "bb84453d4541f1a0bc5a804ead83f483c19ce70f16a5197f6d3a7b6a63e65562";
const BECK_RASTER_SHA256 = "2130f0071dfb2904947d8ec3a0d807fac71004df76e769262004f1602e4d6a13";
const BECK_LEGEND_SHA256 = "2ede2ad270a036cc11c31705a2c1dbf0314a8cf011fc972cd4a9665e3339e5e5";
const KOPPEN_REASONS = new Set(["centerNoData", "centerNotModal", "lowModalShare", "outsideRaster"]);
const NASA_REASONS = new Set(["cellEdgeTie", "fillOrInvalidValue"]);

export function inventorySha256(rows) {
  const lines = rows
    .map((row) => [`/wetbulb-temperature/${row.countrySlug}/${row.stateSlug}/${row.outputCitySlug}/`, Number(row.latitude).toFixed(5), Number(row.longitude).toFixed(5)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map((parts) => `${parts.join("\t")}\n`).join("");
  return crypto.createHash("sha256").update(lines).digest("hex");
}

/** Fail closed unless the artifact matches pinned sources and the exact canonical paths and coordinates. */
export function validateClimateContext(artifact, inventoryRows) {
  const beck = artifact?.sources?.beck;
  if (!artifact || artifact.v !== 1 || !beck || beck.sha256 !== BECK_ZIP_SHA256 || beck.rasterSha256 !== BECK_RASTER_SHA256
    || beck.legendSha256 !== BECK_LEGEND_SHA256 || beck.period !== "1991-2020" || beck.method !== "center plus 3x3 modal share"
    || beck.minModalShare !== 0.67 || beck.license !== "CC BY 4.0"
    || !artifact.byPath || typeof artifact.byPath !== "object" || Array.isArray(artifact.byPath) || !Array.isArray(artifact.cells)) {
    throw new Error("Invalid climate-context provenance or schema");
  }
  const nasa = artifact.sources.nasaPower;
  if (nasa !== null && !(nasa && /^\d{4}-\d{2}-\d{2}$/.test(nasa.accessedDate) && /^v2\.\d+\.\d+$/.test(nasa.apiVersion)
    && nasa.parameter === "T2MWET" && nasa.period === "1991-2020" && nasa.timeStandard === "LST" && nasa.grid === "MERRA-2 0.5x0.625 nearest cell"
    && Number.isInteger(nasa.validationSamples) && nasa.validationSamples >= 200 && /^[a-f0-9]{64}$/.test(nasa.sourceLockSha256))) {
    throw new Error("Invalid NASA POWER provenance");
  }
  if (nasa === null && artifact.cells.length) throw new Error("NASA POWER values without provenance");
  if (!artifact.cells.every(validCell)) throw new Error("Invalid NASA POWER cell");
  if (artifact.inventory?.routes !== inventoryRows.length || artifact.inventory?.sha256 !== inventorySha256(inventoryRows)) {
    throw new Error("Climate context was generated from a different canonical inventory");
  }
  const paths = Object.keys(artifact.byPath);
  const canonical = new Set(inventoryRows.map((row) => `/wetbulb-temperature/${row.countrySlug}/${row.stateSlug}/${row.outputCitySlug}/`));
  if (paths.length !== inventoryRows.length || canonical.size !== paths.length || paths.some((path) => !canonical.has(path))) throw new Error("Climate-context route count does not match the canonical inventory");
  const excluded = { koppen: new Set(), nasaPower: new Set() };
  for (const [group, reasons] of Object.entries(artifact.exclusions ?? {})) {
    const allowed = group === "koppen" ? KOPPEN_REASONS : group === "nasaPower" ? NASA_REASONS : null;
    if (!allowed) throw new Error("Unknown climate exclusion group");
    for (const [reason, list] of Object.entries(reasons)) {
      if (!allowed.has(reason) || !Array.isArray(list)) throw new Error("Unknown climate exclusion reason");
      for (const path of list) {
        if (excluded[group].has(path)) throw new Error("Duplicate climate exclusion");
        excluded[group].add(path);
      }
    }
  }
  const usedCells = new Set();
  let koppen = 0, nasaPower = 0;
  for (const path of paths) {
    const tuple = artifact.byPath[path];
    if (!validClimateTuple(tuple, artifact.cells.length)) throw new Error("Invalid climate-context row");
    if ((tuple[0] === null) !== excluded.koppen.has(path)) throw new Error("Köppen exclusions do not match null rows");
    if (nasa !== null && (tuple[1] === null) !== excluded.nasaPower.has(path)) throw new Error("NASA POWER exclusions do not match null rows");
    if (nasa === null && tuple[1] !== null) throw new Error("NASA POWER values without provenance");
    koppen += tuple[0] !== null;
    nasaPower += tuple[1] !== null;
    if (tuple[1] !== null) usedCells.add(tuple[1]);
  }
  if (usedCells.size !== artifact.cells.length) throw new Error("Unused NASA POWER cell");
  if (artifact.counts?.koppen !== koppen || artifact.counts?.nasaPower !== nasaPower || artifact.counts?.routes !== paths.length) {
    throw new Error("Climate-context counts do not match rows");
  }
  return artifact;
}

export function loadClimateContext(file = "data/climate-context.v1.json") {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
