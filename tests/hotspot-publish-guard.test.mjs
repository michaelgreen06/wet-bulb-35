import assert from "node:assert/strict";
import test from "node:test";
import { publishDecision, snapshotRun } from "../scripts/hotspot-publish-guard.mjs";

const inhabited = (initialization, validFrom, validTo) => ({ discovery: { initialization }, validFrom, validTo });
const grid = (initialization, start, end, steps) => ({ model: { initialization, validTimeBounds: { start, end }, steps } });
const at = (value) => Date.parse(value);

test("reads both products' initialization and exclusive validity end", () => {
  assert.deepEqual(snapshotRun("inhabited", inhabited("2026-10-04T06:00:00Z", "2026-10-04T14:00:00Z", "2026-10-05T14:00:00Z")), {
    initialization: at("2026-10-04T06:00:00Z"), validFrom: at("2026-10-04T14:00:00Z"), validTo: at("2026-10-05T14:00:00Z"),
  });
  const hourly = Array.from({ length: 24 }, (_, index) => index + 8);
  assert.equal(snapshotRun("global-grid", grid("2026-10-04T06:00:00Z", "2026-10-04T14:00:00Z", "2026-10-05T13:00:00Z", hourly)).validTo, at("2026-10-05T14:00:00Z"));
  assert.equal(snapshotRun("inhabited", { validFrom: "x" }), null);
});

test("publishes a newer run and the first snapshot", () => {
  const now = at("2026-10-04T14:00:00Z");
  const candidate = inhabited("2026-10-04T06:00:00Z", "2026-10-04T15:00:00Z", "2026-10-05T15:00:00Z");
  assert.deepEqual(publishDecision({ kind: "inhabited", candidate, current: null, now }), { publish: true, reason: "no-valid-current" });
  const current = inhabited("2026-10-04T00:00:00Z", "2026-10-04T09:00:00Z", "2026-10-05T09:00:00Z");
  assert.deepEqual(publishDecision({ kind: "inhabited", candidate, current, now }), { publish: true, reason: "newer-run" });
});

test("a late retry of an older run never overwrites a newer published run", () => {
  const now = at("2026-10-04T22:00:00Z");
  const late = inhabited("2026-10-04T06:00:00Z", "2026-10-04T23:00:00Z", "2026-10-05T23:00:00Z");
  const newer = inhabited("2026-10-04T12:00:00Z", "2026-10-04T20:00:00Z", "2026-10-05T20:00:00Z");
  assert.deepEqual(publishDecision({ kind: "inhabited", candidate: late, current: newer, now }), { publish: false, reason: "older-run" });
});

test("the same run is republished for a new future window only after the published window ended", () => {
  const current = inhabited("2026-10-04T06:00:00Z", "2026-10-04T14:00:00Z", "2026-10-05T14:00:00Z");
  const renewed = inhabited("2026-10-04T06:00:00Z", "2026-10-05T15:00:00Z", "2026-10-06T15:00:00Z");
  assert.equal(publishDecision({ kind: "inhabited", candidate: renewed, current, now: at("2026-10-05T10:00:00Z") }).reason, "same-run-current");
  assert.deepEqual(publishDecision({ kind: "inhabited", candidate: renewed, current, now: at("2026-10-05T14:30:00Z") }), { publish: true, reason: "same-run-after-expiry" });
});

test("rejects invalid or already-expired candidates and ignores an unreadable current object", () => {
  const now = at("2026-10-06T00:00:00Z");
  const expired = inhabited("2026-10-04T06:00:00Z", "2026-10-04T14:00:00Z", "2026-10-05T14:00:00Z");
  assert.equal(publishDecision({ kind: "inhabited", candidate: expired, current: null, now }).reason, "candidate-expired");
  assert.equal(publishDecision({ kind: "inhabited", candidate: {}, current: null, now }).reason, "candidate-invalid");
  const fresh = inhabited("2026-10-05T18:00:00Z", "2026-10-06T02:00:00Z", "2026-10-07T02:00:00Z");
  assert.equal(publishDecision({ kind: "inhabited", candidate: fresh, current: { garbage: true }, now }).reason, "no-valid-current");
});

test("guards the global-grid product independently", () => {
  const steps = Array.from({ length: 24 }, (_, index) => index + 8);
  const current = grid("2026-10-04T12:00:00Z", "2026-10-04T20:00:00Z", "2026-10-05T19:00:00Z", steps);
  const older = grid("2026-10-04T06:00:00Z", "2026-10-04T23:00:00Z", "2026-10-05T22:00:00Z", Array.from({ length: 24 }, (_, index) => index + 17));
  assert.equal(publishDecision({ kind: "global-grid", candidate: older, current, now: at("2026-10-04T22:00:00Z") }).reason, "older-run");
});
