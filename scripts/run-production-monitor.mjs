#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { advanceMonitor, newMonitorState, validateMonitorState } from "./production-monitor-control.mjs";
import { readControlPlane } from "./production-release-monitor.mjs";

const execute = promisify(execFile);
const LABEL = "production-monitor-active";
const terminal = new Set(["recovered", "superseded", "stopped", "expired", "expired_unhealthy"]);

export function issueStore(repo, command = execute) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new Error("GH_REPO must identify the repository");
  const gh = async (args) => (await command("gh", args, { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  const endpoint = (number, suffix = "") => `repos/${repo}/issues/${number}${suffix}`;
  return {
    async active() {
      const issues = JSON.parse(await gh(["issue", "list", "--repo", repo, "--state", "open", "--label", LABEL, "--limit", "100", "--json", "number,body"]));
      if (issues.length > 1) throw new Error("Multiple active monitor issues; refusing ambiguous recovery authority");
      return issues[0] || null;
    },
    async create(state) {
      await gh(["label", "create", LABEL, "--repo", repo, "--color", "B60205", "--description", "Active production monitor", "--force"]);
      return JSON.parse(await gh(["api", "--method", "POST", `repos/${repo}/issues`, "-f", `title=Production monitor: ${state.expectedVersion}`, "-f", `body=${JSON.stringify(state)}`, "-f", `labels[]=${LABEL}`])).number;
    },
    async read(number) { return JSON.parse(await gh(["api", endpoint(number)])); },
    async save(number, state) {
      await gh(["api", "--method", "PATCH", endpoint(number), "-f", `body=${JSON.stringify(state)}`]);
    },
    async notify(number, message) {
      await gh(["api", "--method", "POST", endpoint(number, "/comments"), "-f", `body=${message}`]);
    },
    async close(number) {
      await gh(["api", "--method", "PATCH", endpoint(number), "-f", "state=closed"]);
    },
  };
}

export async function monitorJob({
  action, store, versions = {}, options = {},
  step = advanceMonitor, control = readControlPlane,
  now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!["start", "check", "stop"].includes(action)) throw new Error("Invalid monitor action");
  let issue = await store.active();
  if (action === "stop") {
    if (!issue) return { status: "inactive" };
    // Closure is the authoritative stop flag, including for old state schemas.
    await store.close(issue.number);
    await store.notify(issue.number, "Production monitor stopped manually. No further recovery action is authorized by this monitor.");
    return { status: "stopped" };
  }
  if (action === "start") {
    if (issue) throw new Error("An active monitor already exists");
    const state = newMonitorState({ ...versions, now: now() });
    const live = await control(options);
    if (live.activeVersion !== state.expectedVersion) throw new Error("Expected release version is not active; refusing to start");
    issue = { number: await store.create(state) };
  }
  if (!issue) return { status: "inactive" };
  const number = issue.number;
  const authorized = async () => {
    const fresh = await store.read(number);
    const state = JSON.parse(fresh.body);
    return fresh.state === "open" && !terminal.has(state.status) && +now() < Date.parse(state.expiresAt);
  };
  const save = async (state) => {
    const fresh = await store.read(number);
    if (fresh.state !== "open") throw new Error("Monitor stopped");
    await store.save(number, state);
  };
  const notify = (message) => store.notify(number, message);
  let finalResult;
  do {
    const fresh = await store.read(number);
    if (fresh.state !== "open") return { status: "stopped" };
    const state = validateMonitorState(JSON.parse(fresh.body));
    const elapsed = +now() - Date.parse(state.startedAt);
    const interval = state.status === "recovering" || elapsed < 3_600_000 ? 120_000 : 1_800_000;
    const sinceLast = state.lastCheckedAt ? +now() - Date.parse(state.lastCheckedAt) : Infinity;
    const expired = +now() >= Date.parse(state.expiresAt);
    // The start job performs a final hour check even if its last regular poll
    // just finished, then hands state to independently scheduled runners.
    const endOfHour = action === "start" && elapsed >= 3_600_000;
    if (action === "check" && sinceLast < interval - 15_000 && !expired) return { status: "not_due" };
    if (state.lastCheckedAt && sinceLast > Math.max(interval * 2, 2_700_000)) {
      state.coverageGap = true;
      await notify("Monitoring heartbeat was late. Continuous coverage cannot be claimed; checking current health now.");
    }
    const lastFullElapsed = state.lastFullCheckAt ? Date.parse(state.lastFullCheckAt) - Date.parse(state.startedAt) : -Infinity;
    const fullSitemaps = !state.lastFullCheckAt || elapsed >= 3_300_000 && lastFullElapsed < 3_300_000 || elapsed >= 82_800_000 && lastFullElapsed < 82_800_000;
    finalResult = await step(state, { save, notify, authorized, now, options, fullSitemaps });
    if (fullSitemaps && finalResult.lastResult?.status === "healthy") {
      finalResult.lastFullCheckAt = now().toISOString();
      await save(finalResult);
    }
    if (terminal.has(finalResult.status)) {
      // Keep an unresolved expired incident visible for operator follow-up.
      if (finalResult.status !== "expired_unhealthy") await store.close(number);
      return finalResult;
    }
    if (finalResult.lastResult?.status !== "healthy") return finalResult;
    if (endOfHour && !finalResult.firstHourComplete) {
      finalResult.firstHourComplete = now().toISOString();
      await save(finalResult);
      await notify(finalResult.coverageGap ? "First-hour checkpoint is healthy, but monitoring had a coverage gap; review before sitemap submission." : "First-hour checkpoint passed. Sitemap submission remains a separate authorized release step.");
      return finalResult;
    }
    if (action !== "start") return finalResult;
    await sleep(Math.min(120_000, Math.max(0, Date.parse(state.startedAt) + 3_600_000 - +now())));
  } while (true);
}

async function main() {
  const store = issueStore(process.env.GH_REPO);
  const result = await monitorJob({ action: process.env.MONITOR_ACTION || "check", store,
    versions: { expectedVersion: process.env.EXPECTED_VERSION, rollbackVersion: process.env.ROLLBACK_VERSION, releaseSha: process.env.RELEASE_SHA },
    options: { token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID } });
  console.log(JSON.stringify({ status: result.status, lastResult: result.lastResult?.status }));
  if (result.status === "recovering" || result.status === "expired_unhealthy" || result.lastResult && result.lastResult.status !== "healthy" && !terminal.has(result.status)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error("Production monitor could not complete; inspect the workflow and retained monitor issue. Recovery is not confirmed.");
  process.exitCode = 1;
});
