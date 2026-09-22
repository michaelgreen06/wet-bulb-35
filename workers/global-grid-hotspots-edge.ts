import { z } from "zod";

export const GLOBAL_GRID_HOTSPOT_API_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600" as const;
export const GLOBAL_GRID_HOTSPOT_SNAPSHOT_KEY = "global-grid-hotspots/v1/latest.json" as const;
const MAX_SNAPSHOT_BYTES = 256_000;
const CACHE_URL = "https://global-grid-hotspots-cache.internal/v1/latest.json";

const isoUtc = z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z"), "timestamp must be UTC");
const finiteNumber = z.number().finite();
const globalGridHotspotSchema = z.object({
  rank: z.number().int().positive(),
  latitude: finiteNumber.min(-90).max(90),
  longitude: finiteNumber.min(-180).max(180),
  maximumWetBulbC: finiteNumber,
  peakTime: isoUtc,
  airTemperatureC: finiteNumber,
  dewPointC: finiteNumber,
  surfacePressureHpa: finiteNumber.positive(),
  peakStep: z.number().int().nonnegative(),
}).strict();

const rawGlobalGridSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  method: z.string().min(1),
  methodVersion: z.string().min(1),
  model: z.object({
    source: z.string().min(1),
    initialization: isoUtc,
    validTimeBounds: z.object({ start: isoUtc, end: isoUtc }).strict(),
    steps: z.array(z.number().int().nonnegative()).min(1),
    grid: z.object({ latitudeCount: z.number().int().positive(), longitudeCount: z.number().int().positive() }).strict(),
    evaluatedCellCount: z.number().int().nonnegative(),
  }).strict(),
  cells: z.array(z.object({
    latitude: finiteNumber.min(-90).max(90),
    longitude: finiteNumber.min(-360).max(360),
    wetBulbC: finiteNumber,
    temperatureC: finiteNumber,
    dewPointC: finiteNumber,
    pressurePa: finiteNumber.positive(),
    peakStep: z.number().int().nonnegative(),
    peakTime: isoUtc,
  }).strict()).min(1).max(100),
}).strict();

export const GlobalGridHotspotSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: isoUtc,
  validFrom: isoUtc,
  validTo: isoUtc,
  method: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    phase: z.literal("liquid"),
    inputs: z.tuple([z.literal("temperature_2m"), z.literal("dew_point_2m"), z.literal("surface_pressure")]),
  }).strict(),
  model: z.object({
    source: z.string().min(1),
    initialization: isoUtc,
    interval: z.literal("three-hourly"),
    resolution: z.literal("0.25°"),
    steps: z.array(z.number().int().nonnegative()).min(1),
  }).strict(),
  counts: z.object({
    gridCells: z.number().int().positive(),
    evaluatedWarmCells: z.number().int().nonnegative(),
    published: z.number().int().positive().max(100),
  }).strict(),
  hotspots: z.array(globalGridHotspotSchema).min(1).max(100),
}).strict().superRefine((snapshot, context) => {
  if (Date.parse(snapshot.generatedAt) > Date.parse(snapshot.validTo)) {
    context.addIssue({ code: "custom", message: "generatedAt must not be after validTo" });
  }
  if (Date.parse(snapshot.validFrom) >= Date.parse(snapshot.validTo)) {
    context.addIssue({ code: "custom", message: "validFrom must precede validTo" });
  }
  if (snapshot.counts.published !== snapshot.hotspots.length || snapshot.counts.evaluatedWarmCells > snapshot.counts.gridCells) {
    context.addIssue({ code: "custom", message: "snapshot counts are inconsistent" });
  }
  const coordinates = new Set<string>();
  for (let index = 0; index < snapshot.hotspots.length; index += 1) {
    const hotspot = snapshot.hotspots[index];
    if (hotspot.rank !== index + 1) context.addIssue({ code: "custom", message: "hotspot ranks must be consecutive" });
    if (!snapshot.model.steps.includes(hotspot.peakStep)) context.addIssue({ code: "custom", message: "peakStep must be a model step" });
    if (Date.parse(hotspot.peakTime) < Date.parse(snapshot.validFrom) || Date.parse(hotspot.peakTime) >= Date.parse(snapshot.validTo)) {
      context.addIssue({ code: "custom", message: "peakTime must fall inside the validity window" });
    }
    const coordinate = `${hotspot.latitude},${hotspot.longitude}`;
    if (coordinates.has(coordinate)) context.addIssue({ code: "custom", message: "published coordinates must be unique" });
    coordinates.add(coordinate);
  }
});

