#!/usr/bin/env node
/**
 * Validates collector panel documents against lib/admin/status-contract.mjs.
 * Fails when a document is rejected or a collected field would be dropped by the projection,
 * so Python collectors and the Worker cannot drift silently. Prints only paths, never values.
 */
import fs from "node:fs";
import path from "node:path";
import { PANEL_IDS, projectPanel } from "../lib/admin/status-contract.mjs";

export function droppedFields(input, projected, prefix = "") {
  if (input === null || typeof input !== "object") return Object.is(input, projected) ? [] : [prefix || "(root)"];
  if (projected === null || typeof projected !== "object") return [prefix || "(root)"];
  return Object.keys(input).flatMap((key) => droppedFields(input[key], projected[key], prefix ? `${prefix}.${key}` : key));
}

export function validateDirectory(directory) {
  const problems = [];
  let checked = 0;
  for (const id of PANEL_IDS) {
    const file = path.join(directory, `${id}.json`);
    if (!fs.existsSync(file)) continue;
    checked += 1;
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const projected = projectPanel(id, doc);
    if (!projected) { problems.push(`${id}: rejected by contract`); continue; }
    for (const field of droppedFields(doc.data, projected.data)) problems.push(`${id}: data.${field} not preserved`);
  }
  return { checked, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.argv[2];
  if (!directory) { console.error("usage: validate-admin-status.mjs <panel-dir>"); process.exit(2); }
  const { checked, problems } = validateDirectory(directory);
  for (const problem of problems) console.error(problem);
  console.log(`checked ${checked} panel document(s); ${problems.length} problem(s)`);
  process.exit(problems.length ? 1 : 0);
}
