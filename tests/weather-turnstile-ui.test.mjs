import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { clientRuntimeSource } from "../lib/page-renderer.mjs";

const payload = { location: { name: "Test", lat: 1, lng: 2 }, weather: { temperature: 26, humidity: 50, wetBulb: 19, timestamp: Date.now() } };
const html = `<!doctype html><body><section data-weather-widget data-lat="1" data-lon="2" data-location="Test"><span data-weather-location></span><span data-weather-coordinates></span><span data-weather-status></span><div data-weather-grid></div><span data-weather-wetbulb></span><span data-weather-temp></span><span data-weather-humidity></span><span data-weather-updated></span><p data-weather-error hidden></p></section></body>`;
const json = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
async function run({ challenge = true, failRetry = false, scriptFails = false } = {}) {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://www.wetbulb35.com/wetbulb-temperature/" });
  const { window } = dom;
  const calls = [], scripts = [], widgetOptions = [], events = [];
  const originalAppend = window.document.head.appendChild.bind(window.document.head);
  window.document.head.appendChild = (element) => {
    if (String(element.src).startsWith("https://challenges.cloudflare.com/turnstile/v0/api.js")) {
      scripts.push(element.src);
      queueMicrotask(() => {
        if (scriptFails) { element.onerror?.(); return; }
        window.turnstile = { render(_container, options) { widgetOptions.push(options); return "challenge-id"; },
          execute() { widgetOptions.at(-1).callback("one-time-token"); }, remove() {} };
        element.onload?.();
      });
    }
    return originalAppend(element);
  };
  window.gtag = (...args) => events.push(args);
  window.fetch = async (url, options = {}) => {
    if (String(url).includes("locations.json")) return json(200, []);
    calls.push({ url: String(url), options });
    if (!challenge) return json(200, payload);
    if (!options.headers?.["x-weather-turnstile"]) return json(403, { code: "verification_required", sitekey: "public-test-key" });
    if (failRetry) return json(403, { code: "verification_failed" });
    return json(200, payload);
  };
  window.eval(clientRuntimeSource());
  await new Promise((resolve) => setTimeout(resolve, 70));
  return { dom, calls, scripts, widgetOptions, events };
}

test("cached weather does not load Turnstile", async () => {
  const { dom, calls, scripts } = await run({ challenge: false });
  assert.equal(calls.length, 1);
  assert.equal(scripts.length, 0);
  assert.equal(dom.window.document.querySelector("[data-weather-status]").textContent, "Live");
});

test("a cold-cache challenge executes once, retries with header, and leaves HTML indexable", async () => {
  const { dom, calls, scripts, widgetOptions, events } = await run();
  assert.equal(calls.length, 2);
  assert.equal(scripts.length, 1);
  assert.equal(widgetOptions.length, 1);
  assert.equal(widgetOptions[0].sitekey, "public-test-key");
  assert.equal(widgetOptions[0].action, "weather_refresh");
  assert.equal(widgetOptions[0].execution, "execute");
  assert.equal(widgetOptions[0].appearance, "interaction-only");
  assert.equal(calls[1].options.headers["x-weather-turnstile"], "one-time-token");
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[1].url.includes("one-time-token"), false);
  assert.equal(dom.window.document.querySelector("[data-weather-status]").textContent, "Live");
  assert.equal(JSON.stringify(events).includes("one-time-token"), false);
});

test("a rejected retry fails once without challenge loops or token leakage", async () => {
  const { dom, calls, scripts, events } = await run({ failRetry: true });
  assert.equal(calls.length, 2);
  assert.equal(scripts.length, 1);
  assert.equal(dom.window.document.querySelector("[data-weather-status]").textContent, "Unavailable");
  assert.equal(JSON.stringify(events).includes("one-time-token"), false);
});

test("a blocked Turnstile script leaves HTML readable and never retries the weather API", async () => {
  const { dom, calls, scripts } = await run({ scriptFails: true });
  assert.equal(calls.length, 1);
  assert.equal(scripts.length, 1);
  assert.equal(dom.window.document.querySelector("[data-weather-status]").textContent, "Unavailable");
  assert.match(dom.window.document.body.textContent, /Weather verification is unavailable/);
});
