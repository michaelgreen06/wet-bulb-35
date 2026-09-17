#!/usr/bin/env node
/** Generate the committed, URL-only deterministic GSC control manifest. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { routePathForCity } from "../lib/page-renderer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const resolved = JSON.parse(readFileSync(join(here, "resolved_cities.json"), "utf8"));
const tier = JSON.parse(readFileSync(join(here, "tier1-city-manifest.json"), "utf8"));
const excluded = new Set(tier.cities.filter((city) => city.rank <= 200).map((city) => city.path));
const paths = [...new Set(resolved.map(routePathForCity))]
  .filter((path) => !excluded.has(path))
  .sort((a, b) => createHash("sha256").update(a).digest("hex").localeCompare(createHash("sha256").update(b).digest("hex")) || a.localeCompare(b))
  .slice(0, 200);
if (paths.length !== 200 || new Set(paths).size !== 200) throw new Error("Could not select 200 controls");
const outputPath = join(here, "gsc-control-manifest.json");
const output = `${JSON.stringify({ schemaVersion: 1, selection: "sha256(route) ascending outside tier1 top-200", controls: paths }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(outputPath, "utf8") !== output) throw new Error("Committed GSC controls are stale; regenerate them");
  console.log(`Verified ${paths.length} deterministic URL-only controls.`);
} else {
  writeFileSync(outputPath, output);
  console.log(`Wrote ${paths.length} URL-only controls.`);
}
