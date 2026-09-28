#!/usr/bin/env node
/**
 * Population sidecar for the frozen city inventory.
 *
 * Matches each scripts/resolved_cities.json row to a pinned GeoNames cities1000.txt
 * snapshot by exact name and coordinates within 1 km (or by geonameid when the row
 * carries one). Routes and inventory rows never change; see docs/roadmap/city-data-pipeline.md
 * for the eventual stable-ID pipeline that supersedes this file.
 *
 * Usage: node scripts/build-city-population.mjs --source=/path/to/cities1000.txt [--out=scripts/city-population.v1.json]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { haversineKm } from "../lib/nearby.mjs";
import { parseArgs } from "../lib/page-renderer.mjs";

export const MATCH_RADIUS_KM = 3;
const CELL_DEG = 0.05;

export function populationKey(city) {
  return `${city.latitude},${city.longitude}`;
}

function cellKey(lat, lon) {
  return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;
}

/** Exact name within 3 km wins; otherwise an alternate name within 3 km; nearest breaks ties. */
export function buildCityPopulation({ geonamesText, cities }) {
  const cells = new Map();
  const byId = new Map();
  let sourceRows = 0;
  for (const line of geonamesText.split("\n")) {
    if (!line) continue;
    const columns = line.split("\t");
    const record = { id: Number(columns[0]), name: columns[1], alternates: columns[3], lat: Number(columns[4]), lon: Number(columns[5]), population: Number(columns[14]) };
    sourceRows += 1;
    byId.set(record.id, record);
    const key = cellKey(record.lat, record.lon);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(record);
  }

  const byCoordinate = {};
  for (const city of cities) {
    const lat = Number(city.latitude);
    const lon = Number(city.longitude);
    let best = city.geonameid ? byId.get(Number(city.geonameid)) : undefined;
    let bestRank = best ? [0, 0] : [Infinity, Infinity];
    const row = Math.floor(lat / CELL_DEG);
    const col = Math.floor(lon / CELL_DEG);
    for (let dr = -1; dr <= 1 && !city.geonameid; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        for (const record of cells.get(`${row + dr}:${col + dc}`) ?? []) {
          const km = haversineKm(lat, lon, record.lat, record.lon);
          if (km > MATCH_RADIUS_KM) continue;
          const tier = record.name === city.name ? 0 : record.alternates.split(",").includes(city.name) ? 1 : null;
          if (tier === null) continue;
          if (tier < bestRank[0] || (tier === bestRank[0] && km < bestRank[1])) { best = record; bestRank = [tier, km]; }
        }
      }
    }
    if (!best || !(best.population > 0)) continue;
    byCoordinate[populationKey(city)] = best.population;
  }
  // Rows sharing identical coordinates share one key, so count keys, not rows.
  return { sourceRows, matched: Object.keys(byCoordinate).length, byCoordinate };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args.get("source");
  if (!source) throw new Error("--source=/path/to/cities1000.txt is required");
  const out = args.get("out") ?? "scripts/city-population.v1.json";
  const geonamesText = fs.readFileSync(source, "utf8");
  const cities = JSON.parse(fs.readFileSync("scripts/resolved_cities.json", "utf8"));
  const { sourceRows, matched, byCoordinate } = buildCityPopulation({ geonamesText, cities });
  const artifact = {
    v: 1,
    source: {
      file: "cities1000.txt",
      url: "https://download.geonames.org/export/dump/cities1000.zip",
      licence: "CC BY 4.0, https://www.geonames.org/",
      sha256: crypto.createHash("sha256").update(geonamesText).digest("hex"),
      rows: sourceRows,
      retrievedAt: args.get("retrievedAt") ?? new Date().toISOString(),
    },
    inventoryRows: cities.length,
    matched,
    byCoordinate,
  };
  fs.writeFileSync(out, `${JSON.stringify(artifact)}\n`);
  console.log(JSON.stringify({ out, inventoryRows: cities.length, matched, unmatched: cities.length - matched }));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
