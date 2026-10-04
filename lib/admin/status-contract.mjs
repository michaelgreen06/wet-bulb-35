/**
 * Private admin dashboard status contract (issue #53).
 *
 * Collectors write one sanitized document per panel to private storage. The admin Worker
 * validates, projects to an explicit field allowlist, and evaluates freshness at view time,
 * so an old document or an expired Top-50 snapshot can never be presented as current.
 */

export const STATUS_SCHEMA_VERSION = 1;
export const PANEL_IDS = Object.freeze(["site", "top50", "budgets", "search", "ga4"]);
export const PANEL_STORAGE_PREFIX = "status/v1/panel/";
export const PANEL_STATUSES = Object.freeze(["ok", "degraded", "down", "unknown", "unavailable"]);
export const ATTEMPT_OUTCOMES = Object.freeze(["success", "failed", "skipped"]);
/** Sanitized reason codes. Provider messages and bodies are never stored. */
export const REASON_CODES = Object.freeze([
  "credential_not_configured", "permission_denied", "quota_limited", "upstream_unavailable",
  "timeout", "invalid_response", "not_published", "not_configured", "exception",
]);

/** A panel older than this is shown as stale, with its last result preserved. */
export const PANEL_MAX_AGE_MS = Object.freeze({
  site: 30 * 60_000,
  top50: 60 * 60_000,
  budgets: 20 * 60_000,
  search: 36 * 3_600_000,
  ga4: 36 * 3_600_000,
});

/**
 * Top-50 cadence policy. PR #29 publishes once daily (06Z run, job at 15:15 UTC), so a
 * snapshot whose initialization is older than 36 h means a newer cycle is overdue.
 * Issue #50 moves publication to every usable 00/06/12/18Z cycle; set
 * ADMIN_TOP50_MAX_INIT_AGE_HOURS (e.g. 15) once #50's final readiness policy is merged.
 */
export const TOP50_DEFAULT_POLICY = Object.freeze({ maxInitializationAgeHours: 36 });
export const TOP50_PRODUCTS = Object.freeze(["inhabited", "unfiltered"]);
const TOP50_AVAILABILITY = new Set(["published", "not_published", "unavailable", "invalid"]);

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CANONICAL_PATH = /^\/(?:[a-z0-9-]+\/)*$/;
const API_PATH = /^\/api\/[a-z0-9-]+$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isoOrNull = (value) => (typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value)) ? value : null);
const dayOrNull = (value) => (typeof value === "string" && ISO_DAY.test(value) ? value : null);
const countOrNull = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const httpStatusOrNull = (value) => (Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null);
const oneOf = (value, allowed, fallback = null) => (allowed.includes(value) ? value : fallback);
const shortText = (value, max = 80) => (typeof value === "string" && value.length <= max && !/[\u0000-\u001f<>]/.test(value) ? value : null);

function projectWindow(value) {
  if (!isObject(value)) return null;
  return {
    start: dayOrNull(value.start), end: dayOrNull(value.end),
    clicks: countOrNull(value.clicks), impressions: countOrNull(value.impressions),
  };
}

function projectProviderError(value) {
  if (!isObject(value)) return null;
  const at = isoOrNull(value.at);
  if (!at) return null;
  return {
    at,
    outcome: oneOf(value.outcome, ["timeout", "upstream_http", "invalid_payload", "exception"], "exception"),
    upstreamStatus: httpStatusOrNull(value.upstreamStatus),
  };
}

function projectBudget(value) {
  if (!isObject(value)) return null;
  return { used: countOrNull(value.used), limit: countOrNull(value.limit), lastError: projectProviderError(value.lastError) };
}

function projectSnapshot(value) {
  if (!isObject(value)) return { availability: "unavailable" };
  return {
    availability: TOP50_AVAILABILITY.has(value.availability) ? value.availability : "invalid",
    schemaVersion: countOrNull(value.schemaVersion),
    initialization: isoOrNull(value.initialization),
    retrievedAt: isoOrNull(value.retrievedAt),
    generatedAt: isoOrNull(value.generatedAt),
    validFrom: isoOrNull(value.validFrom),
    validTo: isoOrNull(value.validTo),
    published: countOrNull(value.published),
  };
}

