import { describe, it, expect, vi } from "vitest";
import fallbackWorker, { evaluateFallback, pairedInitialization, type FallbackEnv } from "../workers/hotspot-fallback.ts";

const TODAY = new Date("2026-10-07T11:45:00Z");
function pair(run = "2026-10-06T06:00:00Z", start = "2026-10-06T14:00:00Z") {
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const lastHour = new Date(Date.parse(end) - 3_600_000).toISOString();
  return [
    { discovery: { initialization: run }, validFrom: start, validTo: end,
      counts: { published: 50 }, hotspots: Array.from({ length: 50 }, (_, i) => i) },
    { model: { initialization: run, validTimeBounds: { start, end: lastHour } },
      cells: Array.from({ length: 50 }, (_, i) => i) },
  ] as const;
}
function fixture(snapshots: readonly unknown[] = pair(), token = "fake-token") {
  const marker = new Map<string, string>();
  const get = vi.fn(async (key: string) => {
    const value = key.startsWith("inhabited-") ? snapshots[0] : key.startsWith("global-grid-") ? snapshots[1] : null;
    if (!value) return null;
    const text = JSON.stringify(value);
    return { size: text.length, text: async () => text };
  });
  const head = vi.fn(async (key: string) => marker.has(key) ? { key } : null);
  const put = vi.fn(async (key: string, value: string) => { marker.set(key, value); return {}; });
  const env = { HOTSPOT_SNAPSHOTS: { get, head, put }, GITHUB_DISPATCH_TOKEN: token } as unknown as FallbackEnv;
  return { env, get, head, put, marker };
}
function github(runs: Array<{ event: string; status: string }> = [], fail?: number) {
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/runs?per_page=20")) return Response.json({ workflow_runs: runs });
    if (url.endsWith("/dispatches")) return fail
      ? Response.json({ message: "Denied" }, { status: fail })
      : new Response(null, { status: 204 });
    throw new Error("Unexpected URL");
  });
  return { request: request as unknown as typeof fetch, calls: request };
}

describe("independent hotspot fallback", () => {
  it("does nothing if today's paired run is already published", async () => {
    const f = fixture(pair("2026-10-07T00:00:00Z", "2026-10-07T12:00:00Z"));
    const h = github();
    expect(await evaluateFallback(f.env, TODAY, h.request)).toBe("current");
    expect(f.head).not.toHaveBeenCalled();
    expect(h.calls).not.toHaveBeenCalled();
  });

  it("dispatches the approved main workflow once, with explicit publication and a private marker", async () => {
    const f = fixture(); const h = github();
    expect(await evaluateFallback(f.env, TODAY, h.request)).toBe("dispatched");
    expect(h.calls).toHaveBeenCalledTimes(2);
    const [url, init] = h.calls.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/michaelgreen06/wet-bulb-35/actions/workflows/375800198/dispatches");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toEqual({ ref: "main", inputs: { publish: "true" } });
    expect([...f.marker.keys()]).toEqual(["automation/hotspot-fallback/v1/2026-10-07.json"]);
    expect(f.put.mock.calls[0][0]).not.toContain("/latest.json");
    expect(await evaluateFallback(f.env, TODAY, h.request)).toBe("already_dispatched");
    expect(h.calls).toHaveBeenCalledTimes(2);
  });

  it("does not race an active scheduled or manual publisher", async () => {
    for (const event of ["schedule", "workflow_dispatch"]) {
      const f = fixture(); const h = github([{ event, status: "in_progress" }]);
      expect(await evaluateFallback(f.env, TODAY, h.request)).toBe("run_active");
      expect(h.calls).toHaveBeenCalledTimes(1);
      expect(f.put).not.toHaveBeenCalled();
    }
  });

  it("rejects split, incomplete, or malformed snapshot pairs without provider work", async () => {
    const valid = pair();
    const broken = [valid[0], { ...valid[1], model: { ...valid[1].model, initialization: "2026-10-06T00:00:00Z" } }];
    const short = [{ ...valid[0], hotspots: [1] }, valid[1]];
    const h = github();
    for (const snapshots of [broken, short, [valid[0], null]]) {
      const f = fixture(snapshots);
      await expect(evaluateFallback(f.env, TODAY, h.request)).rejects.toThrow("invalid_snapshot_pair");
      expect(f.put).not.toHaveBeenCalled();
    }
    expect(h.calls).not.toHaveBeenCalled();
  });

  it("fails closed on GitHub errors and leaves the retry slot available", async () => {
    const f = fixture(); const h = github([], 403);
    await expect(evaluateFallback(f.env, TODAY, h.request)).rejects.toThrow("github_dispatch_failed");
    expect(f.put).not.toHaveBeenCalled();
    const other = fixture();
    const denied = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    await expect(evaluateFallback(other.env, TODAY, denied)).rejects.toThrow("github_runs_unavailable");
    expect(other.put).not.toHaveBeenCalled();
  });

  it("requires a token only when a dispatch is actually needed", async () => {
    const f = fixture(pair(), "");
    const h = github();
    await expect(evaluateFallback(f.env, TODAY, h.request)).rejects.toThrow("missing_github_token");
    expect(h.calls).not.toHaveBeenCalled();
  });

  it("has a scheduled handler but no public HTTP handler", () => {
    expect(typeof fallbackWorker.scheduled).toBe("function");
    expect("fetch" in fallbackWorker).toBe(false);
    expect(pairedInitialization(...pair(), TODAY)).toBe("2026-10-06");
  });
});
