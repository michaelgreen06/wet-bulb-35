#!/usr/bin/env bash
# Independent remote read-back: detects split pointers after a crash, not just
# the workflow's locally cached copies. No remote writes or provider requests.
set -Eeuo pipefail
: "${HOTSPOT_R2_BUCKET:?required}"
mkdir -p .hotspots
npx wrangler r2 object get "$HOTSPOT_R2_BUCKET/inhabited-hotspots/v1/latest.json" --file=.hotspots/monitor-inhabited.json --remote
npx wrangler r2 object get "$HOTSPOT_R2_BUCKET/global-grid-hotspots/v1/latest.json" --file=.hotspots/monitor-global-grid.json --remote
node scripts/hotspot-pair-check.mjs .hotspots/monitor-inhabited.json .hotspots/monitor-global-grid.json
node --input-type=module -e '
import fs from "node:fs";
import { pairedRun } from "./scripts/hotspot-pair-check.mjs";
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const pair = pairedRun(read(".hotspots/monitor-inhabited.json"), read(".hotspots/monitor-global-grid.json"));
if (pair.validTo <= Date.now()) throw new Error("Both remote hotspot snapshots expired; pages must show unavailable");
'
