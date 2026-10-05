import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { calculateDailyBudget } from "../scripts/hotspot-provider-budget.mjs";
import { pairedRun } from "../scripts/hotspot-pair-check.mjs";

const start = "2026-10-05T00:00:00Z";
const from = "2026-10-05T10:00:00Z";
const end = "2026-10-06T10:00:00Z";
const inhabited = { discovery: { initialization: start }, validFrom: from, validTo: end };
const grid = { model: { initialization: start, validTimeBounds: { start: "2026-10-05T09:00:00Z", end: "2026-10-06T12:00:00Z" }, steps: [9, 12, 15] } };

test("daily shared Open-Meteo budget includes forecast Worker and worst-case retry attempts, not OpenWeather", () => {
  assert.equal(calculateDailyBudget({ locations: 1500 }), 6650);
  assert.equal(calculateDailyBudget({ locations: 2000 }), 8150);
  assert.throws(() => calculateDailyBudget({ locations: -1 }), /nonnegative/);
});

test("the two current aliases share the same initialization and exclusive window", () => {
  assert.equal(pairedRun(inhabited, grid).validTo, Date.parse(end));
  assert.throws(() => pairedRun(inhabited, { model: { ...grid.model, initialization: "2026-10-05T06:00:00Z" } }), /share/);
  assert.throws(() => pairedRun(inhabited, { model: { ...grid.model, validTimeBounds: { ...grid.model.validTimeBounds, start: "2026-10-05T11:00:00Z" } } }), /share/);
  assert.throws(() => pairedRun(inhabited, null), /share/);
});

test("scheduled publication checks both existing aliases as a pair before provider work", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/global-inhabited-hotspots.yml", import.meta.url), "utf8");
  const read = workflow.indexOf("Read the currently published snapshots");
  const pair = workflow.indexOf("pairedRun(inhabited, grid)");
  const missing = workflow.indexOf("Boolean(inhabited) !== Boolean(grid)");
  const readiness = workflow.indexOf("Wait for the newest usable IFS cycle");
  assert.ok(read >= 0 && read < missing && missing < pair && pair < readiness);
});
