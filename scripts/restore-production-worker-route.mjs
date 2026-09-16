#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const ROUTE = "www.wetbulb35.com/*";
const WORKER = "wetbulb35-weather-production";

function parseArgs(argv = process.argv.slice(2)) {
  const args = new Map();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    args.set(key, rest.length ? rest.join("=") : "true");
  }
  return args;
}

async function api(fetchImpl, url, token, options = {}) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(20_000),
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(`Cloudflare API request failed (${response.status})`);
  return body.result;
}

export function selectRouteAction(routes) {
  const unexpected = relevantRoutes(routes).filter((route) => route.pattern !== ROUTE);
  if (unexpected.length) return { action: "refuse", reason: "unexpected_route_scope", routes: unexpected };
  const exact = routes.filter((route) => route.pattern === ROUTE);
  if (exact.length === 1 && exact[0].script === WORKER) return { action: "none", route: exact[0] };
  if (exact.length > 1) return { action: "refuse", reason: "duplicate_exact_routes", routes: exact };
  if (exact.length === 1) return { action: "refuse", reason: "exact_route_owned_by_other_script", routes: exact };
  return { action: "create", pattern: ROUTE, script: WORKER };
}

// Include overrides and exclusions affecting www, plus every route owned by
// this Worker. Unexpected scope needs operator attention, never a takeover.
export function relevantRoutes(routes) {
  return routes.filter((route) => {
    if (route.script === WORKER) return true;
    const host = String(route.pattern).replace(/^https?:\/\//, "").split("/")[0];
    const expression = host.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${expression}$`, "i").test("www.wetbulb35.com");
  });
}

export async function restoreProductionRoute({
  fetchImpl = fetch,
  apiBase = "https://api.cloudflare.com/client/v4",
  token,
  zoneName = "wetbulb35.com",
  apply = false,
}) {
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
  const zones = await api(fetchImpl, `${apiBase}/zones?name=${encodeURIComponent(zoneName)}`, token);
  if (zones.length !== 1 || zones[0].status !== "active") throw new Error(`Expected one active ${zoneName} zone`);
  const zoneId = zones[0].id;
  const routesUrl = `${apiBase}/zones/${zoneId}/workers/routes`;
  const before = await api(fetchImpl, routesUrl, token);
  const selection = selectRouteAction(before);
  if (selection.action === "refuse") return { status: "refused", changed: false, selection };
  if (selection.action === "create" && !apply) return { status: "dry_run_create", changed: false, selection };
  if (selection.action === "create") {
    await api(fetchImpl, routesUrl, token, { method: "POST", body: JSON.stringify({ pattern: ROUTE, script: WORKER }) });
  }
  const after = await api(fetchImpl, routesUrl, token);
  const verified = selectRouteAction(after);
  if (verified.action !== "none") return { status: "verification_failed", changed: selection.action === "create", selection, verified };
  return { status: selection.action === "create" ? "restored" : "already_correct", changed: selection.action === "create", route: verified.route };
}

async function main() {
  const args = parseArgs();
  const result = await restoreProductionRoute({
    token: process.env.CLOUDFLARE_API_TOKEN,
    apiBase: args.get("api-base"),
    apply: args.get("apply") === "true",
  });
  console.log(JSON.stringify(result));
  if (["refused", "verification_failed"].includes(result.status)) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(JSON.stringify({ status: "error", error: error.message }));
  process.exitCode = 1;
});
