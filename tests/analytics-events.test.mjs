import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { clientRuntimeSource, renderGoogleAnalyticsScripts } from "../lib/page-renderer.mjs";

const approved = new Set(["location_search_success", "location_search_no_match", "current_location_success", "current_location_failure", "weather_load_success", "weather_load_failure", "forecast_view", "forecast_load_failure", "map_view", "map_interaction", "hotspot_city_click"]);
const weatherPayload = { location: { name: "Austin", lat: 30.2, lng: -97.7 }, weather: { temperature: 30, humidity: 55, timestamp: "2026-09-20T12:00:00Z" } };
const forecastPayload = { days: Array.from({ length: 5 }, (_, index) => ({ date: `2026-09-${20 + index}`, maximumWetBulbC: 25, peakLocalTime: "2026-09-20T15:00:00" })), timezone: "UTC", retrievedAt: "2026-09-20T12:00:00Z" };

function page({ city = false, search = false } = {}) {
  return `<!doctype html><body>${search ? '<form data-search-form><input data-search-input><p data-search-status></p></form>' : ""}<section data-weather-widget data-lat="30" data-lon="-97" data-location="Austin"><span data-weather-location></span><span data-weather-coordinates></span><span data-weather-status></span><div data-weather-grid></div><span data-weather-wetbulb></span><span data-weather-temp></span><span data-weather-humidity></span><span data-weather-updated></span><p data-weather-error hidden></p><button data-current-location>Locate</button></section>${city ? '<section data-forecast-widget data-forecast-path="/wetbulb-temperature/us/tx/austin/"><span data-forecast-status></span><div data-forecast-days></div><p data-forecast-error hidden></p><span data-forecast-updated></span></section>' : ""}</body>`;
}

async function runtime({ html = page(), fetchImpl, bot = false, gtag = true, geolocation } = {}) {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://www.wetbulb35.com/" });
  const events = [];
  Object.defineProperty(dom.window.navigator, "userAgent", { value: bot ? "Googlebot" : "Mozilla/5.0", configurable: true });
  Object.defineProperty(dom.window.navigator, "webdriver", { value: bot, configurable: true });
  dom.window.fetch = fetchImpl || (async (url) => ({ ok: true, status: 200, json: async () => String(url).includes("forecast") ? forecastPayload : String(url).includes("locations") ? [] : weatherPayload }));
  if (geolocation) Object.defineProperty(dom.window.navigator, "geolocation", { value: geolocation, configurable: true });
  if (gtag) dom.window.gtag = (...args) => events.push(args);
  dom.window.eval(clientRuntimeSource({ placesApiKey: "" }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  return { dom, events };
}

function names(events) { return events.map(([, name]) => name); }
function event(events, name) { return JSON.parse(JSON.stringify(events.find(([, candidate]) => candidate === name)?.[2])); }

test("runtime emits exact safe initial weather and forecast events once", async () => {
  const { events } = await runtime({ html: page({ city: true }) });
  assert.deepEqual(names(events), ["weather_load_success", "forecast_view"]);
  assert.deepEqual(event(events, "weather_load_success"), { event_version: 1, page_type: "city", trigger: "page_init" });
  assert.deepEqual(event(events, "forecast_view"), { event_version: 1, page_type: "city" });
});

test("search emits one exact outcome and never sends the submitted query", async () => {
  const { dom, events } = await runtime({ html: page({ search: true }), fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => String(url).includes("locations") ? [{ label: "Austin, Texas", url: "#austin" }] : weatherPayload }) });
  const form = dom.window.document.querySelector("[data-search-form]");
  const input = dom.window.document.querySelector("[data-search-input]");
  input.value = "Austin";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  input.value = "no such place";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  assert.deepEqual(names(events).slice(-2), ["location_search_success", "location_search_no_match"]);
  for (const [, , parameters] of events) assert.equal(JSON.stringify(parameters).includes("Austin"), false);
});

