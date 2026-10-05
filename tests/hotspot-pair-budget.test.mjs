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

test("daily shared Open-Meteo ceiling separates existing refinement from on-view city forecasts, without publication prefetch", () => {
  assert.equal(calculateDailyBudget({ locations: 1500 }), 6500);
  assert.equal(calculateDailyBudget({ locations: 2000 }), 8000);
  assert.throws(() => calculateDailyBudget({ locations: -1 }), /nonnegative/);
});

test("scheduled cap accommodates the observed 1515 and counts bounded readiness probes", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/global-inhabited-hotspots.yml", import.meta.url), "utf8");
  assert.match(workflow, /HOTSPOT_RUN_LOCATION_LIMIT: "2000"/);
  assert.ok(2000 >= 1515);
  const source = fs.readFileSync(new URL("../scripts/hotspot-provider-budget.mjs", import.meta.url), "utf8");
  assert.match(source, /readinessPointAttempts = 60/);
  assert.equal(calculateDailyBudget({ locations: 2000 }) + 60, 8060);
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

test("manual publication also requires the repository enable switch", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/global-inhabited-hotspots.yml", import.meta.url), "utf8");
  assert.match(workflow, /PUBLISH_INTENDED:\s*\$\{\{ vars\.GLOBAL_HOTSPOTS_ENABLED == 'true' && \(github\.event_name == 'schedule' \|\| inputs\.publish\) \}\}/);
  const refuse = workflow.indexOf("Refuse manual publication while the repository gate is off");
  const checkout = workflow.indexOf("actions/checkout@");
  assert.ok(refuse >= 0 && refuse < checkout, "refusal must precede checkout and provider work");
  assert.match(workflow, /if: github\.event_name == 'workflow_dispatch' && inputs\.publish && vars\.GLOBAL_HOTSPOTS_ENABLED != 'true'/);
});
