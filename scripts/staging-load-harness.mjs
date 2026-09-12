#!/usr/bin/env node
/** Bounded, body-free staging harness. Fake is the default and never calls a provider. */
import http from "node:http";
import { performance } from "node:perf_hooks";

const STAGING_HOST = "wetbulb35-weather-staging.mgdevstuff.workers.dev";
const DEFAULT_HTML_REQUESTS = 24;
const DEFAULT_CONCURRENCY = 4;
const MAX_STAGING_WEATHER_REQUESTS = 20; // Includes the warm request; deliberately below the daily ceiling of 100.
const MAX_MEASURED_WEATHER_REQUESTS = MAX_STAGING_WEATHER_REQUESTS - 1;

function option(name, fallback) {
  const value = process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  return value === undefined ? fallback : value;
}
function boundedInteger(name, fallback, minimum, maximum) {
  const value = Number(option(name, fallback));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
function summarize(records) {
  const latencies = records.map((record) => record.latency_ms);
  const statuses = Object.fromEntries([...records.reduce((counts, record) => counts.set(record.status, (counts.get(record.status) || 0) + 1), new Map())].sort(([a], [b]) => a - b));
  if (records.length === 0) return { count: 0, statuses: {}, latency_ms: { p50: null, p95: null, max: null } };
  return { count: records.length, statuses, latency_ms: { p50: percentile(latencies, .50), p95: percentile(latencies, .95), max: Math.max(...latencies) } };
}
async function fakeServer() {
  let weatherWarm = false;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/weather") {
      const status = weatherWarm ? 200 : 200;
      weatherWarm = true;
      response.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store" });
      response.end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}
async function request(origin, pathname) {
  const started = performance.now();
  const response = await fetch(`${origin}${pathname}`, { signal: AbortSignal.timeout(2_000) });
  // Intentionally never read or print response bodies.
  return { status: response.status, latency_ms: Number((performance.now() - started).toFixed(3)) };
}
async function pooled(count, concurrency, operation) {
  const records = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) {
      const index = next++;
      records[index] = await operation(index);
    }
  }));
  return records;
}

const mode = option("mode", "fake");
const htmlRequests = boundedInteger("html-requests", DEFAULT_HTML_REQUESTS, 1, 200);
const concurrency = boundedInteger("concurrency", DEFAULT_CONCURRENCY, 1, 16);
// --weather-requests counts measured requests only; a nonzero run adds one warm request.
const weatherRequests = boundedInteger("weather-requests", 4, 0, MAX_MEASURED_WEATHER_REQUESTS);
const weatherTotalRequests = weatherRequests === 0 ? 0 : weatherRequests + 1;
if (!new Set(["fake", "local", "staging"]).has(mode)) throw new Error("mode must be fake, local, or staging");
if (mode === "staging" && weatherRequests > 0 && option("allow-staging-weather", "false") !== "true") throw new Error("staging weather requires --allow-staging-weather=true");
const suppliedOrigin = option("origin", "");
if (mode !== "fake" && !suppliedOrigin) throw new Error(`${mode} requires --origin=https://...`);
if (mode === "staging" && new URL(suppliedOrigin).hostname !== STAGING_HOST) throw new Error("staging origin must be the isolated staging Workers hostname");
if (mode !== "staging" && /wetbulb35\.com$/i.test(new URL(suppliedOrigin || "http://127.0.0.1").hostname)) throw new Error("default/test modes refuse wetbulb35.com hosts");

const fake = mode === "fake" ? await fakeServer() : null;
const origin = fake?.origin || suppliedOrigin;
try {
  // Warm exactly one canonical weather key only when weather is measured.
  const warm = weatherRequests === 0 ? null : await request(origin, "/api/weather?lat=1&lon=2");
  const html = await pooled(htmlRequests, concurrency, () => request(origin, "/wetbulb-temperature/andorra/encamp/vila"));
  const weather = await pooled(weatherRequests, Math.min(concurrency, weatherRequests || 1), () => request(origin, "/api/weather?lat=1&lon=2"));
  console.log(JSON.stringify({ mode, origin: new URL(origin).origin, bounds: { html_requests: htmlRequests, concurrency, weather_measured_requests: weatherRequests, weather_total_requests: weatherTotalRequests, staging_weather_max: MAX_STAGING_WEATHER_REQUESTS }, warm_status: warm?.status ?? null, html: summarize(html), weather: summarize(weather) }));
} finally {
  await fake?.close();
}
