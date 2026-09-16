import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readControlPlane, runReleaseChecks } from "./production-release-monitor.mjs";
import { restoreProductionRoute } from "./restore-production-worker-route.mjs";

const execute = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const WEATHER_REQUEST_LIMIT = 58;

export async function confirmedChecks(options, { check = runReleaseChecks, sleep = pause } = {}) {
  let remaining = options.weatherBudget ?? 0;
  let requests = 0;
  const once = async () => {
    const weather = remaining >= 2;
    // Charge conservatively even if a request fails partway through.
    if (weather) { remaining -= 2; requests += 2; }
    return check({ ...options, weather });
  };
  const first = await once();
  if (!["critical_failure", "control_unavailable"].includes(first.status)) return { ...first, weatherRequests: requests };
  await sleep(20_000);
  const second = await once();
  if (["superseded", "recovery_failure", "recovered"].includes(second.status)) return { ...second, weatherRequests: requests };
  if (second.status === "control_unavailable") return { ...second, weatherRequests: requests };
  const category = (failure) => failure.split(":")[0];
  const firstCategories = new Set(first.criticalFailures.map(category));
  const confirmed = second.criticalFailures.some((failure) => firstCategories.has(category(failure)));
  if (first.status === "critical_failure" && second.status === "critical_failure" && confirmed) return { ...second, weatherRequests: requests };
  // A first weather failure cannot be cleared by a retry that omitted weather.
  if (second.status !== "healthy" || first.criticalFailures.some((failure) => failure.startsWith("weather_")) && requests === 2) {
    return { ...second, status: "unconfirmed_failure", rollbackEligible: false, weatherRequests: requests };
  }
  return { ...second, weatherRequests: requests };
}

