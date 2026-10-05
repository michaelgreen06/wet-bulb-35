#!/usr/bin/env node
/** Build the compact, route-safe city manifest used by hotspot refinement. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRouteIdentityIndex } from "./probe-location-route-identity.mjs";

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateManifestRecord(record) {
  if (!record || typeof record !== "object"
    || typeof record.path !== "string"
    || !/^\/wetbulb-temperature\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(record.path)
    || typeof record.name !== "string" || record.name.length === 0
    || typeof record.state !== "string" || record.state.length === 0
    || typeof record.country !== "string" || record.country.length === 0
    || !isFiniteNumber(record.latitude) || record.latitude < -90 || record.latitude > 90
    || !isFiniteNumber(record.longitude) || record.longitude < -180 || record.longitude > 180) {
    throw new TypeError("Hotspot city manifest record has invalid route identity or coordinates.");
  }
}

export function buildHotspotCityManifest(sourceCities) {
  if (!Array.isArray(sourceCities)) throw new TypeError("Hotspot city source must be an array.");
  const identity = createRouteIdentityIndex(sourceCities);
  if (identity.rows.length !== sourceCities.length) {
    throw new TypeError("Hotspot route identity index did not preserve every source city.");
  }

  const manifest = identity.rows.map((row) => {
    const record = {
      path: `/wetbulb-temperature/${row.countrySlug}/${row.stateSlug}/${row.outputCitySlug}/`,
      name: row.name,
      state: row.resolvedAdmin1Code,
      country: row.resolvedCountryName,
      latitude: row.latitude,
      longitude: row.longitude,
    };
    validateManifestRecord(record);
    return record;
  });

  const paths = new Set(manifest.map((record) => record.path));
  if (paths.size !== manifest.length) throw new TypeError("Hotspot city manifest contains duplicate canonical paths.");
  return manifest;
}

export function writeHotspotCityManifest({ source, out }) {
  const sourceCities = JSON.parse(fs.readFileSync(source, "utf8"));
  const manifest = buildHotspotCityManifest(sourceCities);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(manifest)}\n`);
  return { sourceRows: sourceCities.length, manifestRows: manifest.length };
}

function parseArgs(argv = process.argv.slice(2)) {
  const values = new Map();
  for (const argument of argv) {
    const [key, value] = argument.split("=", 2);
    values.set(key.replace(/^--/, ""), value);
  }
  return values;
}

function main() {
  const args = parseArgs();
  const source = args.get("source");
  const out = args.get("out");
  if (!source || !out) {
    throw new Error("usage: node scripts/build-hotspot-city-manifest.mjs --source=SOURCE --out=OUT");
  }
  console.log(JSON.stringify(writeHotspotCityManifest({ source: path.resolve(source), out: path.resolve(out) })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