test("geolocation success and failures use bounded categories and emit weather only after render", async () => {
  const success = await runtime({ geolocation: { getCurrentPosition(resolve) { resolve({ coords: { latitude: 30, longitude: -97 } }); } } });
  success.dom.window.document.querySelector("[data-current-location]").click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(names(success.events).filter((name) => name === "current_location_success").length, 1);
  assert.equal(names(success.events).filter((name) => name === "weather_load_success").length, 2);
  assert.deepEqual(event(success.events, "current_location_success"), { event_version: 1, page_type: "directory" });
  const denied = await runtime({ geolocation: { getCurrentPosition(_resolve, reject) { reject({ code: 1, message: "precise private error" }); } } });
  denied.dom.window.document.querySelector("[data-current-location]").click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(event(denied.events, "current_location_failure"), { event_version: 1, page_type: "directory", failure_category: "denied" });
  assert.equal(JSON.stringify(denied.events).includes("precise private error"), false);
});

test("weather and forecast failures are bounded and deduplicated", async () => {
  const { events } = await runtime({ html: page({ city: true }), fetchImpl: async (url) => {
    if (String(url).includes("locations")) return { ok: true, status: 200, json: async () => [] };
    return { ok: false, status: 500, json: async () => ({ error: "secret body" }) };
  } });
  assert.deepEqual(names(events), ["weather_load_failure", "forecast_load_failure"]);
  assert.equal(event(events, "weather_load_failure").failure_category, "http");
  assert.equal(event(events, "forecast_load_failure").failure_category, "http");
  assert.equal(JSON.stringify(events).includes("secret body"), false);
});

test("network failures use the network category without exposing exception text", async () => {
  const { events } = await runtime({ html: page({ city: true }), fetchImpl: async () => { throw new Error("private network detail"); } });
  assert.equal(event(events, "weather_load_failure").failure_category, "network");
  assert.equal(event(events, "forecast_load_failure").failure_category, "network");
  assert.equal(JSON.stringify(events).includes("private network detail"), false);
});

test("gtag absence, automation, and bot traffic are complete no-ops", async () => {
  assert.deepEqual((await runtime({ gtag: false })).events, []);
  assert.deepEqual((await runtime({ bot: true, html: page({ city: true }) })).events, []);
});

test("optional map and hotspot hooks deduplicate their events", async () => {
  let observer;
  const { dom, events } = await runtime({ html: `${page()}<div data-map tabindex="0"></div><a data-hotspot-city-link data-rank-bucket="top_10" href="#city">City</a>` });
  class Observer { constructor(callback) { observer = callback; } observe() {} disconnect() {} }
  dom.window.IntersectionObserver = Observer;
  dom.window.eval(clientRuntimeSource({ placesApiKey: "" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  observer([{ isIntersecting: true, intersectionRatio: 0.5 }]);
  const map = dom.window.document.querySelector("[data-map]");
  map.dispatchEvent(new dom.window.Event("pointerdown"));
  map.dispatchEvent(new dom.window.Event("pointerdown"));
  const link = dom.window.document.querySelector("[data-hotspot-city-link]");
  link.click(); link.click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(names(events).filter((name) => name === "map_view").length, 1);
  assert.equal(names(events).filter((name) => name === "map_interaction").length, 1);
  assert.equal(names(events).filter((name) => name === "hotspot_city_click").length, 1);
});

test("contract is allowlisted and staging emits no production GA snippet", () => {
  const source = clientRuntimeSource({ placesApiKey: "" });
  for (const name of approved) assert.match(source, new RegExp(`"${name}"`));
  assert.match(source, /typeof window\.gtag !== "function"/);
  assert.doesNotMatch(source, /trackAnalyticsEvent\([^\n]+(?:query|latitude|longitude|error\.message)/);
  assert.equal(renderGoogleAnalyticsScripts(""), "");
  for (const config of ["wrangler.weather-staging.toml", "wrangler.renderer-staging.toml"]) {
    const content = fs.readFileSync(new URL(`../${config}`, import.meta.url), "utf8");
    assert.match(content, /GOOGLE_ANALYTICS_ID = ""/);
    assert.doesNotMatch(content, /G-LNPWV0JL7S/);
  }
});
