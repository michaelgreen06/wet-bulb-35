#!/usr/bin/env node
/** Build the bounded Worker static-assets candidate using production route identity. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRouteIdentityIndex } from "./probe-location-route-identity.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  return new Map(argv.map((arg) => {
    const [key, value] = arg.split("=", 2);
    return [key.replace(/^--/, ""), value];
  }));
}

export function buildHonoBindingAssets({ sourceCities, outDir }) {
  const identity = createRouteIdentityIndex(sourceCities);
  const root = path.resolve(outDir);
  const locations = path.join(root, "locations");
  const shards = path.join(locations, "shards");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(shards, { recursive: true });

  const countries = new Map();
  for (const row of identity.rows) {
    if (!countries.has(row.countrySlug)) {
      countries.set(row.countrySlug, {
        country: row.resolvedCountryName,
        countrySlug: row.countrySlug,
        file: `${row.countrySlug}.json`,
        states: new Map(),
        rows: [],
      });
    }
    const country = countries.get(row.countrySlug);
    country.states.set(row.stateSlug, row.resolvedAdmin1Code);
    country.rows.push([
      row.name,
      row.resolvedAdmin1Code,
      row.latitude,
      row.longitude,
      row.outputCitySlug,
    ]);
  }

  const manifest = [...countries.values()]
    .sort((a, b) => a.countrySlug.localeCompare(b.countrySlug))
    .map(({ country, countrySlug, file, states }) => ({
      country,
      countrySlug,
      file,
      count: countries.get(countrySlug).rows.length,
      // Rendered country cards are ordered by display name, not route slug.
      states: [...states].sort(([, a], [, b]) => a.localeCompare(b)).map(([slug, name]) => ({
        slug,
        name,
        count: countries.get(countrySlug).rows.filter((row) => row[1] === name).length,
      })),
    }));
  fs.writeFileSync(path.join(locations, "route-manifest.json"), JSON.stringify({ v: 1, countries: manifest }));
  for (const country of countries.values()) {
    fs.writeFileSync(
      path.join(shards, country.file),
      JSON.stringify({ v: 1, r: country.rows }),
    );
  }
  return {
    files: manifest.length + 1,
    countries: manifest.length,
    rows: identity.rows.length,
    collisionGroups: identity.collisionGroups,
    collisionRows: identity.collisionRows,
  };
}

function main() {
  const args = parseArgs();
  const source = args.get("source") ?? "scripts/resolved_cities.json";
  const out = args.get("out") ?? "worker-assets";
  const sourceCities = JSON.parse(fs.readFileSync(source, "utf8"));
  console.log(JSON.stringify(buildHonoBindingAssets({ sourceCities, outDir: out })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
