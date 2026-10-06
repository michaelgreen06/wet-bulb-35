import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { clientRuntimeSource, pageHtml, routePathForCity } from "../lib/page-renderer.mjs";

const cities = JSON.parse(fs.readFileSync(new URL("../scripts/resolved_cities.json", import.meta.url), "utf8"));
const houstonPath = "/wetbulb-temperature/united-states/texas/houston/";
const houston = cities.find((city) => routePathForCity(city) === houstonPath);

const dates = ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"];
function payload(runs, runIds) {
  return {
    timezone: "America/Chicago",
    utcOffsetSeconds: -18_000,
    retrievedAt: Date.parse("2026-09-20T15:00:00Z"),
    runs,
    days: dates.map((date, index) => ({ date, maximumWetBulbC: 25 + index, peakLocalTime: `${date}T15:00`, runId: runIds[index] })),
  };
}

async function renderWithPayload(body) {
  const html = pageHtml(houston, { forecastEnabled: true });
  const dom = new JSDOM(html.replace('<script src="/assets/app.js" defer></script>', ""), {
    url: `https://www.wetbulb35.com${houstonPath}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15",
  });
  const requests = [];
  dom.window.fetch = async (url) => {
    requests.push(String(url));
    if (String(url).startsWith("/api/forecast")) return new dom.window.Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    return new dom.window.Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  if (!dom.window.Response) dom.window.Response = Response;
  dom.window.Date.now = () => Date.parse("2026-09-20T15:00:00Z");
  dom.window.eval(clientRuntimeSource());
  const document = dom.window.document;
  for (let attempt = 0; attempt < 50 && document.querySelectorAll("[data-forecast-days] > div").length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { document, requests };
}

test("five-day notes name the explicit IFS model on every city page", () => {
  const html = pageHtml(houston, { forecastEnabled: true });
  assert.match(html, /ECMWF IFS 0\.25° model, provided by <a href="https:\/\/open-meteo\.com\/"/);
});

test("a single confirmed run is labeled once with its initialization", async () => {
  const run = { id: "latest", model: "ecmwf_ifs025", initialization: "2026-09-20T00:00:00Z", retrievedAt: Date.parse("2026-09-20T15:00:00Z") };
  const { document, requests } = await renderWithPayload(payload([run], Array(5).fill("latest")));
  assert.ok(requests.some((url) => url === `/api/forecast?path=${encodeURIComponent(houstonPath)}`));
  assert.equal(document.querySelectorAll("[data-forecast-days] > div").length, 5);
  assert.match(document.querySelector("[data-forecast-days] > div").textContent, /Today \(remaining hours\)/);
  assert.match(document.querySelector("[data-forecast-source-notes]")?.textContent ?? "", /remaining local hours/);
  assert.equal(document.querySelector("[data-forecast-days]").textContent.includes("Latest IFS run"), false);
  assert.match(document.querySelector("[data-forecast-updated]").textContent, /Latest IFS run: initialized Sep 20, 12:00 AM UTC/);
});

test("on-view aligned forecast names the snapshot's pinned run, not the latest run", async () => {
  const run = { id: "snapshot-pinned", model: "ecmwf_ifs025", initialization: "2026-09-20T00:00:00Z", retrievedAt: Date.parse("2026-09-20T15:00:00Z") };
  const { document } = await renderWithPayload(payload([run], Array(5).fill("snapshot-pinned")));
  assert.match(document.querySelector("[data-forecast-updated]").textContent, /Top 50 snapshot's pinned IFS run: initialized Sep 20, 12:00 AM UTC/);
  assert.doesNotMatch(document.querySelector("[data-forecast-updated]").textContent, /Latest IFS run/);
});

test("today without an upcoming hourly peak keeps the first slot instead of inventing a value", async () => {
  const run = { id: "snapshot-pinned", model: "ecmwf_ifs025", initialization: "2026-09-20T00:00:00Z", retrievedAt: Date.parse("2026-09-20T15:00:00Z") };
  const body = payload([run], Array(5).fill("snapshot-pinned"));
  body.days[0].maximumWetBulbC = null;
  body.days[0].peakLocalTime = null;
  const { document } = await renderWithPayload(body);
  assert.match(document.querySelector("[data-forecast-days] > div").textContent, /No upcoming hourly peak today/);
  assert.equal(document.querySelectorAll("[data-forecast-days] > div").length, 5);
});

test("days from different runs are labeled per day and never presented as one run", async () => {
  const runs = [
    { id: "top50-pinned", model: "ecmwf_ifs025", initialization: "2026-09-19T18:00:00Z", retrievedAt: Date.parse("2026-09-20T02:10:00Z") },
    { id: "latest", model: "ecmwf_ifs025", initialization: null, retrievedAt: Date.parse("2026-09-20T15:00:00Z") },
  ];
  const { document } = await renderWithPayload(payload(runs, ["latest", "top50-pinned", "top50-pinned", "top50-pinned", "top50-pinned"]));
  const cards = [...document.querySelectorAll("[data-forecast-days] > div")].map((card) => card.textContent);
  assert.match(cards[0], /Latest IFS run/);
  assert.match(cards[1], /Top 50 hotspot run/);
  const notes = document.querySelector("[data-forecast-updated]").textContent;
  assert.match(notes, /Top 50 hotspot run: initialized Sep 19, 6:00 PM UTC/);
  assert.match(notes, /Latest IFS run: initialization time not confirmed/);
});
