#!/usr/bin/env node
// Read-only public-side monitor. Run after the private pair read-back, never on page views.
import fs from "node:fs";
import { pairedRun } from "./hotspot-pair-check.mjs";
import { snapshotRun } from "./hotspot-publish-guard.mjs";

export async function checkPublicStatus({ origin, inhabited, grid, fetchImpl = fetch, now = Date.now() }) {
  const privateRun = pairedRun(inhabited, grid);
  if (privateRun.validTo <= now) throw new Error("Private hotspot pair expired");
  const base = new URL(origin);
  if (base.pathname !== "/" || base.search || base.hash || !["https:", "http:"].includes(base.protocol)) {
    throw new Error("Expected a bare HTTP(S) origin");
  }
  const products = [
    ["inhabited", "/api/inhabited-hotspots", "x-hotspot-snapshot-status", inhabited],
    ["global-grid", "/api/global-grid-hotspots", "x-global-grid-hotspot-snapshot-status", grid],
  ];
  for (const [kind, path, header, privateSnapshot] of products) {
    const response = await fetchImpl(new URL(path, base), { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200 || response.headers.get(header) !== "current") {
      throw new Error(`${kind} public API status ${response.status}, ${header}=${response.headers.get(header)}`);
    }
    const publicSnapshot = await response.json();
    const expected = snapshotRun(kind, privateSnapshot);
    const actual = snapshotRun(kind, publicSnapshot);
    if (!expected || !actual || actual.initialization !== expected.initialization ||
        actual.validFrom !== expected.validFrom || actual.validTo !== expected.validTo) {
      throw new Error(`${kind} public API does not match the private current alias`);
    }
  }
  return { initialization: new Date(privateRun.initialization).toISOString(), validTo: new Date(privateRun.validTo).toISOString() };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [inhabitedFile, gridFile, origin = "https://www.wetbulb35.com"] = process.argv.slice(2);
  if (!inhabitedFile || !gridFile) throw new Error("usage: check-hotspot-public-status.mjs INHABITED.json GRID.json [ORIGIN]");
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(JSON.stringify(await checkPublicStatus({ origin, inhabited: read(inhabitedFile), grid: read(gridFile) })));
}
