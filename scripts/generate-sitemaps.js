import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSiteData, routePathForCity } from "../lib/page-renderer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MAX_URLS_PER_SITEMAP = 9_999;
const DEFAULT_BASE_URL = "https://www.wetbulb35.com";
const GENERATED_MEMBER = /^sitemap-(?:main|categories|country-.+)\.xml$/;

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateLastmod(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("SITEMAP_LASTMOD must use YYYY-MM-DD");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("SITEMAP_LASTMOD must use YYYY-MM-DD");
  }
  return value;
}

function xmlUrlset(urls, lastmod) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url>\n    <loc>${url}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`).join("\n")}\n</urlset>\n`;
}

function xmlIndex(urls, lastmod) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <sitemap>\n    <loc>${url}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </sitemap>`).join("\n")}\n</sitemapindex>\n`;
}

function absoluteUrl(baseUrl, route) {
  return `${baseUrl}${route}`;
}

function memberName(countrySlug, part) {
  return `sitemap-country-${countrySlug}${part === 1 ? "" : `-${part}`}.xml`;
}

function cleanStaleMembers(sitemapsDir, expected) {
  if (!fs.existsSync(sitemapsDir)) return;
  for (const name of fs.readdirSync(sitemapsDir)) {
    const target = path.join(sitemapsDir, name);
    if (GENERATED_MEMBER.test(name) && !expected.has(name) && fs.statSync(target).isFile()) {
      fs.unlinkSync(target);
    }
  }
}

/** Generate the complete sitemap tree from the renderer's canonical route identity. */
export function generateSitemaps({
  dataPath = path.join(__dirname, "resolved_cities.json"),
  tier1ManifestPath = null,
  outputDir = path.join(__dirname, "..", "public"),
  baseUrl = process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_BASE_URL,
  lastmod = process.env.SITEMAP_LASTMOD || new Date().toISOString().slice(0, 10),
} = {}) {
  const normalizedLastmod = validateLastmod(lastmod);
  const normalizedBaseUrl = String(baseUrl).replace(/\/$/, "");
  const sourceCities = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const tier1Manifest = tier1ManifestPath ? JSON.parse(fs.readFileSync(tier1ManifestPath, "utf8")) : null;
  const site = createSiteData(sourceCities, tier1Manifest);
  const sitemapsDir = path.join(outputDir, "sitemaps");
  fs.mkdirSync(sitemapsDir, { recursive: true });

  const countries = new Map();
  for (const city of site.cities) {
    const route = routePathForCity(city);
    const countrySlug = route.split("/")[2];
    if (!countries.has(countrySlug)) countries.set(countrySlug, []);
    countries.get(countrySlug).push(route);
  }

  const members = new Map();
  members.set("sitemap-main.xml", ["/", "/wetbulb-temperature/"]);
  members.set(
    "sitemap-categories.xml",
    [...site.pageRoutes].filter((route) => !site.cityRoutes.has(route) && route !== "/" && route !== "/wetbulb-temperature/").sort(compare),
  );

  for (const [countrySlug, routes] of [...countries.entries()].sort(([a], [b]) => compare(a, b))) {
    routes.sort(compare);
    for (let start = 0, part = 1; start < routes.length; start += MAX_URLS_PER_SITEMAP, part += 1) {
      members.set(memberName(countrySlug, part), routes.slice(start, start + MAX_URLS_PER_SITEMAP));
    }
  }

  const expectedMembers = new Set(members.keys());
  cleanStaleMembers(sitemapsDir, expectedMembers);
  for (const [name, routes] of members) {
    fs.writeFileSync(path.join(sitemapsDir, name), xmlUrlset(routes.map((route) => absoluteUrl(normalizedBaseUrl, route)), normalizedLastmod));
  }

  const indexMembers = [...members.keys()];
  fs.writeFileSync(
    path.join(outputDir, "sitemap.xml"),
    xmlIndex(indexMembers.map((name) => `${normalizedBaseUrl}/sitemaps/${name}`), normalizedLastmod),
  );

  return {
    cityCount: site.cityRoutes.size,
    nonCityCount: site.pageRoutes.size - site.cityRoutes.size,
    memberCount: members.size,
    members: indexMembers,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = generateSitemaps({ tier1ManifestPath: path.join(__dirname, "tier1-city-manifest.json") });
    console.log(`Generated ${result.memberCount} sitemap members for ${result.cityCount} canonical city routes.`);
  } catch (error) {
    console.error(`Sitemap generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
