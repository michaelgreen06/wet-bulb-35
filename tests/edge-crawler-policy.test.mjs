import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEdgePolicy, edgeRedirectTarget, EDGE_COUNTRIES } from "../scripts/build-edge-crawler-policy.mjs";
import { createRouteIdentityIndex } from "../scripts/probe-location-route-identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cities = JSON.parse(fs.readFileSync(path.join(root, "scripts/resolved_cities.json"), "utf8"));
const artifact = JSON.parse(fs.readFileSync(path.join(root, "scripts/legacy-city-route-redirects.v1.json"), "utf8"));

// The matcher mirrors the intentionally small Cloudflare expression: it is not a replacement
// for an isolated Cloudflare Trace/staging check of the provider's actual rule parser.
test("candidate preserves every historical different-destination redirect", () => {
  const policy = buildEdgePolicy({ cities, artifact });
  assert.equal(policy.analysis.legacySources, artifact.aliases.length + artifact.overlaps.length);
  for (const [source] of [...artifact.aliases, ...artifact.overlaps]) {
    assert.equal(edgeRedirectTarget(source), null, `legacy alias intercepted: ${source}`);
  }
  const mutated = structuredClone(artifact);
  mutated.aliases.push(["/wetbulb-temperature/germany/test/place", "/wetbulb-temperature/other/test/place/"]);
  assert.throws(() => buildEdgePolicy({ cities, artifact: mutated }), /hijacked/);
});

test("candidate redirects known country-first city routes but never private assets, APIs, or other methods", () => {
  const policy = buildEdgePolicy({ cities, artifact });
  const rows = createRouteIdentityIndex(cities).rows;
  let matched = 0;
  for (const row of rows) {
    const target = `/wetbulb-temperature/${row.countrySlug}/${row.stateSlug}/${row.outputCitySlug}/`;
    const path = target.slice(0, -1);
    const expected = EDGE_COUNTRIES.includes(row.countrySlug) ? target : null;
    assert.equal(edgeRedirectTarget(path), expected);
    if (expected) matched++;
  }
  assert.equal(matched, policy.analysis.eligibleCityRoutes);
  for (const path of ["/locations/route-manifest.json", "/locations/shards/us.json", "/api/forecast", "/assets/app.css", "/sitemap-index.xml", "/wetbulb-temperature//germany/bavaria/munich", "/wetbulb-temperature/germany/bavaria/munich/"]) {
    assert.equal(edgeRedirectTarget(path), null, path);
  }
  assert.equal(edgeRedirectTarget("/wetbulb-temperature/germany/bavaria/munich", "POST"), null);
  assert.equal(edgeRedirectTarget("/wetbulb-temperature/germany/bavaria/munich", "HEAD"), "/wetbulb-temperature/germany/bavaria/munich/");
});

test("WAF block excludes verified search engines; search skip affects only rate limiting", () => {
  const { wafCustomRules: [block, skip], singleRedirectRule: redirect } = buildEdgePolicy({ cities, artifact });
  assert.match(block.expression, /lower\(http\.user_agent\) contains "shapbot"/);
  assert.match(block.expression, /not cf\.client\.bot or cf\.verified_bot_category ne "Search Engine Crawler"/, "include unverified clients where the category is missing");
  assert.match(block.expression, /cf\.verified_bot_category ne "Search Engine Crawler"/);
  assert.match(block.expression, /shapbot/);
  assert.equal(block.action, "block");
  assert.match(skip.expression, /cf\.verified_bot_category eq "Search Engine Crawler"/);
  assert.deepEqual(skip.action_parameters, { phases: ["http_ratelimit"] });
  assert.equal(redirect.action_parameters.from_value.status_code, 308);
  assert.equal(redirect.action_parameters.from_value.preserve_query_string, true);
  assert.ok(redirect.expression.length < 4096);
  assert.match(redirect.expression, /http\.request\.method in \{"GET" "HEAD"\}/);
  assert.match(redirect.expression, /http\.host eq "www\.wetbulb35\.com"/);
  assert.match(redirect.expression, /not \(lower\(http\.user_agent\) contains "shapbot"\)/);
  assert.match(redirect.action_parameters.from_value.target_url.expression, /concat\("https:\/\/www\.wetbulb35\.com", http\.request\.uri\.path, "\/"\)/);
});
