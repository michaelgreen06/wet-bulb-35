import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { clientRuntimeSource, pageHtml, routePathForCity } from "../lib/page-renderer.mjs";

const path = "/wetbulb-temperature/united-states/texas/houston/";
const city = JSON.parse(fs.readFileSync(new URL("../scripts/resolved_cities.json", import.meta.url), "utf8"))
  .find((entry) => routePathForCity(entry) === path);
const dates = ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"];
const forecast = {
  timezone: "America/Chicago", utcOffsetSeconds: -18_000, retrievedAt: Date.parse("2026-09-20T15:00:00Z"),
  runs: [{ id: "snapshot-pinned", model: "ecmwf_ifs025", initialization: "2026-09-20T00:00:00Z", retrievedAt: Date.parse("2026-09-20T15:00:00Z") }],
  days: dates.map((date, index) => ({ date, maximumWetBulbC: 25 + index, peakLocalTime: `${date}T15:00`, runId: "snapshot-pinned" })),
};
const conditions = { location: { name: "Houston", lat: 29.7, lng: -95.3 }, weather: { temperature: 26, humidity: 50, wetBulb: 19, timestamp: Date.now() } };
const json = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });

async function run({ challenge = true, challengeWeather = false, reject = false, scriptFails = false } = {}) {
  const html = pageHtml(city, { forecastEnabled: true });
  const dom = new JSDOM(html.replace('<script src="/assets/app.js" defer></script>', ""), { url: `https://www.wetbulb35.com${path}`, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const calls = [], scripts = [], widgets = [], events = [];
  let verified = false;
  window.Date.now = () => Date.parse("2026-09-20T15:00:00Z");
  window.gtag = (...args) => events.push(args);
  const append = window.document.head.appendChild.bind(window.document.head);
  window.document.head.appendChild = (element) => {
    if (String(element.src).startsWith("https://challenges.cloudflare.com/turnstile/v0/api.js")) {
      scripts.push(element.src);
      queueMicrotask(() => {
        if (scriptFails) { element.onerror?.(); return; }
        window.turnstile = { render(_container, options) { widgets.push(options); return "forecast-widget"; },
          execute() { widgets.at(-1).callback("single-use-token"); }, remove() {} };
        element.onload?.();
      });
    }
    return append(element);
  };
  window.fetch = async (url, options = {}) => {
    if (!String(url).startsWith("/api/forecast")) {
      if (String(url).startsWith("/api/weather") && challengeWeather) {
        if (!verified && !options.headers?.["x-weather-turnstile"]) return json(403, { code: "verification_required", sitekey: "public-key" });
        if (options.headers?.["x-weather-turnstile"]) verified = true;
      }
      return json(200, conditions);
    }
    calls.push({ url: String(url), options });
    if (challenge && !verified && !options.headers?.["x-weather-turnstile"]) return json(403, { code: "verification_required", sitekey: "public-key" });
    if (reject) return json(403, { code: "verification_failed" });
    if (options.headers?.["x-weather-turnstile"]) verified = true;
    return json(200, forecast);
  };
  window.eval(clientRuntimeSource());
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (window.document.querySelectorAll("[data-forecast-days] > div").length === 5 || window.document.querySelector("[data-forecast-error]")?.hidden === false) break;
  }
  return { document: window.document, calls, scripts, widgets, events };
}

test("an already cached city forecast never loads Turnstile", async () => {
  const { document, calls, scripts } = await run({ challenge: false });
  assert.equal(calls.length, 1);
  assert.equal(scripts.length, 0);
  assert.equal(document.querySelectorAll("[data-forecast-days] > div").length, 5);
});

test("an uncached city forecast verifies, retries once and renders five days", async () => {
  const { document, calls, scripts, widgets, events } = await run();
  assert.equal(calls.length, 2);
  assert.equal(scripts.length, 1);
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0].action, "weather_refresh");
  assert.equal(widgets[0].sitekey, "public-key");
  assert.equal(calls[1].options.headers["x-weather-turnstile"], "single-use-token");
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(document.querySelectorAll("[data-forecast-days] > div").length, 5);
  assert.ok(!JSON.stringify(events).includes("single-use-token"));
});

test("simultaneous cold weather and forecast requests share one browser verification", async () => {
  const { document, scripts, widgets, calls } = await run({ challengeWeather: true });
  assert.equal(widgets.length, 1);
  assert.equal(scripts.length, 1);
  assert.equal(document.querySelector("[data-weather-status]")?.textContent, "Live");
  assert.equal(document.querySelectorAll("[data-forecast-days] > div").length, 5);
  assert.equal(calls.filter((call) => call.options.headers?.["x-weather-turnstile"]).length, 0);
});

test("a failed or blocked challenge does not loop or expose a provider request", async () => {
  for (const settings of [{ reject: true }, { scriptFails: true }]) {
    const { document, calls } = await run(settings);
    assert.equal(calls.length, settings.reject ? 2 : 1);
    assert.equal(document.querySelector("[data-forecast-status]")?.textContent, "Unavailable");
    assert.equal(document.querySelector("[data-forecast-error]")?.hidden, false);
  }
});
