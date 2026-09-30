import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9._:-]{1,128}$/;
const PROVIDER_OUTCOME = new Set(["success", "timeout", "upstream_http", "invalid_payload", "exception"]);
const HTML_OUTCOME = new Set(["hit", "miss", "stale"]);
const SOURCE_FAMILY = new Set(["chrome", "edge", "firefox", "safari", "script", "other"]);
const SOURCE_REFERRER = new Set(["city_page", "site_other", "external", "none", "invalid"]);

function hasExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function safeVersion(value) { return typeof value === "string" && VERSION.test(value); }
function safeHash(value) { return value === null || (typeof value === "string" && HASH.test(value)); }
function safeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }

/** Returns a new, fixed-schema event or null. Never returns the input object. */
export function validateApplicationLog(value) {
  const base = ["cache_state", "canonical_key_hash", "deployment_version", "event"];
  if (!value || typeof value !== "object" || Array.isArray(value) || !safeVersion(value.deployment_version)) return null;

  switch (value.event) {
    case "weather_cache_hit":
      if (!hasExactKeys(value, base) || value.cache_state !== "fresh" || !safeHash(value.canonical_key_hash)) return null;
      return { event: value.event, deployment_version: value.deployment_version, cache_state: "fresh", canonical_key_hash: value.canonical_key_hash };
    case "weather_cache_stale":
      if (!hasExactKeys(value, base) || value.cache_state !== "stale" || !safeHash(value.canonical_key_hash)) return null;
      return { event: value.event, deployment_version: value.deployment_version, cache_state: "stale", canonical_key_hash: value.canonical_key_hash };
    case "weather_cache_miss":
      if (!hasExactKeys(value, base) || value.cache_state !== "miss" || !safeHash(value.canonical_key_hash)) return null;
      return { event: value.event, deployment_version: value.deployment_version, cache_state: "miss", canonical_key_hash: value.canonical_key_hash };
    case "weather_bot_skip":
    case "weather_validation_failure":
      if (!hasExactKeys(value, ["cache_state", "deployment_version", "event"]) || value.cache_state !== "none") return null;
      return { event: value.event, deployment_version: value.deployment_version, cache_state: "none" };
    case "weather_budget_exhausted":
      if (!hasExactKeys(value, [...base, "reserved_budget_limit", "reserved_budget_used"].sort()) || !["miss", "stale_refresh"].includes(value.cache_state) || !safeHash(value.canonical_key_hash) || !safeInteger(value.reserved_budget_used) || !safeInteger(value.reserved_budget_limit)) return null;
      return { event: value.event, deployment_version: value.deployment_version, cache_state: value.cache_state, canonical_key_hash: value.canonical_key_hash, reserved_budget_used: value.reserved_budget_used, reserved_budget_limit: value.reserved_budget_limit };
    case "weather_source_attribution":
      if (!hasExactKeys(value, ["cache_state", "deployment_version", "event", "asn", "country", "ua_family", "ua_major", "referrer_class", "verified_bot", "source_state"].sort())
        || !["miss", "stale_refresh"].includes(value.cache_state)
        || !["reserved", "budget_denied"].includes(value.source_state)
        || !(value.asn === null || (Number.isSafeInteger(value.asn) && value.asn > 0 && value.asn <= 4_294_967_295))
        || !(value.country === null || (typeof value.country === "string" && /^[A-Z0-9]{2}$/.test(value.country)))
        || !SOURCE_FAMILY.has(value.ua_family)
        || !(value.ua_major === null || (["chrome", "edge", "firefox", "safari"].includes(value.ua_family) && Number.isSafeInteger(value.ua_major) && value.ua_major >= 1 && value.ua_major <= 400))
        || !SOURCE_REFERRER.has(value.referrer_class)
        || !(value.verified_bot === null || typeof value.verified_bot === "boolean")) return null;
      return { event: value.event, deployment_version: value.deployment_version, cache_state: value.cache_state,
        source_state: value.source_state,
        asn: value.asn, country: value.country, ua_family: value.ua_family, ua_major: value.ua_major,
        referrer_class: value.referrer_class, verified_bot: value.verified_bot };
    case "weather_provider_call":
      if (!hasExactKeys(value, [...base, "latency_ms", "outcome", "reserved_budget_limit", "reserved_budget_used", "upstream_status"].sort()) || !PROVIDER_OUTCOME.has(value.outcome) || !["miss", "stale_refresh"].includes(value.cache_state) || !safeHash(value.canonical_key_hash) || !safeInteger(value.latency_ms) || !safeInteger(value.reserved_budget_used) || !safeInteger(value.reserved_budget_limit) || !(value.upstream_status === null || (Number.isSafeInteger(value.upstream_status) && value.upstream_status >= 100 && value.upstream_status <= 599))) return null;
      return { event: value.event, deployment_version: value.deployment_version, outcome: value.outcome, upstream_status: value.upstream_status, latency_ms: value.latency_ms, canonical_key_hash: value.canonical_key_hash, cache_state: value.cache_state, reserved_budget_used: value.reserved_budget_used, reserved_budget_limit: value.reserved_budget_limit };
    case "html_cache_outcome":
      if (!hasExactKeys(value, ["cache_state", "deployment_version", "event", "outcome", "route_class"]) || !HTML_OUTCOME.has(value.outcome) || value.cache_state !== value.outcome || value.route_class !== "html") return null;
      return { event: value.event, deployment_version: value.deployment_version, outcome: value.outcome, cache_state: value.cache_state, route_class: "html" };
    default: return null;
  }
}

function applicationMessage(log) {
  if (!log || typeof log !== "object" || !Array.isArray(log.message) || log.message.length !== 1 || typeof log.message[0] !== "string") return null;
  try { return validateApplicationLog(JSON.parse(log.message[0])); } catch { return null; }
}

/** Incrementally accepts only complete top-level JSON objects from Wrangler stdout. */
export function createWranglerTailSanitizer({ emit = () => {} } = {}) {
  let buffer = "";
  const processObject = (json) => {
    try {
      const envelope = JSON.parse(json);
      if (!envelope || typeof envelope !== "object" || !Array.isArray(envelope.logs)) return;
      for (const log of envelope.logs) {
        const event = applicationMessage(log);
        if (event) emit(JSON.stringify(event));
      }
    } catch {}
  };
  const drain = () => {
    let start = -1, depth = 0, inString = false, escaped = false;
    for (let index = 0; index < buffer.length; index += 1) {
      const character = buffer[index];
      if (start < 0) {
        if (character === "{") { start = index; depth = 1; }
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          processObject(buffer.slice(start, index + 1));
          buffer = buffer.slice(index + 1);
          return drain();
        }
      }
    }
    buffer = start < 0 ? "" : buffer.slice(start);
  };
  return { write(chunk) { buffer += String(chunk); drain(); }, end() { drain(); buffer = ""; } };
}

export function runSafeWranglerTail() {
  const worker = "wetbulb35-weather-staging";
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const wrangler = path.join(repositoryRoot, "node_modules", ".bin", "wrangler");
  const sanitizer = createWranglerTailSanitizer({ emit: (line) => process.stdout.write(`${line}\n`) });
  const child = spawn(wrangler, ["tail", worker, "--format=json"], { stdio: ["inherit", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => sanitizer.write(chunk));
  child.stdout.on("end", () => sanitizer.end());
  // Consume, but never relay, Wrangler stderr because it can contain unsafe request data.
  child.stderr.resume();
  child.on("error", () => { process.exitCode = 1; });
  child.on("close", (code) => { if (code !== 0) process.exitCode = 1; });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runSafeWranglerTail();
