import assert from "node:assert/strict";
import test from "node:test";
import { aggregateSourceEvents, querySourceEvents, parseUtcWindow } from "../scripts/audit-weather-source-events.mjs";

const base = { event: "weather_source_attribution", deployment_version: "unit-v1", cache_state: "miss",
  source_state: "reserved", asn: 13335, country: "DE",
  ua_family: "chrome", ua_major: 151, referrer_class: "city_page", verified_bot: null };
const row = (source, service = "wetbulb35-weather-production") => ({ source, $metadata: { service },
  $workers: { event: { request: { url: "https://www.wetbulb35.com/api/weather?lat=12.34&lon=-56.78&token=secret", headers: { "cf-connecting-ip": "198.51.100.10" } } } } });

test("source audit prints aggregate ASN and referrer categories, never raw invocation metadata", () => {
  const events = [row(base), row({ ...base, source_state: "budget_denied" }),
    row({ ...base, country: "US", asn: 64512, ua_family: "script", ua_major: null, referrer_class: "none", verified_bot: false }),
    row({ ...base, ip: "198.51.100.10" }), row(base, "unrelated-worker")];
  const summary = aggregateSourceEvents(events);
  assert.equal(summary.count, 3);
  assert.deepEqual(summary.states, { reserved: 2, budget_denied: 1 });
  assert.deepEqual(summary.topAsns, [{ asn: 13335, requests: 2 }, { asn: 64512, requests: 1 }]);
  assert.deepEqual(summary.referrerClasses, { city_page: 2, none: 1 });
  for (const sensitive of ["12.34", "-56.78", "198.51.100.10", "token=secret", "unit-v1"]) assert.equal(JSON.stringify(summary).includes(sensitive), false);
});

test("query is dry, bounded, and rejects partial or malformed Cloudflare results", async () => {
  const start = Date.parse("2026-09-30T16:00:00Z"), end = Date.parse("2026-09-30T17:00:00Z");
  let payload;
  const fetchImpl = async (_url, options) => {
    payload = JSON.parse(options.body);
    return Response.json({ success: true, result: { run: { status: "COMPLETED" }, events: { count: 1, events: [row(base)] } } });
  };
  const found = await querySourceEvents({ accountId: "a".repeat(32), token: "private-token", start, end, fetchImpl });
  assert.equal(found.length, 1);
  assert.deepEqual(Object.keys(found[0]).sort(), ["$metadata", "source"]);
  for (const sensitive of ["12.34", "198.51.100.10", "token=secret"]) assert.equal(JSON.stringify(found).includes(sensitive), false);
  assert.equal(payload.dry, true);
  assert.equal(payload.view, "events");
  assert.equal(payload.parameters.needle.value, "weather_source_attribution");
  assert.deepEqual(payload.timeframe, { from: start, to: end });
  await assert.rejects(querySourceEvents({ accountId: "a".repeat(32), token: "private-token", start, end,
    fetchImpl: async () => Response.json({ success: true, result: { run: { status: "COMPLETED" }, events: { count: 2, events: [row(base)] } } }) }), /incomplete/);
  await assert.rejects(querySourceEvents({ accountId: "a".repeat(32), token: "private-token", start, end,
    fetchImpl: async () => Response.json({ success: true, result: { run: { status: "COMPLETED" }, events: { count: 2000, events: Array(2000).fill(row(base)) } } }) }), /limit/);
});

test("time window must be UTC, historical, and at most six hours", () => {
  assert.deepEqual(parseUtcWindow("2026-09-30T16:00:00Z", "2026-09-30T17:00:00Z", Date.parse("2026-09-30T19:00:00Z")),
    { start: Date.parse("2026-09-30T16:00:00Z"), end: Date.parse("2026-09-30T17:00:00Z") });
  assert.throws(() => parseUtcWindow("2026-09-30T16:00:00-06:00", "2026-09-30T17:00:00Z"));
  assert.throws(() => parseUtcWindow("2026-09-30T16:00:00Z", "2026-09-30T23:00:00Z", Date.parse("2026-10-01T00:00:00Z")));
  assert.throws(() => parseUtcWindow("2026-09-30T16:00:00Z", "2026-09-30T17:00:00Z", Date.parse("2026-09-30T16:30:00Z")));
});