function projectCycle(value) {
  if (!isObject(value)) return null;
  const at = isoOrNull(value.at);
  if (!at) return null;
  return { at, outcome: oneOf(value.outcome, ["success", "failure", "in_progress", "cancelled", "unknown"], "unknown") };
}

/** Explicit per-panel allowlists: unknown fields never reach the browser. */
const DATA_PROJECTIONS = {
  site(data) {
    const checks = Array.isArray(data.checks) ? data.checks.slice(0, 5) : [];
    return {
      checks: checks.filter(isObject).map((check) => ({
        id: oneOf(check.id, ["homepage", "city", "snapshot"], "unknown"),
        path: typeof check.path === "string" && (CANONICAL_PATH.test(check.path) || API_PATH.test(check.path)) ? check.path : null,
        outcome: oneOf(check.outcome, ["ok", "http_error", "timeout", "content_mismatch", "not_published", "exception"], "exception"),
        httpStatus: httpStatusOrNull(check.httpStatus),
        latencyMs: countOrNull(check.latencyMs),
        checkedAt: isoOrNull(check.checkedAt),
      })),
    };
  },
  top50(data) {
    const products = isObject(data.products) ? data.products : {};
    const budget = isObject(data.scheduledBudget) ? data.scheduledBudget : {};
    return {
      products: Object.fromEntries(TOP50_PRODUCTS.map((id) => [id, projectSnapshot(products[id])])),
      scheduledBudget: { used: countOrNull(budget.used), limit: countOrNull(budget.limit) },
      lastCycle: projectCycle(data.lastCycle),
      latestFailure: projectCycle(data.latestFailure),
    };
  },
  budgets(data) {
    return {
      day: dayOrNull(data.day),
      resetAt: isoOrNull(data.resetAt),
      currentConditions: projectBudget(data.currentConditions),
      fiveDay: projectBudget(data.fiveDay),
    };
  },
  search(data) {
    const windows = isObject(data.windows) ? data.windows : {};
    const sample = isObject(data.sample) ? data.sample : {};
    const results = Array.isArray(sample.results) ? sample.results.slice(0, 25) : [];
    return {
      dataThrough: dayOrNull(data.dataThrough),
      windows: Object.fromEntries(["last7", "prior7", "last28", "prior28"].map((id) => [id, projectWindow(windows[id])])),
      sample: {
        requested: countOrNull(sample.requested),
        inspected: countOrNull(sample.inspected),
        results: results.filter(isObject).map((item) => ({
          path: typeof item.path === "string" && CANONICAL_PATH.test(item.path) ? item.path : null,
          outcome: oneOf(item.outcome, ["ok", "failed"], "failed"),
          verdict: oneOf(item.verdict, ["PASS", "NEUTRAL", "FAIL", "PARTIAL", "VERDICT_UNSPECIFIED"], null),
          coverageState: shortText(item.coverageState),
          lastCrawlDate: dayOrNull(item.lastCrawlDate),
        })),
      },
    };
  },
  ga4(data) {
    const daily = Array.isArray(data.dailySessions) ? data.dailySessions.slice(-28) : [];
    const monitor = isObject(data.spikeMonitor) ? data.spikeMonitor : {};
    const weekly = isObject(data.weeklyReport) ? data.weeklyReport : {};
    return {
      latestDataDate: dayOrNull(data.latestDataDate),
      completeThrough: dayOrNull(data.completeThrough),
      dailySessions: daily.filter(isObject).map((row) => ({ date: dayOrNull(row.date), sessions: countOrNull(row.sessions) }))
        .filter((row) => row.date),
      last7Sessions: countOrNull(data.last7Sessions),
      prior7Sessions: countOrNull(data.prior7Sessions),
      productEventsLast7: countOrNull(data.productEventsLast7),
      spikeMonitor: { lastEvaluatedDate: dayOrNull(monitor.lastEvaluatedDate) },
      weeklyReport: { lastReportDate: dayOrNull(weekly.lastReportDate) },
    };
  },
};

