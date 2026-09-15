#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_ORIGIN = "https://www.wetbulb35.com";
const EXPECTED_ROUTE = "www.wetbulb35.com/*";
const EXPECTED_WORKER = "wetbulb35-weather-production";
const EXPECTED_CITY_COUNT = 130_686;
const EXPECTED_SITEMAP_MEMBER_COUNT = 228;
const EXPECTED_SITEMAP_ENTRY_COUNT = 134_668;
const EXPECTED_PAGE_COUNT = 134_440;

function parseArgs(argv = process.argv.slice(2)) {
  const args = new Map();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    args.set(key, rest.length ? rest.join("=") : "true");
  }
  return args;
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function uuid(value, name) {
  required(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
  return value;
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function cardNames(html) {
  return [...html.matchAll(/<a class="p-4 border rounded-lg hover:bg-gray-50 transition-colors" href="[^"]+">\s*<div class="font-semibold">([^<]+)<\/div>/g)]
    .map((match) => decodeHtml(match[1]));
}

function isAlphabetical(values) {
  return values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) <= 0);
}

function canonicalPresent(html, path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<link rel="canonical" href="https://www\\.wetbulb35\\.com${escaped}">`).test(html);
}

async function request(fetchImpl, url, { method = "GET", timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: method === "HEAD" ? "*/*" : "text/html,application/json;q=0.9,*/*;q=0.8", "User-Agent": "WetBulb35-Release-Monitor/1.0" },
    });
    return { response, body: method === "HEAD" ? "" : await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function cfJson(fetchImpl, url, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response;
  let body;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "WetBulb35-Release-Monitor/1.0" },
    });
    body = await response.text();
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`Cloudflare API returned ${response.status}`);
  const parsed = JSON.parse(body);
  if (!parsed.success) throw new Error("Cloudflare API returned success=false");
  return parsed.result;
}

export async function readControlPlane({ fetchImpl = fetch, apiBase = "https://api.cloudflare.com/client/v4", token, accountId, zoneName = "wetbulb35.com", worker = EXPECTED_WORKER }) {
  required(token, "Cloudflare API token");
  required(accountId, "Cloudflare account ID");
  const deployments = await cfJson(fetchImpl, `${apiBase}/accounts/${accountId}/workers/scripts/${worker}/deployments`, token);
  const active = deployments.deployments?.[0];
  const activeVersions = active?.versions || [];
  const activeVersion = activeVersions.length === 1 && activeVersions[0].percentage === 100 ? activeVersions[0].version_id : null;
  const zones = await cfJson(fetchImpl, `${apiBase}/zones?name=${encodeURIComponent(zoneName)}`, token);
  if (zones.length !== 1) throw new Error(`Expected one active zone for ${zoneName}`);
  const routes = await cfJson(fetchImpl, `${apiBase}/zones/${zones[0].id}/workers/routes`, token);
  const exactRoutes = routes.filter((route) => route.pattern === EXPECTED_ROUTE);
  return {
    activeDeploymentId: active?.id || null,
    activeVersion,
    exactRoutes: exactRoutes.map((route) => ({ id: route.id, pattern: route.pattern, script: route.script || null })),
    zoneId: zones[0].id,
  };
}

async function checkText(fetchImpl, origin, path, predicate, failures, name) {
  try {
    const { response, body } = await request(fetchImpl, `${origin}${path}`);
    if (!response.ok || !predicate(body, response)) failures.push(`${name}:${response.status}`);
    return body;
  } catch (error) {
    failures.push(`${name}:${error.name || "request_error"}`);
    return "";
  }
}

async function checkHead(fetchImpl, origin, path, predicate, failures, name) {
  try {
    const { response } = await request(fetchImpl, `${origin}${path}`, { method: "HEAD" });
    if (!response.ok || !predicate(response)) failures.push(`${name}:${response.status}`);
  } catch (error) {
    failures.push(`${name}:${error.name || "request_error"}`);
  }
}

async function checkWeather(fetchImpl, origin, warnings) {
  const locations = [
    ["houston", "29.7605", "-95.3634"],
    ["singapore", "1.28967", "103.85007"],
  ];
  for (const [name, lat, lon] of locations) {
    try {
      const { response, body } = await request(fetchImpl, `${origin}/api/weather?lat=${lat}&lon=${lon}`, { timeoutMs: 15_000 });
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      const valid = response.ok && parsed?.weather && Number.isFinite(parsed.weather.temperature)
        && Number.isFinite(parsed.weather.humidity) && Number.isFinite(parsed.weather.wetBulb);
      if (!valid) warnings.push(`weather_${name}:${response.status}`);
    } catch (error) {
      warnings.push(`weather_${name}:${error.name || "request_error"}`);
    }
  }
}

async function checkAllSitemaps(fetchImpl, origin, indexXml, failures) {
  const members = [...indexXml.matchAll(/<loc>(https:\/\/www\.wetbulb35\.com\/sitemaps\/[^<]+)<\/loc>/g)].map((match) => match[1]);
  const counts = new Map();
  let entries = members.length;
  for (const member of members) {
    const memberPath = new URL(member).pathname;
    const target = `${origin}${memberPath}`;
    try {
      const { response, body } = await request(fetchImpl, target, { timeoutMs: 30_000 });
      if (!response.ok) {
        failures.push(`sitemap_member:${memberPath}:${response.status}`);
        continue;
      }
      for (const match of body.matchAll(/<loc>https:\/\/www\.wetbulb35\.com([^<]+)<\/loc>/g)) {
        counts.set(match[1], (counts.get(match[1]) || 0) + 1);
        entries += 1;
      }
    } catch (error) {
      failures.push(`sitemap_member:${new URL(member).pathname}:${error.name || "request_error"}`);
    }
  }
  if (entries !== EXPECTED_SITEMAP_ENTRY_COUNT) failures.push(`sitemap_entry_count:${entries}`);
  const duplicates = [...counts.values()].filter((count) => count !== 1).length;
  if (duplicates) failures.push(`sitemap_duplicate_paths:${duplicates}`);
  if (counts.size !== EXPECTED_PAGE_COUNT) failures.push(`sitemap_unique_route_count:${counts.size}`);
}

export async function runReleaseChecks({
  fetchImpl = fetch,
  origin = DEFAULT_ORIGIN,
  apiBase,
  token,
  accountId,
  expectedVersion,
  rollbackVersion,
  fullSitemaps = false,
  weather = false,
  recovery = false,
}) {
  uuid(expectedVersion, "expected version");
  if (rollbackVersion) uuid(rollbackVersion, "rollback version");
  const criticalFailures = [];
  const warnings = [];
  let control;
  try {
    control = await readControlPlane({ fetchImpl, apiBase, token, accountId });
  } catch (error) {
    return { status: "control_unavailable", rollbackEligible: false, criticalFailures: [`control_plane:${error.message}`], warnings, control: null };
  }

  const routeHealthy = control.exactRoutes.length === 1 && control.exactRoutes[0].script === EXPECTED_WORKER;
  const currentIsExpected = control.activeVersion === expectedVersion;
  const currentIsRollback = rollbackVersion && control.activeVersion === rollbackVersion;
  if (!currentIsExpected) {
    return {
      status: currentIsRollback ? "already_rolled_back" : "superseded",
      rollbackEligible: false,
      criticalFailures: [],
      warnings,
      control,
    };
  }
  if (!routeHealthy) criticalFailures.push(`production_route:${JSON.stringify(control.exactRoutes)}`);

  await checkText(fetchImpl, origin, "/", (body) => /<title>Current Wet Bulb Temperature<\/title>/.test(body), criticalFailures, "home");
  const browse = await checkText(fetchImpl, origin, "/wetbulb-temperature/", (body) => /<title>Wet Bulb Temperature by Country<\/title>/.test(body), criticalFailures, "browse");
  await checkText(fetchImpl, origin, "/wetbulb-temperature/united-states/texas/houston/", (body) => canonicalPresent(body, "/wetbulb-temperature/united-states/texas/houston/"), criticalFailures, "houston");
  const app = await checkText(fetchImpl, origin, "/assets/app.js", (body) => body.includes("maps.googleapis.com/maps/api/js") && body.includes("fetchWeather"), criticalFailures, "browser_runtime");
  void app;
  await checkHead(fetchImpl, origin, "/assets/locations.json", (response) => (response.headers.get("content-type") || "").includes("application/json"), criticalFailures, "search_index");
  const robots = await checkText(fetchImpl, origin, "/robots.txt", (body) => body.includes("Sitemap: https://www.wetbulb35.com/sitemap.xml"), criticalFailures, "robots");
  void robots;
  const sitemap = await checkText(fetchImpl, origin, "/sitemap.xml", (body) => {
    const members = [...body.matchAll(/<loc>/g)].length;
    return body.includes("<sitemapindex") && members === (recovery ? 227 : EXPECTED_SITEMAP_MEMBER_COUNT);
  }, criticalFailures, "sitemap_index");

  if (!recovery) {
    const popular = browse.match(/<section aria-labelledby="popular-wet-bulb-temperatures"[^>]*>([\s\S]*?)<\/section>/)?.[1] || "";
    const popularLinks = [...popular.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    if (popularLinks.length !== 40 || new Set(popularLinks).size !== 40) criticalFailures.push(`popular_links:${popularLinks.length}/${new Set(popularLinks).size}`);
    const us = await checkText(fetchImpl, origin, "/wetbulb-temperature/united-states/", () => true, criticalFailures, "united_states");
    const texas = await checkText(fetchImpl, origin, "/wetbulb-temperature/united-states/texas/", () => true, criticalFailures, "texas");
    const usNames = cardNames(us);
    const texasNames = cardNames(texas);
    if (usNames.length !== 51 || !isAlphabetical(usNames)) criticalFailures.push(`us_directory:${usNames.length}/${isAlphabetical(usNames)}`);
    if (texasNames.length !== 1_009 || !isAlphabetical(texasNames)) criticalFailures.push(`texas_directory:${texasNames.length}/${isAlphabetical(texasNames)}`);
    for (const path of [
      "/wetbulb-temperature/singapore/singapore/singapore/",
      "/wetbulb-temperature/hong-kong/hong-kong/hong-kong/",
    ]) {
      await checkText(fetchImpl, origin, path, (body) => canonicalPresent(body, path), criticalFailures, path.includes("singapore") ? "singapore" : "hong_kong");
    }
    if (fullSitemaps && sitemap) await checkAllSitemaps(fetchImpl, origin, sitemap, criticalFailures);
  }

  if (weather) await checkWeather(fetchImpl, origin, warnings);
  return {
    status: criticalFailures.length ? "critical_failure" : warnings.length ? "healthy_with_weather_warning" : "healthy",
    rollbackEligible: criticalFailures.length > 0 && currentIsExpected,
    criticalFailures,
    warnings,
    control,
  };
}

export function pollingPhase({ startedAt, lastCheckedAt, now = new Date() }) {
  const started = new Date(startedAt);
  const last = lastCheckedAt ? new Date(lastCheckedAt) : null;
  if (!Number.isFinite(started.getTime()) || !Number.isFinite(now.getTime()) || (last && !Number.isFinite(last.getTime()))) throw new Error("Invalid monitor timestamp");
  const elapsedMinutes = (now - started) / 60_000;
  if (elapsedMinutes < 0) return { due: false, phase: "not_started", expired: false };
  if (elapsedMinutes >= 24 * 60) return { due: false, phase: "expired", expired: true };
  const intervalMinutes = elapsedMinutes < 60 ? 2 : 30;
  const due = !last || (now - last) / 60_000 >= intervalMinutes - 0.25;
  const fullSitemaps = !last || elapsedMinutes >= 55 && elapsedMinutes < 65 || elapsedMinutes >= 23 * 60 + 45;
  const weather = !last || elapsedMinutes < 60 ? due : due && Math.floor(elapsedMinutes / 30) % 2 === 0;
  return { due, phase: elapsedMinutes < 60 ? "intensive" : "extended", expired: false, intervalMinutes, fullSitemaps, weather };
}

async function main() {
  const args = parseArgs();
  const result = await runReleaseChecks({
    origin: args.get("origin") || DEFAULT_ORIGIN,
    apiBase: args.get("api-base"),
    token: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    expectedVersion: args.get("expected-version"),
    rollbackVersion: args.get("rollback-version"),
    fullSitemaps: args.get("full-sitemaps") === "true",
    weather: args.get("weather") === "true",
    recovery: args.get("recovery") === "true",
  });
  const output = JSON.stringify(result);
  console.log(output);
  if (args.get("output")) fs.writeFileSync(args.get("output"), `${output}\n`);
  if (result.status === "control_unavailable") process.exitCode = 4;
  else if (result.status === "superseded") process.exitCode = 3;
  else if (result.rollbackEligible) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(JSON.stringify({ status: "monitor_error", error: error.message }));
  process.exitCode = 4;
});
