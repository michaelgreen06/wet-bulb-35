import {
  hotspotCacheControl,
  hotspotSnapshotState,
  validateHotspotSnapshot,
  type HotspotSnapshot,
} from "../lib/hotspots/snapshot.ts";

export const HOTSPOT_SNAPSHOT_KEY = "inhabited-hotspots/v1/latest.json" as const;
const MAX_SNAPSHOT_BYTES = 256_000;
const CACHE_URL = "https://hotspot-cache.internal/inhabited-hotspots/v1/latest.json";

type R2ObjectLike = {
  size?: number;
  text(): Promise<string>;
};

type R2BucketLike = {
  get(key: string): Promise<R2ObjectLike | null>;
};

type AssetFetcherLike = {
  fetch(request: Request): Promise<Response>;
};

type CacheLike = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

export interface HotspotEnvironment {
  HOTSPOT_SNAPSHOTS?: R2BucketLike;
  HOTSPOT_FEATURE_MODE?: string;
  HOTSPOT_SNAPSHOT_ASSET_PATH?: string;
  ASSETS?: AssetFetcherLike;
}

export type HotspotSnapshotResult =
  | { ok: true; snapshot: HotspotSnapshot; etag: string }
  | { ok: false; status: 503; message: string };

/** Structured Worker log line that alerting can match until a valid snapshot is published. */
export function warnExpiredSnapshot(product: "inhabited" | "global-grid", snapshot: { validTo: string }): void {
  try {
    console.warn(JSON.stringify({ event: "hotspot_snapshot_expired", product, validTo: snapshot.validTo }));
  } catch {}
}

function etag(snapshot: HotspotSnapshot): string {
  return `"hotspots-${snapshot.schemaVersion}-${snapshot.generatedAt}"`;
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

async function parseSnapshotText(text: string): Promise<HotspotSnapshotResult> {
  if (new TextEncoder().encode(text).byteLength > MAX_SNAPSHOT_BYTES) {
    return { ok: false, status: 503, message: "Hotspot forecast is temporarily unavailable." };
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    return { ok: false, status: 503, message: "Hotspot forecast is temporarily unavailable." };
  }
  const validation = validateHotspotSnapshot(value);
  if (!validation.success) return { ok: false, status: 503, message: "Hotspot forecast is temporarily unavailable." };
  return { ok: true, snapshot: validation.data, etag: etag(validation.data) };
}

export async function readHotspotSnapshot(
  env: HotspotEnvironment,
  cache: CacheLike | undefined = (globalThis as unknown as { caches?: { default?: CacheLike } }).caches?.default,
): Promise<HotspotSnapshotResult> {
  const assetPath = env.HOTSPOT_SNAPSHOT_ASSET_PATH;
  if (env.HOTSPOT_FEATURE_MODE !== "enabled"
    || (!env.HOTSPOT_SNAPSHOTS && !(env.ASSETS && assetPath?.startsWith("/")))) {
    return { ok: false, status: 503, message: "Hotspot forecast is not configured." };
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
    try { object = await env.HOTSPOT_SNAPSHOTS.get(HOTSPOT_SNAPSHOT_KEY); }
    catch { return { ok: false, status: 503, message: "Hotspot forecast is temporarily unavailable." }; }
    if (!object || (Number.isFinite(object.size) && (object.size as number) > MAX_SNAPSHOT_BYTES)) {
      return { ok: false, status: 503, message: "Hotspot forecast has not been published." };
    }
    try { text = await object.text(); }
    catch { return { ok: false, status: 503, message: "Hotspot forecast is temporarily unavailable." }; }
  } else {
    let response: Response;
    try { response = await env.ASSETS!.fetch(new Request(new URL(assetPath!, CACHE_URL))); }
    catch { return { ok: false, status: 503, message: "Hotspot forecast is temporarily unavailable." }; }
    if (!response.ok) return { ok: false, status: 503, message: "Hotspot forecast has not been published." };
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_SNAPSHOT_BYTES) {
      return { ok: false, status: 503, message: "Hotspot forecast is temporarily unavailable." };
    }
    try { text = await response.text(); }
    catch { return { ok: false, status: 503, message: "Hotspot forecast is temporarily unavailable." }; }
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

export async function hotspotApiResponse(
  request: Request,
  env: HotspotEnvironment,
  cache?: CacheLike,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed." }, 405, { allow: "GET, HEAD", "cache-control": "no-store" });
  }
  const result = await readHotspotSnapshot(env, cache);
  if (!result.ok) return json({ error: result.message }, result.status, { "cache-control": "no-store" });
  const now = Date.now();
  const state = hotspotSnapshotState(result.snapshot, now);
  if (state === "expired") {
    // An ended window is never served as a current ranking; the last bounds stay visible for context.
    warnExpiredSnapshot("inhabited", result.snapshot);
    const expired = json({
      error: "The last hotspot forecast window has ended. No current ranking is available.",
      status: "expired",
      initialization: result.snapshot.discovery.initialization,
      validFrom: result.snapshot.validFrom,
      validTo: result.snapshot.validTo,
    }, 503, { "cache-control": "no-store", "retry-after": "900", "x-hotspot-snapshot-status": "expired" });
    return request.method === "HEAD" ? new Response(null, { status: 503, headers: expired.headers }) : expired;
  }
  const headers = {
    etag: result.etag,
    "cache-control": hotspotCacheControl(result.snapshot, now),
    "x-hotspot-snapshot-status": "current",
    "x-hotspot-window-state": state,
  };
  if (request.headers.get("if-none-match") === result.etag) return new Response(null, { status: 304, headers });
  const response = json(result.snapshot, 200, headers);
  return request.method === "HEAD" ? new Response(null, { status: 200, headers: response.headers }) : response;
}
