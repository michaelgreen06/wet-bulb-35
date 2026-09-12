#!/usr/bin/env node
/**
 * Emit the production-generator's collision-safe route identity for packaging probes.
 * This is intentionally a probe-only adapter: prepareCities and getRouteParts remain
 * the sole implementations of slug and collision behavior.
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { getRouteParts, prepareCities } from "./prototype-static-generator.mjs";

export function createRouteIdentityIndex(sourceCities) {
  const prepared = prepareCities(sourceCities.map((city, sourceIndex) => ({
    ...city,
    __probeSourceIndex: sourceIndex,
  })));
  return {
    v: 1,
    collisionGroups: prepared.collisionGroups,
    collisionRows: prepared.collisionRows,
    rows: prepared.cities.map((city) => {
      const { countrySlug, stateSlug, citySlug } = getRouteParts(city);
      return {
        sourceIndex: city.__probeSourceIndex,
        name: city.name,
        resolvedCountryName: city.resolvedCountryName,
        resolvedAdmin1Code: city.resolvedAdmin1Code,
        latitude: city.latitude,
        longitude: city.longitude,
        countrySlug,
        stateSlug,
        outputCitySlug: citySlug,
      };
    }),
  };
}

export function writeRouteIdentityIndex({ source, out }) {
  const started = performance.now();
  const sourceCities = JSON.parse(fs.readFileSync(source, "utf8"));
  const index = createRouteIdentityIndex(sourceCities);
  fs.writeFileSync(out, JSON.stringify(index));
  return {
    sourceRows: sourceCities.length,
    indexedRows: index.rows.length,
    collisionGroups: index.collisionGroups,
    collisionRows: index.collisionRows,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const values = new Map();
  for (const arg of argv) {
    const [key, value] = arg.split("=", 2);
    values.set(key.replace(/^--/, ""), value);
  }
  return values;
}

function main() {
  const args = parseArgs();
  const source = args.get("source");
  const out = args.get("out");
  if (!source || !out) {
    throw new Error("usage: node scripts/probe-location-route-identity.mjs --source=SOURCE --out=OUT");
  }
  console.log(JSON.stringify(writeRouteIdentityIndex({ source: path.resolve(source), out: path.resolve(out) })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