export type GlobalGridHotspotSnapshot = z.infer<typeof GlobalGridHotspotSnapshotSchema>;

type AssetFetcherLike = {
  fetch(request: Request): Promise<Response>;
};

type R2ObjectLike = {
  size?: number;
  text(): Promise<string>;
};

type R2BucketLike = {
  get(key: string): Promise<R2ObjectLike | null>;
};

type CacheLike = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

export interface GlobalGridHotspotEnvironment {
  GLOBAL_GRID_HOTSPOT_FEATURE_MODE?: string;
  GLOBAL_GRID_HOTSPOT_SNAPSHOT_ASSET_PATH?: string;
  HOTSPOT_SNAPSHOTS?: R2BucketLike;
  ASSETS?: AssetFetcherLike;
}

export type GlobalGridHotspotSnapshotResult =
  | { ok: true; snapshot: GlobalGridHotspotSnapshot; etag: string }
  | { ok: false; status: 503; message: string };

function etag(snapshot: GlobalGridHotspotSnapshot): string {
  return `"global-grid-hotspots-${snapshot.schemaVersion}-${snapshot.generatedAt}"`;
}

function json(payload: unknown, status: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", "x-content-type-options": "nosniff", ...headers },
  });
}

function validCachedResponse(response: Response | undefined): response is Response {
  return Boolean(response?.ok && response.headers.get("content-type")?.startsWith("application/json"));
}

function validAssetPath(pathname: string | undefined): pathname is string {
  return typeof pathname === "string"
    && /^\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pathname)
    && !pathname.split("/").includes("..");
}

async function parseSnapshotText(text: string): Promise<GlobalGridHotspotSnapshotResult> {
  if (new TextEncoder().encode(text).byteLength > MAX_SNAPSHOT_BYTES) {
    return { ok: false, status: 503, message: "Global-grid hotspot forecast is temporarily unavailable." };
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    return { ok: false, status: 503, message: "Global-grid hotspot forecast is temporarily unavailable." };
  }
  const raw = rawGlobalGridSnapshotSchema.safeParse(value);
  if (raw.success) {
    const end = new Date(Date.parse(raw.data.model.validTimeBounds.end) + 3 * 60 * 60 * 1000).toISOString();
    value = {
      schemaVersion: 1,
      generatedAt: raw.data.model.initialization,
      validFrom: raw.data.model.validTimeBounds.start,
      validTo: end,
      method: {
        name: raw.data.method,
        version: raw.data.methodVersion,
        phase: "liquid",
        inputs: ["temperature_2m", "dew_point_2m", "surface_pressure"],
      },
      model: {
        source: raw.data.model.source,
        initialization: raw.data.model.initialization,
        interval: "three-hourly",
        resolution: "0.25°",
        steps: raw.data.model.steps,
      },
      counts: {
        gridCells: raw.data.model.grid.latitudeCount * raw.data.model.grid.longitudeCount,
        evaluatedWarmCells: raw.data.model.evaluatedCellCount,
        published: raw.data.cells.length,
      },
      hotspots: raw.data.cells.map((cell, index) => ({
        rank: index + 1,
        latitude: cell.latitude,
        longitude: cell.longitude > 180 ? cell.longitude - 360 : cell.longitude,
        maximumWetBulbC: cell.wetBulbC,
        peakTime: cell.peakTime,
        airTemperatureC: cell.temperatureC,
        dewPointC: cell.dewPointC,
        surfacePressureHpa: cell.pressurePa / 100,
        peakStep: cell.peakStep,
      })),
    };
  }
  const validation = GlobalGridHotspotSnapshotSchema.safeParse(value);
  if (!validation.success) return { ok: false, status: 503, message: "Global-grid hotspot forecast is temporarily unavailable." };
  return { ok: true, snapshot: validation.data, etag: etag(validation.data) };
}

