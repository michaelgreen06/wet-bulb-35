#!/usr/bin/env node
/** Build the bounded Worker static-assets candidate using production route identity. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRouteIdentityIndex } from "./probe-location-route-identity.mjs";
import { tier1ByCanonicalPath } from "../lib/page-renderer.mjs";
import { compactNearby, computeNearby } from "../lib/nearby.mjs";
import { cityBucket } from "../lib/location-buckets.mjs";
import { loadCityPopulation } from "../lib/city-population.mjs";
import { loadLocationFacts, validateLocationFacts } from "../lib/location-facts.mjs";
import { loadClimateContext, validateClimateContext } from "../lib/climate-context.mjs";

const GENERATOR_ID = "wetbulb35-hono-assets";
// Cloudflare Workers static assets reject files over 25 MiB; keep headroom.
export const MAX_SHARD_BYTES = 24 * 1024 * 1024;
export const MAX_ASSET_FILES = 20_000;
const CITY_BUCKET_TARGET_ROWS = 48;
const CITY_BUCKET_MAX_ROWS = 96;
function partitionCityRows(rows) {
  if (rows.length <= CITY_BUCKET_MAX_ROWS) return null;
  let count = Math.ceil(rows.length / CITY_BUCKET_TARGET_ROWS);
  for (; count <= rows.length; count++) {
    const buckets = Array.from({ length: count }, () => []);
    for (const row of rows) buckets[cityBucket(row[4], count)].push(row);
    if (buckets.every((bucket) => bucket.length > 0 && bucket.length <= CITY_BUCKET_MAX_ROWS)) return buckets;
  }
  throw new Error('Cannot partition a region into bounded city shards');
}
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

function localClimateTuple(climateContext, route, cells) {
  const [koppen, cell] = climateContext.byPath[route];
  if (cell !== null && !cells.has(cell)) cells.set(cell, cells.size);
  return [koppen, cell === null ? null : cells.get(cell)];
}

function climateSourceSummary(climateContext) {
  const nasa = climateContext.sources.nasaPower;
  return {
    inventorySha256: climateContext.inventory.sha256,
    beckSha256: climateContext.sources.beck.sha256,
    nasaPower: nasa ? { accessedDate: nasa.accessedDate, apiVersion: nasa.apiVersion, sourceLockSha256: nasa.sourceLockSha256 } : null,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  return new Map(argv.map((arg) => {
    const [key, value] = arg.split("=", 2);
    return [key.replace(/^--/, ""), value];
  }));
}

export function buildHonoBindingAssets({ sourceCities, outDir, tier1Manifest = null, population = null, locationFacts = null, climateContext = null }) {
  const root = validateOutputDirectory(outDir);
  const identity = createRouteIdentityIndex(sourceCities);
  if (locationFacts) validateLocationFacts(locationFacts, identity.rows.map((row) => `/wetbulb-temperature/${row.countrySlug}/${row.stateSlug}/${row.outputCitySlug}/`));
  if (climateContext) validateClimateContext(climateContext, identity.rows);
  const tier1 = tier1ByCanonicalPath(tier1Manifest);
  const nearby = computeNearby(identity.rows, { hubPaths: new Set(tier1.keys()), population });
  const resolvedTier1 = new Set();
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
        states: new Map(),
        count: 0,
      });
    }
    const country = countries.get(row.countrySlug);
    if (!country.states.has(row.stateSlug)) {
      country.states.set(row.stateSlug, {
        slug: row.stateSlug,
        name: row.resolvedAdmin1Code,
        file: `${row.countrySlug}/${row.stateSlug}.json`,
        rows: [],
        // Each region shard carries only the NASA POWER cells its rows use.
        cells: new Map(),
      });
    }
    const state = country.states.get(row.stateSlug);
    if (state.name !== row.resolvedAdmin1Code) throw new Error(`Conflicting region identity: ${row.countrySlug}/${row.stateSlug}`);
    const route = `/wetbulb-temperature/${row.countrySlug}/${row.stateSlug}/${row.outputCitySlug}/`;
    if (tier1.has(route)) resolvedTier1.add(route);
    country.count++;
    state.rows.push([
      row.name,
      row.resolvedAdmin1Code,
      row.latitude,
      row.longitude,
      row.outputCitySlug,
      compactNearby(row, nearby.get(route) ?? []),
      ...(locationFacts || climateContext ? [locationFacts ? locationFacts.byPath[route] : null] : []),
      ...(climateContext ? [localClimateTuple(climateContext, route, state.cells)] : []),
    ]);
  }

  for (const country of countries.values()) for (const state of country.states.values()) {
    state.buckets = partitionCityRows(state.rows);
  }
  const manifest = [...countries.values()]
    .sort((a, b) => a.countrySlug.localeCompare(b.countrySlug))
    .map(({ country, countrySlug, count, states }) => ({
      country,
      countrySlug,
      count,
      // Rendered country cards are ordered by display name, not route slug.
      states: [...states.values()].sort((a, b) => a.name.localeCompare(b.name)).map((state) => ({
        slug: state.slug,
        name: state.name,
        file: state.file,
        count: state.rows.length,
        ...(state.buckets ? { buckets: state.buckets.length } : {}),
      })),
    }));
  const regionCount = [...countries.values()].reduce((total, country) => total + country.states.size, 0);
  const bucketCount = [...countries.values()].reduce((total, country) => total + [...country.states.values()].reduce((n, state) => n + (state.buckets?.length ?? 0), 0), 0);
  if (regionCount + bucketCount + 1 > MAX_ASSET_FILES) throw new Error("Region shards exceed the Workers Free static asset file limit");
  if (tier1.size && resolvedTier1.size !== tier1.size) throw new Error("Every Tier-1 manifest path must resolve exactly once from inventory");
  const popularCities = identity.rows
    .map((row) => ({ row, featured: tier1.get(`/wetbulb-temperature/${row.countrySlug}/${row.stateSlug}/${row.outputCitySlug}/`) }))
    .filter(({ featured }) => featured?.popular)
    .sort((a, b) => a.row.name.localeCompare(b.row.name) || a.featured.path.localeCompare(b.featured.path))
    .map(({ row }) => ({ name: row.name, stateName: row.resolvedAdmin1Code, countryName: row.resolvedCountryName, path: `/wetbulb-temperature/${row.countrySlug}/${row.stateSlug}/${row.outputCitySlug}/` }));
  fs.writeFileSync(path.join(locations, "route-manifest.json"), JSON.stringify({
    v: 2, generator: GENERATOR_ID, countries: manifest, popularCities,
    ...(locationFacts ? { factsSource: { snapshot: locationFacts.source.snapshot, sha256: locationFacts.source.sha256 } } : {}),
    ...(climateContext ? { climateSource: climateSourceSummary(climateContext) } : {}),
  }));
  for (const country of countries.values()) for (const state of country.states.values()) {
    const body = JSON.stringify({ v: 2, r: state.rows, ...(climateContext ? { c: [...state.cells.keys()].map((index) => climateContext.cells[index]) } : {}) });
    if (Buffer.byteLength(body) > MAX_SHARD_BYTES) throw new Error(`Region shard exceeds the asset size limit: ${state.file}`);
    const filename = path.join(shards, state.file);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, body);
    if (state.buckets) {
      const sourceCells = [...state.cells.keys()];
      state.buckets.forEach((bucket, index) => {
        const localCells = new Map();
        const rows = bucket.map((row) => {
          if (!climateContext || row[7][1] === null) return row;
          const sourceCell = sourceCells[row[7][1]];
          if (!localCells.has(sourceCell)) localCells.set(sourceCell, localCells.size);
          const copy = [...row];
          copy[7] = [row[7][0], localCells.get(sourceCell)];
          return copy;
        });
        const cityFile = filename.replace(/\.json$/, `.city-${index}.json`);
        const cityBody = JSON.stringify({ v: 2, r: rows,
          ...(climateContext ? { c: [...localCells.keys()].map((cell) => climateContext.cells[cell]) } : {}) });
        if (Buffer.byteLength(cityBody) > MAX_SHARD_BYTES) throw new Error(`City shard exceeds the asset size limit: ${cityFile}`);
        fs.writeFileSync(cityFile, cityBody);
      });
    }
  }
  return {
    files: regionCount + bucketCount + 1,
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
  const tier1Manifest = JSON.parse(fs.readFileSync("scripts/tier1-city-manifest.json", "utf8"));
  console.log(JSON.stringify(buildHonoBindingAssets({ sourceCities, outDir: out, tier1Manifest, population: loadCityPopulation(), locationFacts: loadLocationFacts(), climateContext: loadClimateContext() })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
