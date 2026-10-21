#!/usr/bin/env node
/** Reviewable Cloudflare zone rule candidates; this script NEVER applies them. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRouteIdentityIndex } from "./probe-location-route-identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "/wetbulb-temperature/";
const HOST = "www.wetbulb35.com";
// High-volume countries with no historical city alias beginning with their slug.
// The exhaustive check below fails closed if the inventory or aliases change.
export const EDGE_COUNTRIES = Object.freeze([
  "germany", "united-kingdom", "romania", "russia", "france", "czechia",
  "netherlands", "austria", "united-states", "switzerland", "hungary",
  "ireland", "ukraine", "new-zealand", "tunisia", "philippines", "latvia", "bolivia",
]);

export function edgeRedirectTarget(pathname, method = "GET") {
  if (!["GET", "HEAD"].includes(method) || !pathname.startsWith(PREFIX) || pathname.endsWith("/") || pathname.includes("//")) return null;
  const country = pathname.slice(PREFIX.length).split("/")[0];
  if (!EDGE_COUNTRIES.includes(country) || !pathname.startsWith(`${PREFIX}${country}/`)) return null;
  return `${pathname}/`;
}

export function buildEdgePolicy({ cities, artifact }) {
  if (!Array.isArray(cities) || !artifact || artifact.v !== 1 || !Array.isArray(artifact.aliases) || !Array.isArray(artifact.overlaps)) {
    throw new Error("Current city inventory and validated legacy alias artifact are required");
  }
  const identity = createRouteIdentityIndex(cities);
  const countrySlugs = new Set(identity.rows.map((row) => row.countrySlug));
  const legacySources = [...artifact.aliases, ...artifact.overlaps].map(([source]) => source);
  for (const country of EDGE_COUNTRIES) {
    if (!countrySlugs.has(country)) throw new Error(`Unknown current country slug: ${country}`);
    if (legacySources.some((source) => edgeRedirectTarget(source))) throw new Error(`Legacy alias would be hijacked: ${country}`);
  }
  const countryExpression = EDGE_COUNTRIES.map((slug) => `starts_with(http.request.uri.path, "${PREFIX}${slug}/")`).join(" or ");
  const expression = `http.host eq "${HOST}" and http.request.method in {"GET" "HEAD"} and not (lower(http.user_agent) contains "shapbot") and not ends_with(http.request.uri.path, "/") and not (http.request.uri.path contains "//") and (${countryExpression})`;
  if (expression.length > 4096) throw new Error("Cloudflare expression exceeds 4,096-character limit");
  const canonicalRoutes = identity.rows.filter((row) => EDGE_COUNTRIES.includes(row.countrySlug)).length;
  return {
    base: "origin/main; unmerged candidate, not installed",
    analysis: { currentRoutes: identity.rows.length, eligibleCityRoutes: canonicalRoutes, countryCount: EDGE_COUNTRIES.length, legacySources: legacySources.length },
    wafCustomRules: [
      {
        ref: "block_shapbot_wetbulb35",
        description: "Block self-identified ShapBot before either WetBulb35 Worker, including unverified copies; verified search engines are excluded",
        expression: '(http.host in {"wetbulb35.com" "www.wetbulb35.com"} and lower(http.user_agent) contains "shapbot" and (not cf.client.bot or cf.verified_bot_category ne "Search Engine Crawler"))',
        action: "block",
      },
      {
        ref: "exempt_verified_search_from_crawler_rate_limit",
        description: "Skip only rate limiting for Cloudflare-verified search-engine crawlers; do not skip WAF protections",
        expression: '(http.host in {"wetbulb35.com" "www.wetbulb35.com"} and cf.verified_bot_category eq "Search Engine Crawler")',
        action: "skip",
        action_parameters: { phases: ["http_ratelimit"] },
      },
    ],
    singleRedirectRule: {
      ref: "canonical_slash_country_first_no_legacy_aliases",
      description: "Move high-volume verified canonical country-first slash redirects to Cloudflare before Worker",
      expression,
      action: "redirect",
      action_parameters: { from_value: {
        target_url: { expression: `concat("https://${HOST}", http.request.uri.path, "/")` },
        status_code: 308,
        preserve_query_string: true,
      } },
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cities = JSON.parse(fs.readFileSync(path.join(root, "scripts/resolved_cities.json"), "utf8"));
  const artifact = JSON.parse(fs.readFileSync(path.join(root, "scripts/legacy-city-route-redirects.v1.json"), "utf8"));
  process.stdout.write(`${JSON.stringify(buildEdgePolicy({ cities, artifact }), null, 2)}\n`);
}