/** Reads a pre-generated R2 object or staging asset only; it never calls forecast providers. */
export async function readGlobalGridHotspotSnapshot(
  env: GlobalGridHotspotEnvironment,
  cache: CacheLike | undefined = (globalThis as unknown as { caches?: { default?: CacheLike } }).caches?.default,
): Promise<GlobalGridHotspotSnapshotResult> {
  const assetPath = env.GLOBAL_GRID_HOTSPOT_SNAPSHOT_ASSET_PATH;
  if (env.GLOBAL_GRID_HOTSPOT_FEATURE_MODE !== "enabled"
    || (!env.HOTSPOT_SNAPSHOTS && !(env.ASSETS && validAssetPath(assetPath)))) {
    return { ok: false, status: 503, message: "Global-grid hotspot forecast is not configured." };
  }
  const cacheKey = new Request(CACHE_URL);
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (validCachedResponse(cached)) return parseSnapshotText(await cached.text());
    } catch {}
  }
  let text: string;
  if (env.HOTSPOT_SNAPSHOTS) {
    let object: R2ObjectLike | null;
    try { object = await env.HOTSPOT_SNAPSHOTS.get(GLOBAL_GRID_HOTSPOT_SNAPSHOT_KEY); }
    catch { return { ok: false, status: 503, message: "Global-grid hotspot forecast is temporarily unavailable." }; }
    if (!object || (Number.isFinite(object.size) && (object.size as number) > MAX_SNAPSHOT_BYTES)) {
      return { ok: false, status: 503, message: "Global-grid hotspot forecast has not been published." };
    }
    try { text = await object.text(); }
    catch { return { ok: false, status: 503, message: "Global-grid hotspot forecast is temporarily unavailable." }; }
  } else {
    let response: Response;
    try { response = await env.ASSETS!.fetch(new Request(new URL(assetPath!, CACHE_URL))); }
    catch { return { ok: false, status: 503, message: "Global-grid hotspot forecast is temporarily unavailable." }; }
    if (!response.ok) return { ok: false, status: 503, message: "Global-grid hotspot forecast has not been published." };
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_SNAPSHOT_BYTES) {
      return { ok: false, status: 503, message: "Global-grid hotspot forecast is temporarily unavailable." };
    }
    try { text = await response.text(); }
    catch { return { ok: false, status: 503, message: "Global-grid hotspot forecast is temporarily unavailable." }; }
  }
  const parsed = await parseSnapshotText(text);
  if (parsed.ok && cache) {
    try {
      await cache.put(cacheKey, new Response(text, {
        headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "public, max-age=300" },
      }));
    } catch {}
  }
  return parsed;
}

export async function globalGridHotspotApiResponse(
  request: Request,
  env: GlobalGridHotspotEnvironment,
  cache?: CacheLike,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed." }, 405, { allow: "GET, HEAD", "cache-control": "no-store" });
  }
  const result = await readGlobalGridHotspotSnapshot(env, cache);
  if (!result.ok) return json({ error: result.message }, result.status, { "cache-control": "no-store" });
  const snapshotStatus = Date.parse(result.snapshot.validTo) <= Date.now() ? "expired" : "current";
  if (request.headers.get("if-none-match") === result.etag) {
    return new Response(null, { status: 304, headers: { etag: result.etag, "cache-control": GLOBAL_GRID_HOTSPOT_API_CACHE_CONTROL, "x-global-grid-hotspot-snapshot-status": snapshotStatus } });
  }
  const response = json(result.snapshot, 200, { etag: result.etag, "cache-control": GLOBAL_GRID_HOTSPOT_API_CACHE_CONTROL, "x-global-grid-hotspot-snapshot-status": snapshotStatus });
  return request.method === "HEAD" ? new Response(null, { status: 200, headers: response.headers }) : response;
}
