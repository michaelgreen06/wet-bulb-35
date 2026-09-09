import assert from "node:assert/strict";
import test from "node:test";

import { createWranglerTailSanitizer } from "../scripts/wrangler-tail-sanitizer.mjs";

const sensitiveEnvelope = {
  outcome: "ok",
  scriptName: "wetbulb35-weather-staging",
  event: {
    request: {
      url: "https://wetbulb35-weather-staging.example/api/weather?lat=12.34&lon=-56.78&token=do-not-log",
      headers: { "cf-connecting-ip": "203.0.113.42" },
      cf: { tlsVersion: "TLSv1.3", colo: "SJC", country: "US" },
    },
  },
  logs: [
    { level: "log", message: ["not application JSON"] },
    { level: "log", message: [JSON.stringify({ event: "weather_provider_call", deployment_version: "unit-v1", outcome: "success", upstream_status: 200, latency_ms: 12, canonical_key_hash: "a".repeat(64), cache_state: "miss", reserved_budget_used: 1, reserved_budget_limit: 100 })] },
    { level: "log", message: [JSON.stringify({ event: "weather_cache_hit", deployment_version: "unit-v1", cache_state: "fresh", canonical_key_hash: "b".repeat(64) })] },
  ],
};

test("sanitizer handles concatenated and multiline Wrangler JSON without emitting envelopes", () => {
  const emitted = [];
  const sanitizer = createWranglerTailSanitizer({ emit: (line) => emitted.push(line) });
  const raw = `${JSON.stringify(sensitiveEnvelope)}\n${JSON.stringify({ ...sensitiveEnvelope, logs: [sensitiveEnvelope.logs[2]] }, null, 2)}`;
  sanitizer.write(raw.slice(0, 37));
  sanitizer.write(raw.slice(37));
  sanitizer.end();

  assert.equal(emitted.length, 3);
  const events = emitted.map((line) => JSON.parse(line));
  assert.deepEqual(events, [
    { event: "weather_provider_call", deployment_version: "unit-v1", outcome: "success", upstream_status: 200, latency_ms: 12, canonical_key_hash: "a".repeat(64), cache_state: "miss", reserved_budget_used: 1, reserved_budget_limit: 100 },
    { event: "weather_cache_hit", deployment_version: "unit-v1", cache_state: "fresh", canonical_key_hash: "b".repeat(64) },
    { event: "weather_cache_hit", deployment_version: "unit-v1", cache_state: "fresh", canonical_key_hash: "b".repeat(64) },
  ]);
  const output = emitted.join("\n");
  for (const forbidden of ["12.34", "-56.78", "token", "203.0.113.42", "tlsversion", "sjc", "https://", "scriptname", "request"]) {
    assert.equal(output.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test("sanitizer drops malformed messages and schemas that are not exact", () => {
  const emitted = [];
  const sanitizer = createWranglerTailSanitizer({ emit: (line) => emitted.push(line) });
  sanitizer.write(JSON.stringify({ logs: [
    { message: [JSON.stringify({ event: "weather_provider_call", deployment_version: "unit-v1", outcome: "success", upstream_status: 200, latency_ms: 1, canonical_key_hash: "not-a-hash", cache_state: "miss", reserved_budget_used: 1, reserved_budget_limit: 2 })] },
    { message: [JSON.stringify({ event: "html_cache_outcome", deployment_version: "unit-v1", outcome: "hit", cache_state: "hit", route_class: "html", query: "lat=12.34" })] },
    { message: "not-an-array" },
  ] }));
  sanitizer.end();
  assert.deepEqual(emitted, []);
});