/** Returns a sanitized panel document, or null when the stored document is unusable. */
export function projectPanel(id, value) {
  if (!PANEL_IDS.includes(id) || !isObject(value)) return null;
  if (value.schemaVersion !== STATUS_SCHEMA_VERSION || value.panel !== id) return null;
  if (!PANEL_STATUSES.includes(value.status) || !isObject(value.data)) return null;
  const attempt = isObject(value.lastAttempt) ? value.lastAttempt : null;
  const collectedAt = value.collectedAt === null ? null : isoOrNull(value.collectedAt);
  if (value.collectedAt !== null && !collectedAt) return null;
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    panel: id,
    status: value.status,
    reason: oneOf(value.reason, REASON_CODES, null),
    collectedAt,
    lastAttempt: attempt && isoOrNull(attempt.at)
      ? { at: attempt.at, outcome: oneOf(attempt.outcome, ATTEMPT_OUTCOMES, "failed"), reason: oneOf(attempt.reason, REASON_CODES, null) }
      : null,
    fixture: value.fixture === true,
    data: DATA_PROJECTIONS[id](value.data),
  };
}

export function ageMs(iso, now) {
  const time = Date.parse(iso ?? "");
  return Number.isFinite(time) ? Math.max(0, now - time) : null;
}

/**
 * View-time freshness. Display states: ok | degraded | down | stale | unknown | unavailable | not_collected.
 * A stale panel keeps its last result but is never labeled live.
 */
export function evaluatePanel(id, doc, now) {
  if (!doc) return { state: "not_collected", stale: false, ageMs: null };
  const age = ageMs(doc.collectedAt, now);
  const failedSince = doc.lastAttempt?.outcome === "failed"
    && (!doc.collectedAt || Date.parse(doc.lastAttempt.at) > Date.parse(doc.collectedAt));
  if (doc.collectedAt === null) {
    return { state: doc.status === "unavailable" ? "unavailable" : "unknown", stale: false, ageMs: null, failedSince };
  }
  const stale = age > PANEL_MAX_AGE_MS[id] || failedSince;
  return { state: stale ? "stale" : doc.status, stale, ageMs: age, failedSince };
}

export function top50Policy(env = {}) {
  const hours = Number(env.ADMIN_TOP50_MAX_INIT_AGE_HOURS);
  return { maxInitializationAgeHours: Number.isFinite(hours) && hours > 0 && hours <= 168 ? hours : TOP50_DEFAULT_POLICY.maxInitializationAgeHours };
}

/**
 * Classifies one Top-50 snapshot at view time. Snapshot timestamps are never extended:
 * once validTo passes the ranking is expired, regardless of collector freshness.
 */
export function classifyTop50Snapshot(snapshot, now, policy = TOP50_DEFAULT_POLICY) {
  if (!snapshot || snapshot.availability === "unavailable") return { state: "unavailable", current: false };
  if (snapshot.availability === "not_published") return { state: "not_published", current: false };
  const from = Date.parse(snapshot.validFrom ?? "");
  const to = Date.parse(snapshot.validTo ?? "");
  if (snapshot.availability !== "published" || !Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return { state: "invalid", current: false };
  }
  if (now >= to) return { state: "expired", current: false };
  const initialization = Date.parse(snapshot.initialization ?? "");
  const behind = Number.isFinite(initialization) && now - initialization > policy.maxInitializationAgeHours * 3_600_000;
  if (behind) return { state: "behind", current: true };
  return { state: now < from ? "upcoming" : "in_window", current: true };
}

const TOP50_RANK = { upcoming: 0, in_window: 0, not_published: 1, behind: 2, unavailable: 2, invalid: 3, expired: 3 };
export function top50OverallStatus(classifications) {
  const worst = Math.max(...classifications.map((item) => TOP50_RANK[item.state] ?? 3));
  return ["ok", "unknown", "degraded", "down"][worst];
}

export function budgetStatus(entry) {
  if (!entry || entry.used === null || !entry.limit) return "unknown";
  const ratio = entry.used / entry.limit;
  return ratio >= 1 ? "down" : ratio >= 0.9 ? "degraded" : "ok";
}

/** Internal counters roll over at 00:00 UTC; this is our safeguard, not a vendor reset. */
export function nextUtcMidnight(now) {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
}

export function panelKey(id) { return `${PANEL_STORAGE_PREFIX}${id}`; }
