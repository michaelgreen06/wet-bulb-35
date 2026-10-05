import { z } from "zod";
import { ROMPS_METHOD, ROMPS_METHOD_VERSION } from "../forecast/romps.ts";
import {
  type HotspotPinnedDailyForecast,
  HOTSPOT_FORECAST_HOURS,
  HOTSPOT_OPEN_METEO_MODEL,
  HOTSPOT_OPEN_METEO_PROVIDER,
  type HotspotRefinement,
} from "./open-meteo.ts";

export const HOTSPOT_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const HOTSPOT_MAX_PUBLISHED_CELLS = 50 as const;

const isoUtc = z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z"), "timestamp must be UTC");
const coordinate = z.object({
  cellId: z.string().min(1).max(100),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
}).strict();
const modelCell = coordinate.extend({ elevationM: z.number().finite() }).strict();
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Daily maxima from the snapshot's own pinned IFS run; only complete local dates are kept.
const pinnedFiveDay = z.object({
  initialization: isoUtc,
  retrievedAt: isoUtc,
  timezone: z.string().min(1).max(80),
  utcOffsetSeconds: z.number().int().min(-14 * 3_600).max(14 * 3_600),
  days: z.array(z.object({
    date: localDate,
    maximumWetBulbC: z.number().finite(),
    peakLocalTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/),
  }).strict()).max(7),
}).strict();
const candidate = z.object({
  path: z.string().regex(/^\/wetbulb-temperature\/.+\/$/),
  name: z.string().min(1),
  state: z.string(),
  country: z.string().min(1),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  selectionReason: z.enum(["discovery", "excluded-control"]),
  grid: coordinate.nullable(),
}).strict();

