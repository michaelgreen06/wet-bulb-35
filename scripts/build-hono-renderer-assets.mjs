#!/usr/bin/env node
/** Build public Worker assets plus private renderer metadata shards. */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildHonoBindingAssets } from "./build-hono-binding-assets.mjs";
import { createRouteIdentityIndex } from "./probe-location-route-identity.mjs";
import { validateLegacyRedirectArtifact } from "./generate-legacy-city-route-redirects.mjs";
import { clientRuntimeSource } from "../lib/page-renderer.mjs";

export function buildHonoRendererAssets({ sourceCities, outDir, placesApiKey = "", publicDir = "public", tier1Manifest = null, legacyArtifactPath = "scripts/legacy-city-route-redirects.v1.json" }) {
  const legacyArtifact = legacyArtifactPath
    ? JSON.parse(fs.readFileSync(path.resolve(legacyArtifactPath), "utf8"))
    : null;
  if (legacyArtifact) validateLegacyRedirectArtifact({ artifact: legacyArtifact, currentCities: sourceCities });
  const result = buildHonoBindingAssets({ sourceCities, outDir, tier1Manifest });
  const root = path.resolve(outDir);
  const identity = createRouteIdentityIndex(sourceCities);
  const manifestPath = path.join(root, "locations/route-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const country of manifest.countries) {
    const rows = identity.rows.filter((row) => row.countrySlug === country.countrySlug);
    country.count = rows.length;
    for (const state of country.states) state.count = rows.filter((row) => row.stateSlug === state.slug).length;
  }
  if (legacyArtifact) {
    const legacyShards = new Map();
    for (const entry of legacyArtifact.aliases) {
      const countrySlug = entry[0].split("/")[4];
      if (!legacyShards.has(countrySlug)) legacyShards.set(countrySlug, []);
      legacyShards.get(countrySlug).push(entry);
    }
    const legacyDir = path.join(root, "locations/legacy-shards");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyFiles = [];
    const filenames = new Set();
    for (const [countrySlug, aliases] of [...legacyShards].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const file = `${crypto.createHash("sha256").update(countrySlug).digest("hex").slice(0, 16)}.json`;
      if (filenames.has(file)) throw new Error("Legacy redirect shard filename collision");
      filenames.add(file);
      fs.writeFileSync(path.join(legacyDir, file), JSON.stringify({ v: 1, a: aliases }));
      legacyFiles.push([countrySlug, file]);
    }
    manifest.legacyRedirects = { v: 1, artifactSha256: legacyArtifact.sha256, files: legacyFiles };
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  fs.cpSync(path.resolve(publicDir), root, { recursive: true });
  const assets = path.join(root, "assets");
  fs.mkdirSync(assets, { recursive: true });
  execFileSync(path.resolve("node_modules/.bin/tailwindcss"), ["-i", path.resolve("scripts/static-tailwind.css"), "-o", path.join(assets, "app.css"), "--minify"], { stdio: "pipe" });
  fs.writeFileSync(path.join(assets, "app.js"), clientRuntimeSource({ placesApiKey }));
  fs.writeFileSync(path.join(assets, "locations.json"), JSON.stringify(identity.rows.map((row) => ({
    label: `${row.name}, ${row.resolvedAdmin1Code}, ${row.resolvedCountryName}`,
    url: `/wetbulb-temperature/${row.countrySlug}/${row.stateSlug}/${row.outputCitySlug}/`,
    lat: Number(row.latitude), lon: Number(row.longitude),
  }))));
  return result;
}

function main() {
  const args = new Map(process.argv.slice(2).map((arg) => {
    const [key, value] = arg.split("=", 2); return [key.replace(/^--/, ""), value];
  }));
  const source = args.get("source") ?? "scripts/resolved_cities.json";
  const out = args.get("out") ?? "worker-assets";
  console.log(JSON.stringify(buildHonoRendererAssets({ sourceCities: JSON.parse(fs.readFileSync(source, "utf8")), outDir: out, placesApiKey: process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY ?? "", tier1Manifest: JSON.parse(fs.readFileSync("scripts/tier1-city-manifest.json", "utf8")) })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
