#!/usr/bin/env node
import fs from "node:fs";
import { snapshotRun } from "./hotspot-publish-guard.mjs";

export function pairedRun(inhabited, grid) {
  const a = snapshotRun("inhabited", inhabited);
  const b = snapshotRun("global-grid", grid);
  // Grid bounds are native three-hourly *source* steps bracketing the city's
  // hourly 24-hour window, not the identical first/last hourly valid times.
  if (!a || !b || a.initialization !== b.initialization || b.validFrom > a.validFrom || b.validTo < a.validTo) {
    throw new Error("Inhabited and grid latest aliases must share initialization and grid coverage must contain the inhabited window");
  }
  return a;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) throw new Error("usage: hotspot-pair-check.mjs INHABITED.json GRID.json");
  console.log(JSON.stringify(pairedRun(JSON.parse(fs.readFileSync(a, "utf8")), JSON.parse(fs.readFileSync(b, "utf8")))));
}
