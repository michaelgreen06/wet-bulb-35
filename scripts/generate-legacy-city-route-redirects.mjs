#!/usr/bin/env node
/** Generate and validate the immutable legacy city-route redirect registry. */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import slugify from "slugify";
import { createRouteIdentityIndex } from "./probe-location-route-identity.mjs";

export const LEGACY_REDIRECT_SCHEMA = 1;
export const HISTORICAL_COMMIT = "b83b6f33d3a1b2bb00551af3bd2f916c276c90c9";
export const HISTORICAL_INVENTORY_SHA256 = "d2b4f82c613f6c8318f8087a47099833341be535c896b62003fc13f414e6c1d9";
export const HISTORICAL_SLUG_SOURCE_SHA256 = "5a67292f048e867d59eb1a17bac455aedbc2958c2bc4926358c2a47ec936ce98";
// Updated only as part of an explicitly reviewed redirect migration.
export const EXPECTED_ARTIFACT_SHA256 = "613ff36abffd5f284be5a821664391fe4c2eb3474fac87ad5079eff2af0fac00";
export const EXPECTED_COUNTS = Object.freeze({ historicalRows: 130684, historicalUniquePaths: 129089, invalidPaths: 1, collisionGroups: 1419, overlapPaths: 8, aliases: 129080 });
const PREFIX = "/wetbulb-temperature/";
const SHA256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const stableJson = (value) => JSON.stringify(value);
const asciiCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function historicalSlug(value) {
  const input = String(value ?? "");
  const nonLatin = /[\u0600-\u06FF\u0750-\u077F\u1100-\u11FF\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\u0400-\u04FF\u0E00-\u0E7F\u0900-\u097F]/;
  const parts = input.split(/[,\(\)\[\]\{\}\s]+/);
  if (nonLatin.test(input)) {
    let best = []; let run = [];
    for (const part of parts) {
      if (!part.trim()) continue;
      if (!nonLatin.test(part)) run.push(part);
      else { if (run.length > best.length) best = run; run = []; }
    }
    if (run.length > best.length) best = run;
    if (best.length) return slugify(best.join(" "), { lower: true, strict: true, locale: "en", trim: true });
  }
  return slugify(input, { lower: true, strict: true, locale: "en", trim: true });
}
function oldPath(city) { return `${PREFIX}${historicalSlug(city.name)}/${historicalSlug(city.resolvedAdmin1Code)}/${historicalSlug(city.resolvedCountryName)}`; }
function destination(row) { return `${PREFIX}${row.countrySlug}/${row.stateSlug}/${row.outputCitySlug}/`; }
function sourceIdentity(city) { return [city.name, city.resolvedCountryName, city.resolvedAdmin1Code, Number(city.latitude), Number(city.longitude)]; }
function sameSource(a, b) { return stableJson(sourceIdentity(a)) === stableJson(sourceIdentity(b)); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function expected(counts) { return Object.entries(EXPECTED_COUNTS).every(([key, value]) => counts[key] === value); }

export function createLegacyRedirectArtifact({ historicalCities, currentCities, historicalCommit = HISTORICAL_COMMIT,
  historicalInventoryRawSha256 = HISTORICAL_INVENTORY_SHA256, historicalSlugSourceSha256 = HISTORICAL_SLUG_SOURCE_SHA256 }) {
  assert(Array.isArray(historicalCities) && Array.isArray(currentCities), "Historical and current city inventories are required");
  const current = createRouteIdentityIndex(currentCities);
  const currentRouteByIndex = new Map(current.rows.map((row) => [row.sourceIndex, row]));
  const currentBySource = new Map();
  currentCities.forEach((city, index) => {
    const key = stableJson(sourceIdentity(city));
    const matches = currentBySource.get(key) || [];
    matches.push(index);
    currentBySource.set(key, matches);
  });
  const currentRoutes = new Set(current.rows.map(destination));
  const winners = new Map();
  const invalidPaths = new Set();
  const collisionPaths = new Set();
  for (const city of historicalCities) {
    const alias = oldPath(city);
    if (!/^\/wetbulb-temperature\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(alias)) {
      invalidPaths.add(alias);
      continue;
    }
    if (winners.has(alias)) collisionPaths.add(alias);
    else winners.set(alias, city);
  }
  const mappings = [];
  for (const [alias, city] of winners) {
    const matches = currentBySource.get(stableJson(sourceIdentity(city))) || [];
    assert(matches.length === 1, `Historical winner no longer maps uniquely to current inventory: ${alias}`);
    const index = matches[0];
    const currentCity = currentCities[index];
    assert(currentCity && sameSource(city, currentCity), `Historical winner no longer maps to current inventory: ${alias}`);
    const row = currentRouteByIndex.get(index);
    assert(row, `Current route missing for historical winner at row ${index}`);
    const target = destination(row);
    assert(currentRoutes.has(target), `Destination missing for ${alias}`);
    mappings.push([alias, target]);
  }
  mappings.sort(([a], [b]) => asciiCompare(a, b));
  const currentPaths = new Set(current.rows.map(destination));
  const overlaps = mappings.filter(([alias]) => currentPaths.has(`${alias}/`));
  const aliases = mappings.filter(([alias]) => !currentPaths.has(`${alias}/`));
  const collisionWinners = mappings.filter(([alias]) => collisionPaths.has(alias));
  const counts = { historicalRows: historicalCities.length, historicalUniquePaths: winners.size + invalidPaths.size,
    invalidPaths: invalidPaths.size, collisionGroups: collisionPaths.size, overlapPaths: overlaps.length, aliases: aliases.length };
  const artifact = {
    v: LEGACY_REDIRECT_SCHEMA,
    kind: "wetbulb35-legacy-city-route-redirects",
    provenance: {
      historicalCommit,
      historicalPath: "scripts/resolved_cities.json",
      historicalToSlug: "lib/utils/string.ts",
      historicalInventoryRawSha256,
      historicalSlugSourceSha256,
      normalizedHistoricalInventorySha256: SHA256(stableJson(historicalCities)),
    },
    counts,
    aliases,
    overlaps,
    invalidPaths: [...invalidPaths].sort(),
    collisionWinners,
  };
  artifact.sha256 = SHA256(stableJson({ ...artifact }));
  return artifact;
}

export function validateLegacyRedirectArtifact({ artifact, currentCities }) {
  assert(artifact && artifact.v === LEGACY_REDIRECT_SCHEMA && artifact.kind === "wetbulb35-legacy-city-route-redirects", "Unsupported legacy redirect artifact schema");
  assert(artifact.provenance?.historicalCommit === HISTORICAL_COMMIT, "Unexpected historical redirect provenance");
  assert(artifact.provenance?.historicalInventoryRawSha256 === HISTORICAL_INVENTORY_SHA256, "Unexpected historical inventory checksum");
  assert(artifact.provenance?.historicalSlugSourceSha256 === HISTORICAL_SLUG_SOURCE_SHA256, "Unexpected historical slug-source checksum");
  assert(Array.isArray(artifact.aliases) && Array.isArray(artifact.overlaps) && Array.isArray(artifact.invalidPaths) && Array.isArray(artifact.collisionWinners), "Malformed legacy redirect registry");
  assert(expected(artifact.counts || {}), "Legacy redirect counts changed; explicit migration required");
  const unsigned = { ...artifact }; delete unsigned.sha256;
  assert(artifact.sha256 === SHA256(stableJson(unsigned)), "Legacy redirect artifact checksum mismatch");
  assert(artifact.sha256 === EXPECTED_ARTIFACT_SHA256, "Legacy redirect artifact changed; explicit migration review required");
  const all = [...artifact.aliases, ...artifact.overlaps];
  assert(all.length + artifact.invalidPaths.length === artifact.counts.historicalUniquePaths, "Legacy redirect winner count mismatch");
  assert(artifact.invalidPaths.length === artifact.counts.invalidPaths
    && artifact.invalidPaths.every((value) => typeof value === "string" && !/^\/wetbulb-temperature\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(value)), "Legacy invalid-path accounting mismatch");
  const aliasSet = new Set();
  const destinationFailures = []; const currentConflicts = []; const collisionWinnerFailures = [];
  const current = createRouteIdentityIndex(currentCities);
  const currentPaths = new Set(current.rows.map(destination));
  for (const entry of all) {
    assert(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string", "Malformed legacy redirect entry");
    const [alias, target] = entry;
    assert(/^\/wetbulb-temperature\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(alias), `Unsafe legacy alias: ${alias}`);
    assert(/^\/wetbulb-temperature\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(target), `Unsafe legacy target: ${target}`);
    assert(!aliasSet.has(alias), `Duplicate legacy alias: ${alias}`); aliasSet.add(alias);
    if (!currentPaths.has(target)) destinationFailures.push(target);
  }
  for (const [alias] of artifact.aliases) if (currentPaths.has(`${alias}/`)) currentConflicts.push(alias);
  const allMap = new Map(all);
  assert(artifact.collisionWinners.length === artifact.counts.collisionGroups, "Legacy collision winner count mismatch");
  for (const [alias, target] of artifact.collisionWinners) if (allMap.get(alias) !== target) collisionWinnerFailures.push(alias);
  assert(!destinationFailures.length, "A legacy redirect destination no longer exists; explicit migration required");
  assert(!currentConflicts.length, "A legacy alias now conflicts with a current route; explicit migration required");
  assert(!collisionWinnerFailures.length, "Legacy collision winner mismatch");
  return { counts: artifact.counts, destinationFailures, currentConflicts, collisionWinnerFailures };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const historicalRaw = execFileSync("git", ["show", `${HISTORICAL_COMMIT}:scripts/resolved_cities.json`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const historicalSlugSource = execFileSync("git", ["show", `${HISTORICAL_COMMIT}:lib/utils/string.ts`], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 });
  assert(SHA256(historicalRaw) === HISTORICAL_INVENTORY_SHA256, "Historical inventory bytes changed");
  assert(SHA256(historicalSlugSource) === HISTORICAL_SLUG_SOURCE_SHA256, "Historical slug source changed");
  const historical = JSON.parse(historicalRaw);
  const current = JSON.parse(fs.readFileSync(path.join(root, "scripts/resolved_cities.json"), "utf8"));
  const artifact = createLegacyRedirectArtifact({ historicalCities: historical, currentCities: current,
    historicalInventoryRawSha256: SHA256(historicalRaw), historicalSlugSourceSha256: SHA256(historicalSlugSource) });
  assert(expected(artifact.counts), "Unexpected historical redirect counts");
  const out = process.env.LEGACY_REDIRECT_ARTIFACT || path.join(root, "scripts/legacy-city-route-redirects.v1.json");
  fs.writeFileSync(out, `${stableJson(artifact)}\n`);
  console.log(JSON.stringify({ out, counts: artifact.counts, sha256: artifact.sha256 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