export const HotspotSnapshotSchema = z.object({
  schemaVersion: z.literal(HOTSPOT_SNAPSHOT_SCHEMA_VERSION),
  generatedAt: isoUtc,
  validFrom: isoUtc,
  validTo: isoUtc,
  forecastHours: z.literal(HOTSPOT_FORECAST_HOURS),
  method: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    phase: z.literal("liquid"),
    inputs: z.tuple([z.literal("temperature_2m"), z.literal("dew_point_2m"), z.literal("surface_pressure")]),
  }).strict(),
  provider: z.object({
    name: z.literal(HOTSPOT_OPEN_METEO_PROVIDER),
    model: z.literal(HOTSPOT_OPEN_METEO_MODEL),
    interval: z.literal("hourly"),
  }).strict(),
  discovery: z.object({
    source: z.string().min(1),
    initialization: isoUtc,
    steps: z.array(z.number().int().nonnegative()).min(1),
    marginC: z.number().finite().nonnegative(),
    thresholdC: z.number().finite(),
    dilationRings: z.number().int().nonnegative(),
    globalLandMaximumC: z.number().finite(),
    // Recorded separately: grid retrieval completion and the first poll that saw the run usable.
    retrievedAt: isoUtc.optional(),
    firstSeenReadyAt: isoUtc.nullable().optional(),
  }).strict(),
  counts: z.object({
    corpus: z.number().int().positive(),
    candidates: z.number().int().positive(),
    discoveredCandidates: z.number().int().nonnegative(),
    excludedControls: z.number().int().nonnegative(),
    refined: z.number().int().positive(),
    uniqueModelCells: z.number().int().positive(),
    published: z.number().int().positive().max(HOTSPOT_MAX_PUBLISHED_CELLS),
  }).strict(),
  validation: z.object({
    excludedControlSample: z.number().int().nonnegative(),
    controlsInTop20: z.number().int().nonnegative().max(20),
    maxExcludedControlWetBulbC: z.number().finite().nullable(),
    recallWarning: z.boolean(),
  }).strict(),
  hotspots: z.array(candidate.extend({
    rank: z.number().int().positive(),
    modelCell,
    maximumWetBulbC: z.number().finite(),
    peakTime: isoUtc,
    airTemperatureC: z.number().finite(),
    dewPointC: z.number().finite(),
    surfacePressureHpa: z.number().finite().positive(),
    fiveDay: pinnedFiveDay.optional(),
  }).strict()).min(1).max(HOTSPOT_MAX_PUBLISHED_CELLS),
}).strict().superRefine((snapshot, context) => {
  // The window starts at the next full hour after grid retrieval; generation may finish shortly after
  // it begins. Snapshots without a recorded retrieval keep the original generatedAt rule.
  if (snapshot.discovery.retrievedAt) {
    if (Date.parse(snapshot.generatedAt) < Date.parse(snapshot.discovery.retrievedAt)
      || Date.parse(snapshot.generatedAt) >= Date.parse(snapshot.validTo)) {
      context.addIssue({ code: "custom", message: "generatedAt must follow retrieval and precede validTo" });
    }
  } else if (Date.parse(snapshot.generatedAt) >= Date.parse(snapshot.validFrom)) {
    context.addIssue({ code: "custom", message: "generatedAt must precede validFrom for a future-only forecast" });
  }
  if (Date.parse(snapshot.validFrom) >= Date.parse(snapshot.validTo)) {
    context.addIssue({ code: "custom", message: "validFrom must precede validTo" });
  }
  const initializationMs = Date.parse(snapshot.discovery.initialization);
  if (snapshot.discovery.retrievedAt
    && (Date.parse(snapshot.discovery.retrievedAt) < initializationMs
      || Date.parse(snapshot.discovery.retrievedAt) >= Date.parse(snapshot.validFrom))) {
    context.addIssue({ code: "custom", message: "retrievedAt must follow initialization and precede validFrom" });
  }
  if (snapshot.discovery.firstSeenReadyAt
    && (Date.parse(snapshot.discovery.firstSeenReadyAt) < initializationMs
      || (snapshot.discovery.retrievedAt && Date.parse(snapshot.discovery.firstSeenReadyAt) > Date.parse(snapshot.discovery.retrievedAt)))) {
    context.addIssue({ code: "custom", message: "firstSeenReadyAt must fall between initialization and retrieval" });
  }
  if (snapshot.counts.candidates !== snapshot.counts.discoveredCandidates + snapshot.counts.excludedControls
      || snapshot.counts.refined !== snapshot.counts.candidates
      || snapshot.counts.published !== snapshot.hotspots.length
      || snapshot.counts.uniqueModelCells < snapshot.counts.published
      || snapshot.validation.excludedControlSample !== snapshot.counts.excludedControls
      || snapshot.validation.recallWarning !== (snapshot.validation.controlsInTop20 > 0)) {
    context.addIssue({ code: "custom", message: "snapshot count or validation metadata is inconsistent" });
  }
  const cellIds = new Set<string>();
  for (let index = 0; index < snapshot.hotspots.length; index += 1) {
    const hotspot = snapshot.hotspots[index];
    if (hotspot.rank !== index + 1) context.addIssue({ code: "custom", message: "hotspot ranks must be consecutive" });
    if (cellIds.has(hotspot.modelCell.cellId)) context.addIssue({ code: "custom", message: "published model cells must be unique" });
    cellIds.add(hotspot.modelCell.cellId);
    if (Date.parse(hotspot.peakTime) < Date.parse(snapshot.validFrom)
      || Date.parse(hotspot.peakTime) >= Date.parse(snapshot.validTo)) {
      context.addIssue({ code: "custom", message: "peakTime must fall inside the validity window" });
    }
    const fiveDay = hotspot.fiveDay;
    if (fiveDay) {
      if (fiveDay.initialization !== snapshot.discovery.initialization) {
        context.addIssue({ code: "custom", message: "five-day data must come from the snapshot's pinned initialization" });
      }
      const dates = fiveDay.days.map((day) => day.date);
      const consecutive = dates.every((date, dayIndex) => dayIndex === 0
        || Date.parse(`${date}T00:00:00Z`) - Date.parse(`${dates[dayIndex - 1]}T00:00:00Z`) === 86_400_000);
      // A complete local date starts at or after the run initialization in that location's offset.
      const firstLocalMidnightMs = dates.length ? Date.parse(`${dates[0]}T00:00:00Z`) - fiveDay.utcOffsetSeconds * 1_000 : initializationMs;
      if (!consecutive || firstLocalMidnightMs < initializationMs
        || fiveDay.days.some((day) => day.peakLocalTime.slice(0, 10) !== day.date)) {
        context.addIssue({ code: "custom", message: "five-day data must contain consecutive complete local dates from the pinned run" });
      }
    }
  }
});

export type HotspotSnapshot = z.infer<typeof HotspotSnapshotSchema>;

export interface HotspotDiscoveryMetadata {
  source: string;
  initialization: string;
  steps: number[];
  marginC: number;
  thresholdC: number;
  dilationRings: number;
  globalLandMaximumC: number;
  retrievedAt?: string;
  firstSeenReadyAt?: string | null;
}

function compareRefinements(a: HotspotRefinement, b: HotspotRefinement): number {
  return b.maximumWetBulbC - a.maximumWetBulbC
    || a.peakTime.localeCompare(b.peakTime)
    || a.modelCell.cellId.localeCompare(b.modelCell.cellId)
    || a.candidate.path.localeCompare(b.candidate.path);
}

