#!/usr/bin/env node
/** Build public Worker assets plus private renderer metadata shards. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildHonoBindingAssets } from "./build-hono-binding-assets.mjs";
import { createRouteIdentityIndex } from "./probe-location-route-identity.mjs";
import { clientRuntimeSource } from "../lib/page-renderer.mjs";

export function buildHonoRendererAssets({ sourceCities, outDir, placesApiKey = "", publicDir = "public" }) {
  const result = buildHonoBindingAssets({ sourceCities, outDir });
  const root = path.resolve(outDir);
  const identity = createRouteIdentityIndex(sourceCities);
  const manifestPath = path.join(root, "locations/route-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const country of manifest.countries) {
    const rows = identity.rows.filter((row) => row.countrySlug === country.countrySlug);
    country.count = rows.length;
    for (const state of country.states) state.count = rows.filter((row) => row.stateSlug === state.slug).length;
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
  console.log(JSON.stringify(buildHonoRendererAssets({ sourceCities: JSON.parse(fs.readFileSync(source, "utf8")), outDir: out, placesApiKey: process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY ?? "" })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
