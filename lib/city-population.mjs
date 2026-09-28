/** Node-only loader for scripts/city-population.v1.json (see scripts/build-city-population.mjs). Never import from Worker code. */
import fs from "node:fs";

export function loadCityPopulation(file = "scripts/city-population.v1.json") {
  return JSON.parse(fs.readFileSync(file, "utf8")).byCoordinate;
}
