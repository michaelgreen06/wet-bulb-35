import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { clientRuntimeSource, renderGoogleAnalyticsScripts } from "../lib/page-renderer.mjs";

const approved = ["location_search_success", "location_search_no_match", "current_location_success", "current_location_failure", "weather_load_success", "weather_load_failure", "forecast_view", "forecast_load_failure", "map_view", "map_interaction", "hotspot_city_click"];

test("runtime contains exactly the approved privacy-safe analytics contract", () => {
  const source = clientRuntimeSource({ placesApiKey: "public-test-key" });
  for (const name of approved) assert.match(source, new RegExp(`"${name}"`));
  assert.match(source, /typeof window\.gtag !== "function"/);
  assert.match(source, /navigator\.webdriver === true/);
  assert.match(source, /event_version: 1/);
  assert.match(source, /trackOnce\(widget, "WeatherSuccess" \+ trigger/);
  assert.match(source, /trackOnce\(widget, "ForecastView", "forecast_view"/);
  assert.match(source, /function bindMapAnalytics\(\)/);
  assert.match(source, /function bindHotspotAnalytics\(\)/);
  assert.doesNotMatch(source, /trackAnalyticsEvent\([^\n]+\bquery\b/);
  assert.doesNotMatch(source, /trackAnalyticsEvent\([^\n]+\b(?:latitude|longitude)\b/);
  assert.doesNotMatch(source, /trackAnalyticsEvent\([^\n]+error\.message/);
});

test("empty analytics configuration emits no GA snippet and staging has no production measurement ID", () => {
  assert.equal(renderGoogleAnalyticsScripts(""), "");
  for (const config of ["wrangler.weather-staging.toml", "wrangler.renderer-staging.toml"]) {
    const content = fs.readFileSync(new URL(`../${config}`, import.meta.url), "utf8");
    assert.match(content, /GOOGLE_ANALYTICS_ID = ""/);
    assert.doesNotMatch(content, /G-LNPWV0JL7S/);
  }
});