export async function recoverRelease(options, dependencies = {}) {
  const control = dependencies.control ?? readControlPlane;
  const restore = dependencies.restore ?? restoreProductionRoute;
  const check = dependencies.check ?? runReleaseChecks;
  const rollback = dependencies.rollback ?? (async (version) => {
    await execute("npx", ["--yes", "wrangler@4.129.1", "rollback", version,
      "--name", "wetbulb35-weather-production", "--message", "Confirmed production release failure", "--yes"],
    { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
  });
  const expected = options.expectedVersion;
  const baseline = options.rollbackVersion;
  let weatherRequests = 0;
  try {
    let state = await control(options);
    if (![expected, baseline].includes(state.activeVersion)) return { status: "superseded", weatherRequests };
    if (state.activeVersion === expected) {
      if (options.authorized && !await options.authorized()) return { status: "stopped", weatherRequests };
      try { await rollback(baseline); } catch (error) {
        // A timeout may follow a successful deployment; the control-plane re-read below decides.
        console.error(JSON.stringify({ status: "rollback_command_error", error: error.message }));
      }
      state = await control(options);
    }
    if (state.activeVersion !== baseline) return { status: state.activeVersion === expected ? "recovery_failure" : "superseded", reason: "rollback_version_not_active", weatherRequests };
    if (options.authorized && !await options.authorized()) return { status: "stopped", weatherRequests };
    // Safe to retry after partial recovery: no second version rollback.
    const route = await restore({ ...options, apply: true });
    if (!["restored", "already_correct"].includes(route.status)) return { status: "recovery_failure", reason: "route_restoration_refused", route, weatherRequests };
    const weather = (options.weatherBudget ?? 0) >= 2;
    if (weather) weatherRequests = 2;
    const result = await check({ ...options, expectedVersion: baseline, rollbackVersion: undefined, recovery: true, weather });
    if (result.status === "superseded") return { ...result, weatherRequests };
    if (result.status !== "recovered") return { ...result, status: "recovery_failure", weatherRequests };
    if (options.requireWeatherRecovery && !weather) return { status: "recovery_failure", reason: "weather_budget_exhausted_recovery_unverified", weatherRequests };
    return { ...result, weatherRequests };
  } catch (error) {
    // Log to the runner only; never store CLI stderr, credentials, or provider responses in issue state.
    console.error(JSON.stringify({ status: "recovery_error", error: error.message }));
    return { status: "recovery_failure", reason: "recovery_command_or_control_plane_failed", weatherRequests };
  }
}

export function newMonitorState({ expectedVersion, rollbackVersion, releaseSha, now = new Date() }) {
  if (!/^[a-f0-9]{40}$/.test(releaseSha)) throw new Error("Invalid release commit");
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (!uuid.test(expectedVersion) || !uuid.test(rollbackVersion) || expectedVersion === rollbackVersion) throw new Error("Invalid release versions");
  return { schema: 2, status: "active", expectedVersion, rollbackVersion, releaseSha,
    startedAt: now.toISOString(), expiresAt: new Date(+now + 86_400_000).toISOString(),
    lastCheckedAt: null, lastWeatherAt: null, weatherRequests: 0, requireWeatherRecovery: false };
}

export function validateMonitorState(state) {
  if (state.schema !== 2) throw new Error("Unsupported monitor state; stop and restart the monitor");
  newMonitorState({ ...state, now: new Date(state.startedAt) });
  if (!Number.isFinite(Date.parse(state.expiresAt)) || Date.parse(state.expiresAt) !== Date.parse(state.startedAt) + 86_400_000) throw new Error("Invalid monitor expiry");
  if (!Number.isInteger(state.weatherRequests) || state.weatherRequests < 0 || state.weatherRequests > WEATHER_REQUEST_LIMIT) throw new Error("Invalid weather request budget");
  if (!["active", "recovering", "recovered", "superseded", "stopped", "expired", "expired_unhealthy"].includes(state.status)) throw new Error("Invalid monitor status");
  return state;
}

// Shared by hosted Actions and the local rehearsal. Persist before side effects
// so another runner can resume incomplete recovery after a crash or timeout.
export async function advanceMonitor(state, {
  save, notify, authorized = async () => true,
  checks = confirmedChecks, recover = recoverRelease,
  now = () => new Date(), options = {}, fullSitemaps = false,
}) {
  validateMonitorState(state);
  if (!["active", "recovering"].includes(state.status)) return state;
  const time = now();
  if (+time >= Date.parse(state.expiresAt)) {
    const unhealthy = state.status === "recovering" || state.lastResult?.status !== "healthy";
    state.status = unhealthy ? "expired_unhealthy" : "expired";
    await save(state);
    await notify(unhealthy ? "CRITICAL: monitoring expired without verified health; operator follow-up required." : "The 24-hour monitoring window completed with the last check healthy.");
    return state;
  }
  if (!await authorized()) return state;
  const recovering = state.status === "recovering";
  const elapsed = +time - Date.parse(state.startedAt);
  const weatherInterval = elapsed < 3_600_000 ? 600_000 : 3_600_000;
  const weatherDue = recovering && state.requireWeatherRecovery || !state.lastWeatherAt || +time - Date.parse(state.lastWeatherAt) >= weatherInterval;
  const reserve = weatherDue ? Math.min(recovering ? 2 : 6, WEATHER_REQUEST_LIMIT - state.weatherRequests) : 0;
  state.weatherRequests += reserve;
  if (reserve >= 2) state.lastWeatherAt = time.toISOString();
  await save(state);
  const params = { ...options, expectedVersion: state.expectedVersion, rollbackVersion: state.rollbackVersion,
    fullSitemaps, authorized, requireWeatherRecovery: state.requireWeatherRecovery, weatherBudget: Math.min(reserve, 4) };
  let consumed = 0;
  let result;
  try {
    if (recovering) {
      if (!await authorized()) return state;
      result = await recover({ ...params, weatherBudget: reserve });
      consumed = result.weatherRequests ?? reserve;
    } else {
      result = await checks(params);
      consumed = result.weatherRequests ?? reserve;
      if (result.rollbackEligible || result.status === "recovery_failure") {
        state.status = "recovering";
        state.requireWeatherRecovery ||= result.criticalFailures?.some((failure) => failure.startsWith("weather_")) ?? false;
        state.lastResult = result;
        await save(state);
        if (!await authorized()) return state;
        result = await recover({ ...params, requireWeatherRecovery: state.requireWeatherRecovery, weatherBudget: Math.max(0, reserve - consumed) });
        consumed += result.weatherRequests ?? Math.max(0, reserve - consumed);
      }
    }
  } catch {
    consumed = reserve;
    result = { status: state.status === "recovering" ? "recovery_failure" : "monitor_error" };
  }
  state.weatherRequests -= Math.max(0, reserve - consumed);
  state.lastCheckedAt = now().toISOString();
  state.lastResult = result;
  if (result.status === "recovered") state.status = "recovered";
  if (result.status === "superseded") state.status = "superseded";
  if (result.status === "stopped") state.status = "stopped";
  if (result.status === "recovery_failure") state.status = "recovering";
  await save(state);
  if (state.status === "recovered") await notify("Rollback recovery verified: baseline version, routing, and public checks passed.");
  else if (state.status === "superseded") await notify("Monitor stopped: a different deployment is active; no further recovery action taken.");
  else if (result.status !== "healthy") await notify(`CRITICAL: ${result.status}; recovery is not confirmed. State retained for the next check.`);
  else if (result.warnings?.length) await notify(`WARNING: ${result.warnings.join(", ")}; no rollback taken.`);
  return state;
}
