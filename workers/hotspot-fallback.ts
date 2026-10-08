// Cloudflare Cron is independent of GitHub Actions' schedule. This Worker has no HTTP handler.
const REPO = "michaelgreen06/wet-bulb-35";
const WORKFLOW_ID = 375800198;
const API = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_ID}`;
const INHABITED = "inhabited-hotspots/v1/latest.json";
const GRID = "global-grid-hotspots/v1/latest.json";
const MARKER_PREFIX = "automation/hotspot-fallback/v1/";
const MAX_BYTES = 256_000;

interface R2ObjectLike {
  size: number;
  text(): Promise<string>;
}
interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  head(key: string): Promise<unknown | null>;
  put(key: string, value: string, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
}
export interface FallbackEnv {
  HOTSPOT_SNAPSHOTS: R2BucketLike;
  GITHUB_DISPATCH_TOKEN: string;
}
interface ScheduledContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
interface InhabitedPair {
  validFrom: string;
  validTo: string;
  discovery: { initialization: string };
  counts: { published: number };
  hotspots: unknown[];
}
interface GridPair {
  model: { initialization: string; validTimeBounds: { start: string; end: string } };
  cells: unknown[];
}
export type FallbackResult = "current" | "disabled" | "already_dispatched" | "run_active" | "dispatched";

function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value)) throw new Error("invalid_snapshot_time");
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("invalid_snapshot_time");
  return time;
}

async function readJson(bucket: R2BucketLike, key: string): Promise<unknown> {
  const object = await bucket.get(key);
  if (!object || !Number.isFinite(object.size) || object.size < 1 || object.size > MAX_BYTES) throw new Error("invalid_snapshot_pair");
  return JSON.parse(await object.text());
}

export function pairedInitialization(inhabited: unknown, grid: unknown, now: Date): string {
  const a = inhabited as InhabitedPair;
  const b = grid as GridPair;
  if (!a || !b || !Array.isArray(a.hotspots) || a.hotspots.length !== 50 || a.counts?.published !== 50 ||
      !Array.isArray(b.cells) || b.cells.length !== 50) throw new Error("invalid_snapshot_pair");
  const initialization = timestamp(a.discovery?.initialization);
  const start = timestamp(a.validFrom);
  const end = timestamp(a.validTo);
  const gridInitialization = timestamp(b.model?.initialization);
  const gridStart = timestamp(b.model?.validTimeBounds?.start);
  const gridEnd = timestamp(b.model?.validTimeBounds?.end);
  if (initialization !== gridInitialization || start !== gridStart || end !== gridEnd + 3_600_000 ||
      start >= end || initialization > now.getTime() || end - start !== 86_400_000) throw new Error("invalid_snapshot_pair");
  return new Date(initialization).toISOString().slice(0, 10);
}

export async function evaluateFallback(
  env: FallbackEnv,
  now: Date = new Date(),
  request: typeof fetch = fetch,
): Promise<FallbackResult> {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid_clock");
  const today = now.toISOString().slice(0, 10);
  const [inhabited, grid] = await Promise.all([
    readJson(env.HOTSPOT_SNAPSHOTS, INHABITED),
    readJson(env.HOTSPOT_SNAPSHOTS, GRID),
  ]);
  const publishedDay = pairedInitialization(inhabited, grid, now);
  if (publishedDay >= today && timestamp((inhabited as InhabitedPair).validTo) > now.getTime()) return "current";
  const marker = `${MARKER_PREFIX}${today}.json`;
  let attempts = 0;
  let previousDispatch = 0;
  if (await env.HOTSPOT_SNAPSHOTS.head(marker)) {
    const previous = await readJson(env.HOTSPOT_SNAPSHOTS, marker) as {
      schema?: number; date?: string; dispatchedAt?: string; attempts?: number;
    };
    if (previous?.schema !== 1 || previous.date !== today ||
        (previous.attempts !== undefined && previous.attempts !== 1 && previous.attempts !== 2))
      throw new Error("invalid_dispatch_marker");
    attempts = previous.attempts ?? 1; // Legacy v1 marker recorded the first dispatch only.
    previousDispatch = timestamp(previous.dispatchedAt);
    if (previousDispatch > now.getTime()) throw new Error("invalid_dispatch_marker");
    if (attempts >= 2 || now.getTime() - previousDispatch < 15 * 60_000) return "already_dispatched";
  }
  if (!env.GITHUB_DISPATCH_TOKEN) throw new Error("missing_github_token");
  const headers = {
    Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "wetbulb35-hotspot-fallback",
  };
  // Respect the publisher's explicit emergency-off switch before any dispatch.
  const gate = await request(`https://api.github.com/repos/${REPO}/actions/variables/GLOBAL_HOTSPOTS_ENABLED`,
    { headers, redirect: "manual" });
  if (!gate.ok) throw new Error("github_gate_unavailable");
  const setting = await gate.json() as { name?: string; value?: string };
  if (setting.name !== "GLOBAL_HOTSPOTS_ENABLED" || !["true", "false"].includes(setting.value || ""))
    throw new Error("github_gate_invalid");
  if (setting.value !== "true") return "disabled";
  const runs = await request(`${API}/runs?per_page=20`, { headers, redirect: "manual" });
  if (!runs.ok) throw new Error("github_runs_unavailable");
  const body = await runs.json() as { workflow_runs?: Array<{
    event?: string; status?: string; conclusion?: string; created_at?: string;
  }> };
  if (!Array.isArray(body.workflow_runs)) throw new Error("github_runs_invalid");
  if (body.workflow_runs.some((run) =>
    ["schedule", "workflow_dispatch"].includes(run.event || "") &&
    ["requested", "queued", "pending", "waiting", "in_progress"].includes(run.status || ""))) return "run_active";
  if (attempts && !body.workflow_runs.some((run) =>
    ["schedule", "workflow_dispatch"].includes(run.event || "") && run.status === "completed" &&
    ["failure", "timed_out", "startup_failure", "cancelled"].includes(run.conclusion || "") &&
    typeof run.created_at === "string" && /^\d{4}-\d\d-\d\dT/.test(run.created_at) &&
    Date.parse(run.created_at) >= previousDispatch && Date.parse(run.created_at) <= now.getTime()))
    return "already_dispatched";
  const dispatch = await request(`${API}/dispatches`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { publish: "true" } }), redirect: "manual",
  });
  if (dispatch.status !== 204) throw new Error("github_dispatch_failed");
  // Suppress duplicates, but leave the second tick available for a verified failed publisher.
  // Never write the snapshot aliases from this dispatcher.
  await env.HOTSPOT_SNAPSHOTS.put(marker,
    JSON.stringify({ schema: 1, date: today, dispatchedAt: now.toISOString(), attempts: attempts + 1 }),
    { httpMetadata: { contentType: "application/json" } });
  return "dispatched";
}

export default {
  scheduled(_controller: unknown, env: FallbackEnv, context: ScheduledContextLike): void {
    context.waitUntil(evaluateFallback(env).then((outcome) => {
      console.log(JSON.stringify({ event: "hotspot_fallback", outcome }));
    }).catch(() => {
      // Fixed text only: never log the OAuth token, API body, location data, or upstream error.
      console.error("hotspot_fallback_failed");
      throw new Error("hotspot_fallback_failed");
    }));
  },
};
