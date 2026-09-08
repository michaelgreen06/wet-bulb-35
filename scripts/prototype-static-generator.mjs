import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_SITE_URL,
  DEFAULT_GA_MEASUREMENT_ID,
  parseArgs,
  toSlug,
  escapeHtml,
  coordinateSuffix,
  getRouteParts,
  routePathForCity,
  renderGoogleAnalyticsScripts,
  prepareCities,
  createSiteData,
  pageHtml,
  renderHomePage,
  renderBrowsePage,
  renderCountryPage,
  renderStatePage,
  clientRuntimeSource,
} from "../lib/page-renderer.mjs";

export {
  DEFAULT_SITE_URL,
  DEFAULT_GA_MEASUREMENT_ID,
  parseArgs,
  toSlug,
  escapeHtml,
  coordinateSuffix,
  getRouteParts,
  routePathForCity,
  renderGoogleAnalyticsScripts,
  prepareCities,
  createSiteData,
  pageHtml,
  renderHomePage,
  renderBrowsePage,
  renderCountryPage,
  renderStatePage,
  clientRuntimeSource,
};

const DEFAULT_OUT_DIR = "/private/tmp/wetbulb-static-prototype";
const DEFAULT_SOURCE_FILE = "scripts/resolved_cities.json";
const PUBLIC_DIR = path.resolve("public");
const STATIC_TAILWIND_INPUT = path.resolve("scripts/static-tailwind.css");

export function buildStaticCss(outDir) {
  const assetDir = path.join(outDir, "assets");
  fs.mkdirSync(assetDir, { recursive: true });
  const tailwindBin = path.resolve("node_modules/.bin/tailwindcss");
  execFileSync(
    tailwindBin,
    ["-i", STATIC_TAILWIND_INPUT, "-o", path.join(assetDir, "app.css"), "--minify"],
    { stdio: "pipe" },
  );
}

export function ensureAssets(outDir, siteData, options = {}) {
  const assetDir = path.join(outDir, "assets");
  fs.mkdirSync(assetDir, { recursive: true });
  buildStaticCss(outDir);
  fs.writeFileSync(path.join(assetDir, "app.js"), clientRuntimeSource({
    placesApiKey: options.placesApiKey,
  }));
  fs.writeFileSync(
    path.join(assetDir, "locations.json"),
    JSON.stringify(siteData.searchIndex),
  );
}

function copyPublicAssets(outDir) {
  if (!fs.existsSync(PUBLIC_DIR)) {
    return;
  }

  fs.cpSync(PUBLIC_DIR, outDir, { recursive: true });
}

function writeHtmlPage(outDir, routePath, html) {
  const targetDir =
    routePath === "/"
      ? outDir
      : path.join(outDir, routePath.replace(/^\/|\/$/g, ""));
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "index.html"), html);
}

export function generateStaticSite(options = {}) {
  const started = performance.now();
  const limit = Number(options.limit ?? 10000);
  const outDir = path.resolve(String(options.outDir ?? DEFAULT_OUT_DIR));
  const siteUrl = options.siteUrl ?? DEFAULT_SITE_URL;
  const sourceFile = path.resolve(String(options.sourceFile ?? DEFAULT_SOURCE_FILE));
  const placesApiKey = options.placesApiKey ?? process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY ?? "";
  const googleAnalyticsId = options.googleAnalyticsId === undefined
    ? (process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || DEFAULT_GA_MEASUREMENT_ID)
    : options.googleAnalyticsId;

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const sourceCities = JSON.parse(fs.readFileSync(sourceFile, "utf8")).slice(0, limit);
  const siteData = createSiteData(sourceCities);

  copyPublicAssets(outDir);
  ensureAssets(outDir, siteData, { placesApiKey });

  writeHtmlPage(outDir, "/", renderHomePage(siteData, { siteUrl, googleAnalyticsId }));
  writeHtmlPage(outDir, "/wetbulb-temperature/", renderBrowsePage(siteData, { siteUrl, googleAnalyticsId }));

  for (const country of siteData.countries) {
    writeHtmlPage(
      outDir,
      `/wetbulb-temperature/${country.slug}/`,
      renderCountryPage(country, { siteUrl, googleAnalyticsId }),
    );
  }

  for (const state of siteData.states) {
    writeHtmlPage(
      outDir,
      `/wetbulb-temperature/${state.countrySlug}/${state.stateSlug}/`,
      renderStatePage(state, { siteUrl, googleAnalyticsId }),
    );
  }

  for (const city of siteData.cities) {
    writeHtmlPage(outDir, routePathForCity(city), pageHtml(city, { siteUrl, googleAnalyticsId }));
  }

  const written = siteData.pageRoutes.size;
  const elapsedSeconds = (performance.now() - started) / 1000;
  return {
    outDir,
    requested: limit,
    written,
    collisionGroups: siteData.collisionGroups,
    collisionRows: siteData.collisionRows,
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    pagesPerSecond: Number((written / elapsedSeconds).toFixed(1)),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = generateStaticSite({
    limit: args.get("limit") ?? 10000,
    outDir: args.get("out") ?? DEFAULT_OUT_DIR,
    siteUrl: args.get("site") ?? DEFAULT_SITE_URL,
    googleAnalyticsId: args.get("ga"),
  });

  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export const STATIC_BOT_PATTERN = /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|applebot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|bytespider|crawler|spider|bot)/i;
