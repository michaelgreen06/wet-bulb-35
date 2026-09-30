#!/usr/bin/env node
/** Read-only, privacy-safe summary of recent weather-source attribution events. */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateApplicationLog } from "./wrangler-tail-sanitizer.mjs";

const WORKER = "wetbulb35-weather-production";
const EVENT_LIMIT = 2000;
const HOUR_MS = 3_600_000;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function parseUtcWindow(from, to, now = Date.now()) {
  if (!UTC_INSTANT.test(from || "") || !UTC_INSTANT.test(to || "")) throw new Error("Use UTC instants ending in Z");
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || new Date(start).toISOString().replace(".000Z", "Z") !== from
    || new Date(end).toISOString().replace(".000Z", "Z") !== to
    || end <= start || end > now || end - start > 6 * HOUR_MS) {
    throw new Error("Invalid or unbounded historical window (maximum six hours)");
  }
  return { start, end };
}

export async function querySourceEvents({ accountId, token, start, end, fetchImpl = fetch }) {
  if (!/^[a-f0-9]{32}$/.test(accountId || "") || typeof token !== "string" || !token
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end - start > HOUR_MS) {
    throw new Error("Invalid account or hourly query bounds");
  }
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      queryId: "wetbulb35-weather-source-readonly",
      timeframe: { from: start, to: end },
      parameters: { needle: { value: "weather_source_attribution" } },
      view: "events", limit: EVENT_LIMIT, dry: true,
    }),
  });
  if (!response.ok) throw new Error(`Cloudflare telemetry HTTP ${response.status}`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error("Malformed Cloudflare telemetry response"); }
  const result = payload?.result;
  if (payload?.success !== true || result?.run?.status !== "COMPLETED" || !Array.isArray(result?.events?.events)) {
    throw new Error("Cloudflare telemetry query incomplete");
  }
  const { count, events } = result.events;
  if (!Number.isSafeInteger(count) || count !== events.length) throw new Error("Cloudflare telemetry count is incomplete");
  if (count >= EVENT_LIMIT) throw new Error("Cloudflare telemetry query reached its event limit; retry a narrower window");
  // Discard invocation URLs and all other raw envelope fields at the API boundary.
  return events.flatMap((item) => {
    if (item?.$metadata?.service !== WORKER) return [];
    const source = validateApplicationLog(item?.source);
    if (source?.event !== "weather_source_attribution") throw new Error("Unexpected source attribution schema");
    return [{ source, $metadata: { service: WORKER } }];
  });
}

function sortedCounts(counter) {
  return Object.fromEntries([...counter].sort(([a], [b]) => String(a).localeCompare(String(b))));
}

export function aggregateSourceEvents(items) {
  const states = new Map(), countries = new Map(), families = new Map(), referrers = new Map(), verified = new Map(), asns = new Map();
  let count = 0;
  const increment = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  for (const item of items) {
    if (item?.$metadata?.service !== WORKER) continue;
    const event = validateApplicationLog(item?.source);
    if (event?.event !== "weather_source_attribution") continue;
    count += 1;
    increment(states, event.source_state);
    increment(countries, event.country || "unknown");
    increment(families, event.ua_major ? `${event.ua_family}:${event.ua_major}` : event.ua_family);
    increment(referrers, event.referrer_class);
    increment(verified, event.verified_bot === null ? "unknown" : String(event.verified_bot));
    const asn = event.asn;
    if (!asns.has(asn)) asns.set(asn, { asn, requests: 0 });
    const bucket = asns.get(asn);
    bucket.requests += 1;
  }
  return {
    count, states: sortedCounts(states), countries: sortedCounts(countries),
    uaFamilies: sortedCounts(families), referrerClasses: sortedCounts(referrers), verifiedBots: sortedCounts(verified),
    topAsns: [...asns.values()].sort((a, b) => b.requests - a.requests || (a.asn ?? Infinity) - (b.asn ?? Infinity))
      .slice(0, 10).map(({ asn, requests }) => ({ asn, requests })),
  };
}

function flags(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1] || values.has(argv[index])) throw new Error("Expected unique --key value flags");
    values.set(argv[index], argv[index + 1]);
  }
  for (const key of ["--account-id", "--start", "--end"]) if (!values.get(key)) throw new Error(`Missing ${key}`);
  if (values.size !== 3) throw new Error("Unexpected query flag");
  return values;
}

async function main() {
  const options = flags(process.argv.slice(2));
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required in the protected environment");
  const { start, end } = parseUtcWindow(options.get("--start"), options.get("--end"));
  const items = [];
  for (let current = start; current < end; current += HOUR_MS) {
    const batch = await querySourceEvents({ accountId: options.get("--account-id"), token,
      start: current, end: Math.min(current + HOUR_MS, end) });
    items.push(...batch);
  }
  process.stdout.write(JSON.stringify({ schemaVersion: 1, worker: WORKER, startUTC: options.get("--start"),
    endUTC: options.get("--end"), ...aggregateSourceEvents(items) }) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "Weather-source audit failed"); process.exitCode = 1; });
}
