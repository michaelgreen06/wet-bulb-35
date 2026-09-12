#!/usr/bin/env node
/** Generate immutable renderer hashes from the pre-extraction review bundle. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REVIEW_BUNDLE_COMMIT = "ea7d0da";
const ORDERING_SENSITIVE_COUNTRIES = [
  "algeria", "azerbaijan", "cambodia", "malta", "mayotte", "mongolia",
  "qatar", "saudi-arabia", "tonga", "turkey", "yemen",
];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "tests/fixtures/hono-renderer-goldens.json");
const options = {
  siteUrl: "https://www.wetbulb35.com",
  googleAnalyticsId: "G-LNPWV0JL7S",
};

export function normalizeHtml(html) {
  return html.replace(/© \d{4} Wet Bulb Temperature Monitor/g, "© <YEAR> Wet Bulb Temperature Monitor");
}

export function normalizedSha256(html) {
  return crypto.createHash("sha256").update(normalizeHtml(html)).digest("hex");
}

async function loadOriginalGenerator() {
  const source = execFileSync("git", ["show", `${REVIEW_BUNDLE_COMMIT}:scripts/prototype-static-generator.mjs`], {
    cwd: root,
    encoding: "utf8",
  });
  const temporary = fs.mkdtempSync(path.join(root, "scripts/.golden-generator-"));
  const modulePath = path.join(temporary, "prototype-static-generator.mjs");
  fs.writeFileSync(modulePath, source);
  try {
    return await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export async function generateGoldens() {
  const generator = await loadOriginalGenerator();
  const cities = JSON.parse(fs.readFileSync(path.join(root, "scripts/resolved_cities.json"), "utf8"));
  const siteData = generator.createSiteData(cities);
  const pages = [];
  const add = (type, route, html) => pages.push({ type, route, sha256: normalizedSha256(html) });
  add("home", "/", generator.renderHomePage(siteData, options));
  add("browse", "/wetbulb-temperature/", generator.renderBrowsePage(siteData, options));
  for (const slug of ORDERING_SENSITIVE_COUNTRIES) {
    const country = siteData.countries.find((item) => item.slug === slug);
    if (!country) throw new Error(`Missing ordering-sensitive country: ${slug}`);
    add("country-ordering-sensitive", `/wetbulb-temperature/${slug}/`, generator.renderCountryPage(country, options));
  }
  const state = siteData.states.find((item) => item.cities.length > 0);
  const city = state?.cities[0];
  if (!state || !city) throw new Error("Missing representative state/city");
  add("state", `/wetbulb-temperature/${state.countrySlug}/${state.stateSlug}/`, generator.renderStatePage(state, options));
  add("city", generator.routePathForCity(city), generator.pageHtml(city, options));
  return {
    schemaVersion: 1,
    provenance: {
      generatorCommit: REVIEW_BUNDLE_COMMIT,
      generatorPath: "scripts/prototype-static-generator.mjs",
      sourceCitiesPath: "scripts/resolved_cities.json",
      normalization: "Only the dynamic footer year is replaced with <YEAR> before SHA-256.",
      generatedBy: "scripts/generate-hono-renderer-goldens.mjs",
    },
    pages,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const goldens = await generateGoldens();
  fs.writeFileSync(output, `${JSON.stringify(goldens, null, 2)}\n`);
  console.log(`wrote ${goldens.pages.length} golden hashes to ${path.relative(root, output)}`);
}
