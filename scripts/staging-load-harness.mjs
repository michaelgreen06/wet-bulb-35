#!/usr/bin/env node
/** Bounded, body-free staging harness. Fake is the default and never calls a provider. */
import http from "node:http";
import { performance } from "node:perf_hooks";

const STAGING_HOST = "wetbulb35-weather-staging.mgdevstuff.workers.dev";
const DEFAULT_HTML_REQUESTS = 24;
const DEFAULT_CONCURRENCY = 4;
const MAX_STAGING_WEATHER_REQUESTS = 20; // Deliberately far below the daily ceiling of 100.

function option(name, fallback) {
  const value = process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  return value === undefined ? fallback : value;
}
function positiveInteger(name, fallback, maximum) {
  const value = Number(option(name, fallback));
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return value;
}
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
function summarize(records) {
  const latencies = records.map((record) => record.latency_ms);
  const statuses = Object.fromEntries([...records.reduce((counts, record) => counts.set(record.status, (counts.get(record.status) || 0) + 1), new Map())].sort(([a], [b]) => a - b));
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
const htmlRequests = positiveInteger("html-requests", DEFAULT_HTML_REQUESTS, 200);
const concurrency = positiveInteger("concurrency", DEFAULT_CONCURRENCY, 16);
const weatherRequests = positiveInteger("weather-requests", 4, MAX_STAGING_WEATHER_REQUESTS);
if (!new Set(["fake", "local", "staging"]).has(mode)) throw new Error("mode must be fake, local, or staging");
if (mode === "staging" && option("allow-staging-weather", "false") !== "true") throw new Error("staging weather requires --allow-staging-weather=true");
const suppliedOrigin = option("origin", "");
if (mode !== "fake" && !suppliedOrigin) throw new Error(`${mode} requires --origin=https://...`);
if (mode === "staging" && new URL(suppliedOrigin).hostname !== STAGING_HOST) throw new Error("staging origin must be the isolated staging Workers hostname");
if (mode !== "staging" && /wetbulb35\.com$/i.test(new URL(suppliedOrigin || "http://127.0.0.1").hostname)) throw new Error("default/test modes refuse wetbulb35.com hosts");

const fake = mode === "fake" ? await fakeServer() : null;
const origin = fake?.origin || suppliedOrigin;
try {
  // Warm exactly one canonical weather key before measuring same-key requests.
  const warm = await request(origin, "/api/weather?lat=1&lon=2");
  const html = await pooled(htmlRequests, concurrency, () => request(origin, "/wetbulb-temperature/andorra/encamp/vila"));
  const weather = await pooled(weatherRequests, Math.min(concurrency, weatherRequests), () => request(origin, "/api/weather?lat=1&lon=2"));
  console.log(JSON.stringify({ mode, origin: new URL(origin).origin, bounds: { html_requests: htmlRequests, concurrency, weather_requests: weatherRequests, staging_weather_max: MAX_STAGING_WEATHER_REQUESTS }, warm_status: warm.status, html: summarize(html), weather: summarize(weather) }));
} finally {
  await fake?.close();
}
