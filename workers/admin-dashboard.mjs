import {
  PANEL_IDS,
  STATUS_SCHEMA_VERSION,
  budgetStatus,
  classifyTop50Snapshot,
  evaluatePanel,
  panelKey,
  projectPanel,
  top50OverallStatus,
  top50Policy,
} from "../lib/admin/status-contract.mjs";

/**
 * Private read-only operations dashboard (issue #53).
 *
 * Cloudflare Access (approved-email one-time PIN) is the primary control and must cover the
 * whole hostname before any route exists. This Worker independently fails closed: it requires
 * a valid Access JWT for the configured audience, an allowlisted email, the exact admin
 * hostname and HTTPS. Page views only read sanitized panel documents; they never contact
 * Google, weather providers, or the WeatherGate Durable Object.
 */

export const ADMIN_HEADERS = Object.freeze({
  "x-robots-tag": "noindex, nofollow, noarchive",
  "cache-control": "private, no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
});

const JWKS_TTL_MS = 3_600_000;
const CLOCK_SKEW_SECONDS = 60;
const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const jwksCache = new Map();

function respond(body, status, contentType = "text/plain; charset=UTF-8", extra = {}) {
  return new Response(body, { status, headers: { ...ADMIN_HEADERS, "content-type": contentType, ...extra } });
}
const deny = () => respond("Access denied.\n", 403);
const notFound = () => respond("Not found.\n", 404);

/** Returns null unless every Access/allowlist setting is present and well formed. */
export function adminConfig(env = {}) {
  const hostname = String(env.ADMIN_HOSTNAME ?? "").trim().toLowerCase();
  const teamDomain = String(env.ADMIN_ACCESS_TEAM_DOMAIN ?? "").trim().toLowerCase();
  const audience = String(env.ADMIN_ACCESS_AUD ?? "").trim();
  const emails = String(env.ADMIN_ALLOWED_EMAILS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!HOSTNAME.test(hostname) || !TEAM_DOMAIN.test(teamDomain) || !/^[a-f0-9]{64}$/.test(audience)) return null;
  if (!emails.length || !emails.every((email) => EMAIL.test(email))) return null;
  return { hostname, teamDomain, audience, allowedEmails: new Set(emails) };
}

function base64UrlBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("invalid base64url");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
const base64UrlJson = (value) => JSON.parse(new TextDecoder().decode(base64UrlBytes(value)));

async function accessKeys(teamDomain, now, fetchImpl) {
  const cached = jwksCache.get(teamDomain);
  if (cached && cached.expiresAt > now) return cached.keys;
  const response = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("certs unavailable");
  const body = await response.json();
  const keys = Array.isArray(body?.keys) ? body.keys.filter((key) => key?.kty === "RSA" && typeof key.kid === "string") : [];
  jwksCache.set(teamDomain, { keys, expiresAt: now + JWKS_TTL_MS });
  return keys;
}

/** Verifies a Cloudflare Access application token (RS256). Returns the email or null. */
export async function verifyAccessJwt(token, config, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    if (typeof token !== "string" || token.length > 8192) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = base64UrlJson(parts[0]);
    const payload = base64UrlJson(parts[1]);
    if (header?.alg !== "RS256" || typeof header.kid !== "string") return null;
    let keys = await accessKeys(config.teamDomain, now, fetchImpl);
    let jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) {
      // Access rotates signing keys; refresh once before rejecting an unknown kid.
      jwksCache.delete(config.teamDomain);
      keys = await accessKeys(config.teamDomain, now, fetchImpl);
      jwk = keys.find((key) => key.kid === header.kid);
    }
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
    const seconds = Math.floor(now / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== `https://${config.teamDomain}` || !audiences.includes(config.audience)) return null;
    if (!Number.isFinite(payload.exp) || payload.exp + CLOCK_SKEW_SECONDS <= seconds) return null;
    if (Number.isFinite(payload.nbf) && payload.nbf - CLOCK_SKEW_SECONDS > seconds) return null;
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    return config.allowedEmails.has(email) ? email : null;
  } catch {
    return null;
  }
}

