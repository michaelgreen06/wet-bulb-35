#!/usr/bin/env node
/** Build the bounded Worker static-assets candidate using production route identity. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRouteIdentityIndex } from "./probe-location-route-identity.mjs";

const GENERATOR_ID = "wetbulb35-hono-assets";
const REPOSITORY_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

function realOutputPath(target) {
  // Resolve existing ancestors too, so a symlink cannot hide a protected path.
  if (fs.existsSync(target)) return fs.realpathSync(target);
  if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Refusing dangling output symlink");
  return path.join(realOutputPath(path.dirname(target)), path.basename(target));
}

export function validateOutputDirectory(outDir) {
  if (typeof outDir !== "string" || !outDir.trim()) throw new Error("An output directory is required");
  const root = realOutputPath(path.resolve(outDir));
  const contains = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
  if (root === path.parse(root).root || [REPOSITORY_ROOT, fs.realpathSync(os.homedir())].some((protectedPath) => contains(root, protectedPath))) {
    throw new Error("Refusing to replace a protected output directory");
  }
  if (fs.existsSync(root)) {
    if (!fs.statSync(root).isDirectory()) throw new Error("Output must be a directory");
    if (fs.readdirSync(root).length) {
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(path.join(root, "locations/route-manifest.json"), "utf8")); } catch {}
      if (manifest?.generator !== GENERATOR_ID) throw new Error("Refusing to replace a nonempty directory not owned by the asset builder; choose a new output directory");
    }
  }
  return root;
}

function parseArgs(argv = process.argv.slice(2)) {
  return new Map(argv.map((arg) => {
    const [key, value] = arg.split("=", 2);
    return [key.replace(/^--/, ""), value];
  }));
}

export function buildHonoBindingAssets({ sourceCities, outDir }) {
  const root = validateOutputDirectory(outDir);
  const identity = createRouteIdentityIndex(sourceCities);
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
  fs.writeFileSync(path.join(locations, "route-manifest.json"), JSON.stringify({ v: 1, generator: GENERATOR_ID, countries: manifest }));
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
