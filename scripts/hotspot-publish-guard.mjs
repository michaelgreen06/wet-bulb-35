#!/usr/bin/env node
/**
 * Latest-pointer guard for hotspot snapshots. Run under the workflow's single concurrency group,
 * it compares a validated candidate with the currently published latest object so late retries
 * never replace a newer run and published timestamps are never extended.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function time(value) {
  return typeof value === "string" && ISO_UTC.test(value) ? Date.parse(value) : Number.NaN;
}

/** Initialization and validity bounds for either product's published document format. */
export function snapshotRun(kind, document) {
  if (!document || typeof document !== "object") return null;
  let run;
  if (kind === "inhabited") {
    run = { initialization: document.discovery?.initialization, validFrom: document.validFrom, validTo: document.validTo };
  } else if (kind === "global-grid") {
    const model = document.model ?? {};
    if (model.validTimeBounds) {
      const steps = Array.isArray(model.steps) ? model.steps : [];
      const hourly = steps.length > 1 && steps.every((step, index) => index === 0 || step === steps[index - 1] + 1);
      const end = time(model.validTimeBounds.end);
      run = {
        initialization: model.initialization,
        validFrom: model.validTimeBounds.start,
        validTo: Number.isFinite(end) ? new Date(end + (hourly ? 1 : 3) * 3_600_000).toISOString().replace(".000Z", "Z") : undefined,
      };
    } else {
      run = { initialization: model.initialization, validFrom: document.validFrom, validTo: document.validTo };
    }
  } else {
    throw new TypeError(`Unknown hotspot product: ${kind}`);
  }
  const [initialization, validFrom, validTo] = [run.initialization, run.validFrom, run.validTo].map(time);
  if (![initialization, validFrom, validTo].every(Number.isFinite) || validFrom >= validTo || initialization > validFrom) return null;
  return { initialization, validFrom, validTo };
}

export function publishDecision({ kind, candidate, current, now = Date.now() }) {
  const next = snapshotRun(kind, candidate);
  if (!next) return { publish: false, reason: "candidate-invalid" };
  if (next.validTo <= now) return { publish: false, reason: "candidate-expired" };
  const published = current === null || current === undefined ? null : snapshotRun(kind, current);
  if (!published) return { publish: true, reason: "no-valid-current" };
  if (next.initialization < published.initialization) return { publish: false, reason: "older-run" };
  if (next.initialization > published.initialization) return { publish: true, reason: "newer-run" };
  // The same run may start a new future window only after the published window has ended.
  if (now >= published.validTo && next.validFrom >= published.validTo) return { publish: true, reason: "same-run-after-expiry" };
  return { publish: false, reason: "same-run-current" };
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function main(argv = process.argv.slice(2)) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index].replace(/^--/, ""), argv[index + 1]);
  const kind = args.get("kind");
  const candidateFile = args.get("candidate");
  if (!kind || !candidateFile) throw new Error("usage: hotspot-publish-guard.mjs --kind inhabited|global-grid --candidate FILE [--current FILE]");
  const decision = publishDecision({ kind, candidate: readJson(path.resolve(candidateFile)), current: readJson(args.get("current") && path.resolve(args.get("current"))) });
  console.log(JSON.stringify({ kind, ...decision }));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `publish=${decision.publish}\nreason=${decision.reason}\n`);
  if (decision.reason === "candidate-invalid" || decision.reason === "candidate-expired") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
