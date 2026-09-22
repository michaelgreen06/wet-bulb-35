#!/usr/bin/env node
/** Refine ECMWF-discovered cities with hourly Open-Meteo data and write a validated snapshot. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  HotspotProviderError,
  refineHotspotCandidates,
  type HotspotCandidate,
  type HotspotOpenMeteoOptions,
  type HotspotRefinement,
} from "../lib/hotspots/open-meteo.ts";
import {
  createHotspotSnapshot,
  validateHotspotSnapshot,
  type HotspotDiscoveryMetadata,
  type HotspotSnapshot,
} from "../lib/hotspots/snapshot.ts";

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;
type ManifestCity = Omit<HotspotCandidate, "selectionReason" | "grid">;

type CandidateDocument = {
  schemaVersion: number;
  model: { source: string; initialization: string; steps: number[] };
  selection: { marginC: number; thresholdC: number; dilationRings: number };
  globalLandMaximum: { wetBulbC: number };
  cities: Array<ManifestCity & { gridCell: { latitude: number; longitude: number } }>;
};

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isoUtc(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && Number.isFinite(Date.parse(value));
}
function cellId(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}:${longitude.toFixed(4)}`;
}

export function fixedHourlyWindow(initialization: string): { startHour: string; endHour: string } {
  const initializationMs = Date.parse(initialization);
  if (!Number.isFinite(initializationMs)) throw new TypeError("Hotspot model initialization must be a valid timestamp.");
  // The daily 06Z product publishes after dissemination, so its stable
  // next-24-hour window starts at 14Z (lead hour 8) on every rerun.
  const startMs = initializationMs + 8 * 3_600_000;
  const endMs = startMs + 23 * 3_600_000;
  const format = (value: number) => `${new Date(value).toISOString().slice(0, 13)}:00`;
  return { startHour: format(startMs), endHour: format(endMs) };
}

export function assertDiscoveryCoversWindow(
  discovery: HotspotDiscoveryMetadata,
  window: { startHour: string; endHour: string },
): void {
  const initializationMs = Date.parse(discovery.initialization);
  const startMs = Date.parse(`${window.startHour}:00Z`);
  const validToMs = Date.parse(`${window.endHour}:00Z`) + 3_600_000;
  const minimumStep = Math.min(...discovery.steps);
  const maximumStep = Math.max(...discovery.steps);
  const discoveryFromMs = initializationMs + minimumStep * 3_600_000;
  const discoveryToMs = initializationMs + maximumStep * 3_600_000;
  if (!Number.isFinite(initializationMs) || discoveryFromMs > startMs || discoveryToMs < validToMs) {
    throw new RangeError("ECMWF discovery does not cover the complete fixed hourly refinement window.");
  }
}
function validCity(raw: unknown): raw is ManifestCity {
  return isRecord(raw)
    && typeof raw.path === "string" && /^\/wetbulb-temperature\/.+\/$/.test(raw.path)
    && typeof raw.name === "string" && raw.name.length > 0
    && typeof raw.state === "string"
    && typeof raw.country === "string" && raw.country.length > 0
    && finiteNumber(raw.latitude) && raw.latitude >= -90 && raw.latitude <= 90
    && finiteNumber(raw.longitude) && raw.longitude >= -180 && raw.longitude <= 180;
}

export function parseCityManifest(value: unknown): ManifestCity[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(validCity)) {
    throw new TypeError("Hotspot city manifest is invalid.");
  }
  if (new Set(value.map((city) => city.path)).size !== value.length) {
    throw new TypeError("Hotspot city manifest paths must be unique.");
  }
  return value.map((city) => ({ ...city }));
}

export function parseCandidateDocument(value: unknown): { candidates: HotspotCandidate[]; discovery: HotspotDiscoveryMetadata } {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.model) || !isRecord(value.selection)
    || !isRecord(value.globalLandMaximum) || !Array.isArray(value.cities)) {
    throw new TypeError("ECMWF hotspot candidate document is invalid.");
  }
  const model = value.model;
  const selection = value.selection;
  const dilationRings = selection.dilationRings;
  if (typeof model.source !== "string" || typeof model.initialization !== "string" || !isoUtc(model.initialization)
    || !Array.isArray(model.steps) || !model.steps.every((step) => Number.isInteger(step) && Number(step) >= 0)
    || !finiteNumber(selection.marginC) || selection.marginC < 0
    || !finiteNumber(selection.thresholdC) || !finiteNumber(dilationRings) || !Number.isInteger(dilationRings) || dilationRings < 0
    || !finiteNumber(value.globalLandMaximum.wetBulbC)) {
    throw new TypeError("ECMWF hotspot discovery metadata is invalid.");
  }
  const candidates = value.cities.map((raw, index) => {
    const gridCell = isRecord(raw) ? raw.gridCell : undefined;
    if (!validCity(raw) || !isRecord(gridCell)
      || !finiteNumber(gridCell.latitude) || !finiteNumber(gridCell.longitude)) {
      throw new TypeError(`ECMWF hotspot candidate ${index} is invalid.`);
    }
    return {
      path: raw.path,
      name: raw.name,
      state: raw.state,
      country: raw.country,
      latitude: raw.latitude,
      longitude: raw.longitude,
      selectionReason: "discovery" as const,
      grid: {
        cellId: cellId(gridCell.latitude, gridCell.longitude),
        latitude: gridCell.latitude,
        longitude: gridCell.longitude,
      },
    } satisfies HotspotCandidate;
  });
  if (candidates.length === 0 || new Set(candidates.map((candidate) => candidate.path)).size !== candidates.length) {
    throw new TypeError("ECMWF hotspot candidates must be nonempty with unique paths.");
  }
  return {
    candidates,
    discovery: {
      source: model.source,
      initialization: model.initialization,
      steps: [...model.steps] as number[],
      marginC: selection.marginC,
      thresholdC: selection.thresholdC,
      dilationRings,
      globalLandMaximumC: value.globalLandMaximum.wetBulbC,
    },
  };
}

export function selectExcludedControls(
  manifest: readonly ManifestCity[],
  discovered: readonly HotspotCandidate[],
  initialization: string,
  sampleSize: number,
): HotspotCandidate[] {
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 0) throw new TypeError("Excluded control sample size must be nonnegative.");
  const discoveredPaths = new Set(discovered.map((candidate) => candidate.path));
  return manifest
    .filter((city) => !discoveredPaths.has(city.path))
    .map((city) => ({
      city,
      hash: createHash("sha256").update(`${initialization}\0${city.path}`).digest("hex"),
    }))
    .sort((a, b) => a.hash.localeCompare(b.hash) || a.city.path.localeCompare(b.city.path))
    .slice(0, sampleSize)
    .map(({ city }) => ({ ...city, selectionReason: "excluded-control" as const, grid: null }));
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size <= 0) throw new TypeError("Hotspot batch size must be a positive integer.");
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}
async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function refineAllHotspotCandidates({
  candidates,
  batchSize = 100,
  attempts = 4,
  interBatchDelayMs = 20_000,
  fetchImplementation = fetch,
  options = {},
}: {
  candidates: readonly HotspotCandidate[];
  batchSize?: number;
  attempts?: number;
  interBatchDelayMs?: number;
  fetchImplementation?: FetchImplementation;
  options?: HotspotOpenMeteoOptions;
}): Promise<HotspotRefinement[]> {
  if (!Number.isSafeInteger(attempts) || attempts <= 0 || attempts > 5) throw new TypeError("Hotspot attempts must be between one and five.");
  if (!Number.isSafeInteger(interBatchDelayMs) || interBatchDelayMs < 0 || interBatchDelayMs > 60_000) throw new TypeError("Hotspot inter-batch delay is invalid.");
  const refinements: HotspotRefinement[] = [];
  const batches = chunk(candidates, batchSize);
  for (const [batchIndex, batch] of batches.entries()) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        refinements.push(...await refineHotspotCandidates(batch, fetchImplementation, options));
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          const providerDelay = error instanceof HotspotProviderError && error.status === 429
            ? (error.retryAfterMs ?? 15 * 60_000)
            : 0;
          await wait(Math.max(providerDelay, 2_000 * 2 ** (attempt - 1)));
        }
      }
    }
    if (lastError) throw new Error(`Hotspot refinement batch ${batchIndex + 1} failed after ${attempts} attempts.`, { cause: lastError });
    if (batchIndex < batches.length - 1 && interBatchDelayMs > 0) await wait(interBatchDelayMs);
  }
  return refinements;
}

export async function generateHotspotSnapshot({
  candidateDocument,
  cityManifest,
  batchSize,
  dailyLocationLimit,
  excludedControlSampleSize,
  interBatchDelayMs = 20_000,
  fetchImplementation = fetch,
  options,
  generatedAt = new Date().toISOString().replace(".000Z", "Z"),
}: {
  candidateDocument: unknown;
  cityManifest: unknown;
  batchSize: number;
  dailyLocationLimit: number;
  excludedControlSampleSize: number;
  interBatchDelayMs?: number;
  fetchImplementation?: FetchImplementation;
  options: HotspotOpenMeteoOptions;
  generatedAt?: string;
}): Promise<HotspotSnapshot> {
  const parsed = parseCandidateDocument(candidateDocument);
  const manifest = parseCityManifest(cityManifest);
  const controls = selectExcludedControls(manifest, parsed.candidates, parsed.discovery.initialization, excludedControlSampleSize);
  const candidates = [...parsed.candidates, ...controls];
  if (!Number.isSafeInteger(dailyLocationLimit) || dailyLocationLimit <= 0 || candidates.length > dailyLocationLimit) {
    throw new RangeError("Hotspot candidate and validation-control count exceeds the configured daily location limit.");
  }
  const window = fixedHourlyWindow(parsed.discovery.initialization);
  assertDiscoveryCoversWindow(parsed.discovery, window);
  const refinements = await refineAllHotspotCandidates({
    candidates,
    batchSize,
    interBatchDelayMs,
    fetchImplementation,
    options: { ...options, ...window, modelInitialization: parsed.discovery.initialization },
  });
  return createHotspotSnapshot({ generatedAt, refinements, corpusCount: manifest.length, discovery: parsed.discovery });
}

function parseArgs(argv = process.argv.slice(2)): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Invalid argument: ${argument}`);
    const equals = argument.indexOf("=");
    if (equals >= 0) {
      args.set(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    args.set(argument.slice(2), value);
    index += 1;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const candidatePath = args.get("candidates");
  const manifestPath = args.get("city-manifest");
  const outputPath = args.get("output");
  if (!candidatePath || !manifestPath || !outputPath) {
    throw new Error("usage: node --experimental-strip-types scripts/generate-inhabited-hotspot-snapshot.ts --candidates FILE --city-manifest FILE --output FILE");
  }
  const providerMode = process.env.OPEN_METEO_API_MODE?.trim();
  const providerApiKey = process.env.OPEN_METEO_API_KEY?.trim();
  if (providerMode !== "public-noncommercial" && providerMode !== "customer-commercial") {
    throw new Error("OPEN_METEO_API_MODE must explicitly approve public-noncommercial or customer-commercial use.");
  }
  if (providerMode === "customer-commercial" && !providerApiKey) throw new Error("Customer Open-Meteo refinement requires OPEN_METEO_API_KEY.");
  const options: HotspotOpenMeteoOptions = {
    baseUrl: process.env.OPEN_METEO_BASE_URL?.trim()
      || (providerMode === "customer-commercial" ? "https://customer-single-runs-api.open-meteo.com/v1/forecast" : undefined),
    apiKey: providerMode === "customer-commercial" ? providerApiKey : undefined,
    timeoutMs: Number(process.env.HOTSPOT_OPEN_METEO_TIMEOUT_MS) || 30_000,
  };
  const candidateDocument = JSON.parse(fs.readFileSync(path.resolve(candidatePath), "utf8"));
  const cityManifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
  const snapshot = await generateHotspotSnapshot({
    candidateDocument,
    cityManifest,
    batchSize: Number(args.get("batch-size") ?? process.env.HOTSPOT_BATCH_SIZE) || 100,
    dailyLocationLimit: Number(process.env.HOTSPOT_DAILY_LOCATION_LIMIT) || 5_000,
    excludedControlSampleSize: Number(args.get("excluded-control-sample") ?? process.env.HOTSPOT_EXCLUDED_SAMPLE_SIZE) || 100,
    interBatchDelayMs: Number(args.get("inter-batch-delay-ms") ?? process.env.HOTSPOT_INTER_BATCH_DELAY_MS) || 20_000,
    options,
    generatedAt: args.get("generated-at") ?? new Date().toISOString().replace(".000Z", "Z"),
  });
  const validation = validateHotspotSnapshot(snapshot);
  if (!validation.success) throw new TypeError(`Hotspot snapshot validation failed: ${validation.error.message}`);
  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  const temporary = `${resolvedOutput}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  fs.renameSync(temporary, resolvedOutput);
  console.log(JSON.stringify({
    corpus: snapshot.counts.corpus,
    candidates: snapshot.counts.candidates,
    controls: snapshot.counts.excludedControls,
    recallWarning: snapshot.validation.recallWarning,
    refined: snapshot.counts.refined,
    published: snapshot.counts.published,
    output: resolvedOutput,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error && messages.length < 4) {
      messages.push(current.message);
      current = current.cause;
    }
    console.error(messages.join(" Caused by: "));
    process.exitCode = 1;
  });
}
