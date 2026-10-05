import assert from "node:assert/strict";
import test from "node:test";
import { checkPublicStatus } from "../scripts/check-hotspot-public-status.mjs";

const initialization = "2026-10-05T00:00:00Z";
const inhabited = { discovery: { initialization }, validFrom: "2026-10-05T10:00:00Z", validTo: "2026-10-06T10:00:00Z" };
const grid = { model: { initialization, steps: [9, 12], validTimeBounds: { start: "2026-10-05T09:00:00Z", end: "2026-10-06T12:00:00Z" } } };
const now = Date.parse("2026-10-05T11:00:00Z");
function responder({ publicInhabited = inhabited, publicGrid = grid, status = 200, header = "current" } = {}) {
  const visited = [];
  const fetchImpl = async (url, options) => {
    visited.push(new URL(url).pathname);
    assert.equal(options.headers["cache-control"], "no-cache");
    const isGrid = visited.at(-1) === "/api/global-grid-hotspots";
    return new Response(JSON.stringify(isGrid ? publicGrid : publicInhabited), {
      status,
      headers: { [isGrid ? "x-global-grid-hotspot-snapshot-status" : "x-hotspot-snapshot-status"]: header },
    });
  };
  return { visited, fetchImpl };
}
const inputs = { origin: "https://www.wetbulb35.com", inhabited, grid, now };

test("read-only public monitor verifies both product endpoints against private aliases", async () => {
  const { visited, fetchImpl } = responder();
  const result = await checkPublicStatus({ ...inputs, fetchImpl });
  assert.equal(result.initialization, new Date(initialization).toISOString());
  assert.deepEqual(visited, ["/api/inhabited-hotspots", "/api/global-grid-hotspots"]);
});

test("monitor rejects expired private pair without requesting public endpoints", async () => {
  const { visited, fetchImpl } = responder();
  await assert.rejects(checkPublicStatus({ ...inputs, fetchImpl, now: Date.parse("2026-10-06T10:00:00Z") }), /expired/);
  assert.deepEqual(visited, []);
});

test("monitor rejects stale public alias and unhealthy product header/status", async () => {
  const stale = responder({ publicGrid: { model: { ...grid.model, initialization: "2026-10-04T18:00:00Z" } } });
  await assert.rejects(checkPublicStatus({ ...inputs, fetchImpl: stale.fetchImpl }), /global-grid public API does not match/);
  const unhealthy = responder({ status: 503, header: "expired" });
  await assert.rejects(checkPublicStatus({ ...inputs, fetchImpl: unhealthy.fetchImpl }), /inhabited public API status 503/);
  const mismatchedWindow = responder({ publicInhabited: { ...inhabited, validTo: "2026-10-06T09:00:00Z" } });
  await assert.rejects(checkPublicStatus({ ...inputs, fetchImpl: mismatchedWindow.fetchImpl }), /inhabited public API does not match/);
});