/** Reads every panel; a missing binding or document is "not collected", never invented. */
export async function readPanels(store) {
  const entries = await Promise.all(PANEL_IDS.map(async (id) => {
    if (!store) return [id, null];
    try { return [id, projectPanel(id, await store.get(panelKey(id), "json"))]; }
    catch { return [id, null]; }
  }));
  return Object.fromEntries(entries);
}

const STATUS_RANK = { ok: 0, unknown: 1, unavailable: 2, degraded: 2, down: 3 };

export function statusSummary(panels, now, env = {}) {
  const policy = top50Policy(env);
  const result = {};
  for (const id of PANEL_IDS) {
    const doc = panels[id];
    const evaluation = evaluatePanel(id, doc, now);
    if (id === "top50" && doc) {
      const products = Object.fromEntries(Object.entries(doc.data.products).map(([name, snapshot]) => [name, classifyTop50Snapshot(snapshot, now, policy)]));
      evaluation.products = products;
      // Snapshot expiry is evaluated now, so a stale collector cannot keep an expired ranking "current".
      const viewStatus = top50OverallStatus(Object.values(products));
      // Keep the worse of the collector's assessment (e.g. a failed cycle) and the view-time snapshot state.
      if (!evaluation.stale && doc.collectedAt && STATUS_RANK[viewStatus] > STATUS_RANK[doc.status]) evaluation.state = viewStatus;
      evaluation.snapshotStatus = viewStatus;
    }
    result[id] = { doc, evaluation };
  }
  return { schemaVersion: STATUS_SCHEMA_VERSION, renderedAt: new Date(now).toISOString(), top50Policy: policy, panels: result };
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function age(ms) {
  if (ms === null || ms === undefined) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m ago` : `${Math.floor(hours / 24)}d ago`;
}
const show = (value) => (value === null || value === undefined ? "unknown" : escapeHtml(value));
const STATE_LABEL = {
  ok: "OK", degraded: "Degraded", down: "Down", stale: "Stale", unknown: "Unknown",
  unavailable: "Unavailable", not_collected: "Not collected",
};
const SNAPSHOT_LABEL = {
  upcoming: "Current (window not yet started)", in_window: "Current for its original window (already begun)",
  behind: "Valid window, but a newer cycle is overdue", expired: "Expired — not current",
  run_unknown: "Run metadata missing — not shown as current",
  invalid: "Invalid snapshot metadata", not_published: "Not published", unavailable: "Unavailable",
};

const PANEL_META = {
  site: { title: "Site health", source: "Single synthetic probe from the operator host (provider-free routes); not global uptime", window: "Latest check" },
  top50: { title: "Top-50 forecast health", source: "Published snapshot metadata and scheduled workflow runs", window: "Current snapshot validity window" },
  budgets: { title: "Weather call budgets", source: "WeatherGate internal reserved-attempt counters — internal safeguards, not vendor-reported quota", window: "Current UTC day" },
  search: { title: "Search health", source: "Google Search Console (read-only): aggregate search performance and a fixed URL Inspection sample", window: "Last 7 / 28 complete days vs prior windows" },
  ga4: { title: "GA4 health", source: "GA4 Data API (read-only Viewer) plus existing weekly-report and spike-monitor state", window: "Last 14 days; recent days may be partial" },
};

function rows(items) {
  return `<dl>${items.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`).join("")}</dl>`;
}

function percentChange(now, before) {
  if (now === null || before === null) return "unknown";
  if (before === 0) return now === 0 ? "0 vs 0" : "n/a (prior 0)";
  return `${(((now - before) / before) * 100).toFixed(1)}%`;
}

function budgetRow(label, entry) {
  if (!entry) return [label, "not collected"];
  const error = entry.lastError ? `; last provider error ${escapeHtml(entry.lastError.outcome)}${entry.lastError.upstreamStatus ? ` (HTTP ${entry.lastError.upstreamStatus})` : ""} at ${escapeHtml(entry.lastError.at)}` : "; no provider error recorded";
  return [label, `${show(entry.used)} / ${entry.limit ? escapeHtml(entry.limit) : "no cap configured"} reserved attempts (${STATE_LABEL[budgetStatus(entry)]})${error}`];
}

const BODY = {
  site(doc) {
    return rows(doc.data.checks.map((check) => [check.id, `${escapeHtml(check.outcome)}${check.httpStatus ? ` · HTTP ${check.httpStatus}` : ""}${check.latencyMs !== null ? ` · ${check.latencyMs} ms` : ""} · ${show(check.path)} · checked ${show(check.checkedAt)}`]));
  },
  top50(doc, evaluation, summary, panels) {
    const items = Object.entries(doc.data.products).map(([name, snapshot]) => [
      name === "inhabited" ? "Inhabited Top-50" : "Unfiltered global grid",
      `${escapeHtml(SNAPSHOT_LABEL[evaluation.products[name].state])} · IFS init ${show(snapshot.initialization)} · retrieved ${show(snapshot.retrievedAt)} · published ${show(snapshot.generatedAt)} · valid ${show(snapshot.validFrom)} → ${show(snapshot.validTo)}`,
    ]);
    items.push(["Latest cycle", doc.data.lastCycle ? `${escapeHtml(doc.data.lastCycle.outcome)} at ${escapeHtml(doc.data.lastCycle.at)}` : "unknown"]);
    items.push(["Latest failed/retrying cycle", doc.data.latestFailure ? `${escapeHtml(doc.data.latestFailure.outcome)} at ${escapeHtml(doc.data.latestFailure.at)}` : "none recorded"]);
    items.push(["Overdue-cycle threshold", `${escapeHtml(summary.top50Policy.maxInitializationAgeHours)} h after IFS initialization`]);
    return rows(items);
  },
  budgets(doc, evaluation, summary, panels) {
    const scheduled = panels.top50?.data.scheduledBudget;
    return rows([
      budgetRow("Current conditions (OpenWeather, visitor-triggered)", doc.data.currentConditions),
      budgetRow("Five-day forecast (Open-Meteo, visitor-triggered)", doc.data.fiveDay),
      ["Top-50 scheduled fetches (Open-Meteo)", scheduled ? `${show(scheduled.used)} location refinements in last run / ${scheduled.limit ? escapeHtml(scheduled.limit) : "unknown"} per-run cap (scheduled, separate from visitor calls)` : "not collected"],
      ["Counter day (UTC)", show(doc.data.day)],
      ["Internal counter reset", `${show(doc.data.resetAt)} (00:00 UTC rollover of our counter; not a vendor reset time)`],
    ]);
  },
  search(doc) {
    const { windows, sample } = doc.data;
    const line = (current, prior) => current && prior
      ? `${show(current.clicks)} clicks (${percentChange(current.clicks, prior.clicks)}) · ${show(current.impressions)} impressions (${percentChange(current.impressions, prior.impressions)}) · ${show(current.start)} → ${show(current.end)}`
      : "unknown";
    const inspected = sample.results.map((item) => `<li>${show(item.path)}: ${item.outcome === "ok" ? `${show(item.verdict)} · ${show(item.coverageState)} · last crawl ${show(item.lastCrawlDate)}` : "inspection failed"}</li>`).join("");
    return rows([
      ["Complete data through", `${show(doc.data.dataThrough)} (${doc.data.completeThroughBasis === "api_metadata" ? "Search Console metadata" : doc.data.completeThroughBasis === "fixed_lag" ? "conservative fixed lag; Search Console gave no metadata" : "basis unknown"}). Days without rows count as zero.`],
      ["Latest day with any search data", show(doc.data.latestDataDate)],
      ["Last 7 complete days", line(windows.last7, windows.prior7)],
      ["Last 28 complete days", line(windows.last28, windows.prior28)],
      ["URL Inspection sample", `${show(sample.inspected)} of ${show(sample.requested)} sampled canonical URLs inspected. Sample status only — not a sitewide indexed-page count; see Search Console's Page indexing report.<ul>${inspected}</ul>`],
    ]);
  },
  ga4(doc) {
    const data = doc.data;
    const trend = data.dailySessions.map((row) => `${escapeHtml(row.date)}: ${show(row.sessions)}${data.completeThrough && row.date > data.completeThrough ? " (partial)" : ""}`).join("<br>");
    return rows([
      ["Latest data date", show(data.latestDataDate)],
      ["Complete through", `${show(data.completeThrough)} (later days are delayed/partial)`],
      ["Sessions, last 7 complete days", `${show(data.last7Sessions)} (${percentChange(data.last7Sessions, data.prior7Sessions)} vs prior 7)`],
      ["Product events, last 7 complete days", show(data.productEventsLast7)],
      ["Daily sessions", trend || "no rows"],
      ["Spike monitor last evaluated", show(data.spikeMonitor.lastEvaluatedDate)],
      ["Latest weekly report", show(data.weeklyReport.lastReportDate)],
    ]);
  },
};

export function renderDashboard(summary) {
  const panels = Object.fromEntries(PANEL_IDS.map((id) => [id, summary.panels[id].doc]));
  const fixture = PANEL_IDS.some((id) => panels[id]?.fixture);
  const cards = PANEL_IDS.map((id) => {
    const { doc, evaluation } = summary.panels[id];
    const meta = PANEL_META[id];
    const state = evaluation.state;
    const attempt = doc?.lastAttempt;
    const header = `<h2>${escapeHtml(meta.title)} <span class="badge ${escapeHtml(state)}">${escapeHtml(STATE_LABEL[state] ?? state)}</span></h2>`;
    const facts = rows([
      ["Source", escapeHtml(meta.source)],
      ["Window", escapeHtml(meta.window)],
      ["Last updated", doc?.collectedAt ? `${escapeHtml(doc.collectedAt)} (${age(evaluation.ageMs)})` : "never"],
      ["Last attempt", attempt ? `${escapeHtml(attempt.outcome)}${attempt.reason ? ` (${escapeHtml(attempt.reason)})` : ""} at ${escapeHtml(attempt.at)}` : "unknown"],
      ...(doc?.reason ? [["Reason", escapeHtml(doc.reason)]] : []),
    ]);
    const staleNote = evaluation.stale ? `<p class="warn">Stale: showing the last successful result; it is not live.</p>` : "";
    const body = doc && doc.collectedAt ? BODY[id](doc, evaluation, summary, panels) : `<p>No ${doc ? "successful collection yet" : "summary collected"}; values are unknown, not zero.</p>`;
    return `<section class="card">${header}${facts}${staleNote}${body}</section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive"><title>WetBulb35 operations</title>
<style>body{font:15px/1.45 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:16px;color:#111;background:#fafafa}
.card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0}h2{font-size:18px;margin:4px 0 8px}
dl{display:grid;grid-template-columns:minmax(120px,240px) 1fr;gap:4px 12px;margin:8px 0}dt{color:#555}dd{margin:0;overflow-wrap:anywhere}
.badge{font-size:12px;padding:2px 8px;border-radius:10px;background:#eee;vertical-align:middle}.ok{background:#d7f5dd}.degraded,.stale{background:#fff1c2}
.down{background:#fdd}.warn{color:#8a5a00}.fixture{background:#fdd;padding:8px;border-radius:6px}@media(max-width:600px){dl{grid-template-columns:1fr}}</style>
</head><body><h1>WetBulb35 operations</h1><p>Rendered ${escapeHtml(summary.renderedAt)}. Read-only; page views never contact Google or weather providers.</p>
${fixture ? `<p class="fixture">FIXTURE DATA — deterministic test values, not real metrics.</p>` : ""}
${cards}
</body></html>`;
}

export async function handleAdminRequest(request, env = {}, { now = Date.now(), fetchImpl = fetch } = {}) {
  const config = adminConfig(env);
  if (!config) return respond("Admin dashboard is not configured.\n", 503);
  const url = new URL(request.url);
  // Alternate hostnames (workers.dev, previews, other zones) never serve dashboard data.
  if (url.hostname !== config.hostname) return notFound();
  if (url.protocol !== "https:") {
    url.protocol = "https:";
    return respond("", 301, "text/plain; charset=UTF-8", { location: url.toString() });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return respond("Method not allowed.\n", 405, "text/plain; charset=UTF-8", { allow: "GET, HEAD" });
  const email = await verifyAccessJwt(request.headers.get("cf-access-jwt-assertion"), config, { now, fetchImpl });
  if (!email) return deny();

  if (url.pathname === "/robots.txt") return respond("User-agent: *\nDisallow: /\n", 200);
  if (url.pathname !== "/" && url.pathname !== "/api/status") return notFound();
  const summary = statusSummary(await readPanels(env.ADMIN_STATUS), now, env);
  const response = url.pathname === "/"
    ? respond(renderDashboard(summary), 200, "text/html; charset=UTF-8")
    : respond(JSON.stringify(summary), 200, "application/json; charset=UTF-8");
  return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

const BUDGET_ERROR_REASONS = new Set(["not_configured", "upstream_unavailable", "invalid_response"]);

function budgetPanel(summary, now) {
  const toEntry = (value) => ({ used: value.used, limit: value.limit, lastError: value.lastError });
  const currentConditions = toEntry(summary.weather);
  const fiveDay = toEntry(summary.forecast);
  const statuses = [budgetStatus(currentConditions), budgetStatus(fiveDay)];
  const status = statuses.includes("down") ? "down" : statuses.includes("degraded") ? "degraded" : statuses.every((item) => item === "unknown") ? "unknown" : "ok";
  return {
    schemaVersion: STATUS_SCHEMA_VERSION, panel: "budgets", status, reason: null,
    collectedAt: new Date(now).toISOString(),
    lastAttempt: { at: new Date(now).toISOString(), outcome: "success", reason: null },
    data: { day: summary.day, resetAt: summary.resetAt, currentConditions, fiveDay },
  };
}

/**
 * Scheduled, read-only budget collector: one internal Durable Object read, no provider call.
 * On failure the prior result is preserved and labeled by its last failed attempt.
 */
export async function collectBudgets(env, { now = Date.now() } = {}) {
  const store = env.ADMIN_STATUS;
  if (!store) return { written: false, reason: "not_configured" };
  let doc;
  let reason = null;
  try {
    if (!env.WEATHER_GATE) { reason = "not_configured"; throw new Error(reason); }
    const stub = env.WEATHER_GATE.get(env.WEATHER_GATE.idFromName("WeatherGate"));
    const response = await stub.fetch("https://weather-gate/budget", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!response.ok) { reason = "upstream_unavailable"; throw new Error(reason); }
    const summary = await response.json();
    if (summary?.v !== 1 || typeof summary.weather !== "object" || typeof summary.forecast !== "object") { reason = "invalid_response"; throw new Error(reason); }
    doc = projectPanel("budgets", budgetPanel(summary, now));
    if (!doc) { reason = "invalid_response"; throw new Error(reason); }
  } catch {
    const previous = projectPanel("budgets", await store.get(panelKey("budgets"), "json").catch(() => null));
    const failure = { at: new Date(now).toISOString(), outcome: "failed", reason: BUDGET_ERROR_REASONS.has(reason) ? reason : "exception" };
    doc = previous
      ? { ...previous, lastAttempt: failure }
      : { schemaVersion: STATUS_SCHEMA_VERSION, panel: "budgets", status: "unknown", reason: failure.reason, collectedAt: null, lastAttempt: failure, data: {} };
  }
  await store.put(panelKey("budgets"), JSON.stringify(doc));
  return { written: true, status: doc.status, reason };
}

export default {
  fetch(request, env) { return handleAdminRequest(request, env); },
  scheduled(_event, env, executionContext) { executionContext.waitUntil(collectBudgets(env)); },
};