export function createHotspotSnapshot(input: {
  generatedAt: string;
  refinements: HotspotRefinement[];
  corpusCount: number;
  discovery: HotspotDiscoveryMetadata;
  maximumPublishedCells?: number;
}): HotspotSnapshot {
  if (!Number.isInteger(input.corpusCount) || input.corpusCount < 1) throw new TypeError("corpusCount must be positive");
  if (input.refinements.length < 1) throw new TypeError("at least one complete refinement is required");
  const maximum = input.maximumPublishedCells ?? HOTSPOT_MAX_PUBLISHED_CELLS;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > HOTSPOT_MAX_PUBLISHED_CELLS) {
    throw new TypeError(`maximumPublishedCells must be 1-${HOTSPOT_MAX_PUBLISHED_CELLS}`);
  }

  const validFrom = input.refinements[0].validFrom;
  const validTo = input.refinements[0].validTo;
  if (input.refinements.some((entry) => entry.validFrom !== validFrom || entry.validTo !== validTo)) {
    throw new TypeError("all refinements must use the same fixed 24-hour window");
  }

  const sorted = [...input.refinements].sort(compareRefinements);
  const unique: HotspotRefinement[] = [];
  const seenCells = new Set<string>();
  for (const entry of sorted) {
    if (seenCells.has(entry.modelCell.cellId)) continue;
    seenCells.add(entry.modelCell.cellId);
    unique.push(entry);
  }
  const selected = unique.slice(0, maximum);
  const controlsInTop20 = selected.slice(0, 20).filter((entry) => entry.candidate.selectionReason === "excluded-control").length;
  const excludedControls = input.refinements.filter((entry) => entry.candidate.selectionReason === "excluded-control");
  const maxExcludedControlWetBulbC = excludedControls.length
    ? Math.max(...excludedControls.map((entry) => entry.maximumWetBulbC))
    : null;
  const discoveredCandidates = input.refinements.length - excludedControls.length;

  const snapshot = {
    schemaVersion: HOTSPOT_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    validFrom,
    validTo,
    forecastHours: HOTSPOT_FORECAST_HOURS,
    method: {
      name: ROMPS_METHOD,
      version: ROMPS_METHOD_VERSION,
      phase: "liquid" as const,
      inputs: ["temperature_2m", "dew_point_2m", "surface_pressure"] as const,
    },
    provider: { name: HOTSPOT_OPEN_METEO_PROVIDER, model: HOTSPOT_OPEN_METEO_MODEL, interval: "hourly" as const },
    discovery: input.discovery,
    counts: {
      corpus: input.corpusCount,
      candidates: input.refinements.length,
      discoveredCandidates,
      excludedControls: excludedControls.length,
      refined: input.refinements.length,
      uniqueModelCells: unique.length,
      published: selected.length,
    },
    validation: {
      excludedControlSample: excludedControls.length,
      controlsInTop20,
      maxExcludedControlWetBulbC,
      recallWarning: controlsInTop20 > 0,
    },
    hotspots: selected.map((entry, index) => ({
      rank: index + 1,
      ...entry.candidate,
      modelCell: entry.modelCell,
      maximumWetBulbC: entry.maximumWetBulbC,
      peakTime: entry.peakTime,
      airTemperatureC: entry.airTemperatureC,
      dewPointC: entry.dewPointC,
      surfacePressureHpa: entry.surfacePressureHpa,
    })),
  };
  return HotspotSnapshotSchema.parse(snapshot);
}

export type HotspotSnapshotState = "upcoming" | "active" | "expired";

/** A snapshot is current only inside its original validity bounds; timestamps are never extended. */
export function hotspotSnapshotState(snapshot: { validFrom: string; validTo: string }, now = Date.now()): HotspotSnapshotState {
  if (now >= Date.parse(snapshot.validTo)) return "expired";
  return now < Date.parse(snapshot.validFrom) ? "upcoming" : "active";
}

/** Shared caches must not keep a ranking past its validity end. */
export function hotspotCacheControl(snapshot: { validTo: string }, now = Date.now()): string {
  const remaining = Math.floor((Date.parse(snapshot.validTo) - now) / 1_000);
  return remaining > 0 ? `public, max-age=${Math.min(300, remaining)}` : "no-store";
}

export function validateHotspotSnapshot(value: unknown) {
  return HotspotSnapshotSchema.safeParse(value);
}

export function isHotspotSnapshot(value: unknown): value is HotspotSnapshot {
  return validateHotspotSnapshot(value).success;
}

/** Adds pinned-run daily maxima to published locations; unmatched or empty entries are omitted. */
export function attachPinnedFiveDay(snapshot: HotspotSnapshot, pinned: readonly HotspotPinnedDailyForecast[]): HotspotSnapshot {
  const byPath = new Map(pinned.map((entry) => [entry.path, entry]));
  return HotspotSnapshotSchema.parse({
    ...snapshot,
    hotspots: snapshot.hotspots.map((hotspot) => {
      const entry = byPath.get(hotspot.path);
      if (!entry || entry.days.length === 0) return hotspot;
      return {
        ...hotspot,
        fiveDay: {
          initialization: entry.initialization,
          retrievedAt: entry.retrievedAt,
          timezone: entry.timezone,
          utcOffsetSeconds: entry.utcOffsetSeconds,
          days: entry.days.slice(0, 7).map((day) => ({ ...day })),
        },
      };
    }),
  });
}
