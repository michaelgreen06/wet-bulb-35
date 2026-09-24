import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { clientRuntimeSource, pageHtml, routePathForCity } from "../lib/page-renderer.mjs";

const cities = JSON.parse(fs.readFileSync(new URL("../scripts/resolved_cities.json", import.meta.url), "utf8"));
const houstonPath = "/wetbulb-temperature/united-states/texas/houston/";
const houston = cities.find((city) => routePathForCity(city) === houstonPath);
const ordinary = cities.find((city) => routePathForCity(city) !== houstonPath && city.name === "Vila");

test("forecast markup is inert and available on every city page", () => {
  assert.ok(houston);
  assert.ok(ordinary);
  const popularHtml = pageHtml(houston, { forecastEnabled: true });
  assert.match(popularHtml, /data-forecast-widget/);
  assert.match(popularHtml, /data-forecast-path="\/wetbulb-temperature\/united-states\/texas\/houston\/"/);
  assert.match(popularHtml, /Five-day maximum wet bulb temperature forecast for Houston/);
  assert.match(popularHtml, /Forecast wet bulb temperature values are calculated/);
  assert.match(popularHtml, /Romps thermodynamic liquid-water method/);
  assert.match(popularHtml, /https:\/\/open-meteo\.com\//);
  assert.match(popularHtml, /Get the current wet bulb temperature and five-day maximum wet bulb temperature forecast for Houston, Texas, United States\./);
  assert.doesNotMatch(popularHtml, /data-forecast-day=/);
  assert.ok(popularHtml.indexOf("Forecast notes") > popularHtml.indexOf("Climate context for Houston"));
  assert.ok(popularHtml.indexOf("Forecast notes") > popularHtml.indexOf("data-forecast-widget"));

  const ordinaryHtml = pageHtml(ordinary, { forecastEnabled: true });
  assert.match(ordinaryHtml, /data-forecast-widget/);
  assert.match(ordinaryHtml, /Five-day maximum wet bulb temperature forecast for Vila/);
  assert.match(ordinaryHtml, /Forecast wet bulb temperature values are calculated/);
  assert.match(ordinaryHtml, /Open-Meteo/);
  assert.match(ordinaryHtml, /We use the Stull formula with current air temperature and relative humidity/);

  const productionDisabledHtml = pageHtml(houston, { forecastEnabled: false });
  assert.doesNotMatch(productionDisabledHtml, /data-forecast-widget/);
});

test("browser runtime requests the canonical forecast path and never performs the Romps calculation", () => {
  const runtime = clientRuntimeSource();
  assert.match(runtime, /\/api\/forecast\?path=/);
  assert.match(runtime, /data-forecast-widget/);
  assert.match(runtime, /payload\.days\.length !== 5/);
  assert.match(runtime, /timeZone: payload\.timezone/);
  assert.doesNotMatch(runtime, /new Date\(payload\.retrievedAt\)\.toLocaleString/);
  assert.doesNotMatch(runtime, /surface_pressure/);
  assert.doesNotMatch(runtime, /calculateRomps/);
});
