/* Worker/browser-safe decoding and HTML for published modeled history. No Node APIs, no fetches. */
export const HISTORY_RECORD_VERSION = 2;
export const DAY_KEYS = Object.freeze(Array.from({ length: 366 }, (_, i) => new Date(Date.UTC(2000, 0, i + 1)).toISOString().slice(5, 10)));
const DAY_BYTES = 6, WINNER_BYTES = 26, ABSENT = -32768, HOUR_MS = 3_600_000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const HISTORY_SOURCE = Object.freeze({
  dataset: "ERA5-Land hourly data from 1950 to present",
  doi: "10.24381/cds.e2161bac",
  citation: "Muñoz Sabater, J. (2019): ERA5-Land hourly data from 1950 to present. Copernicus Climate Change Service (C3S) Climate Data Store (CDS).",
  attribution: "Contains modified Copernicus Climate Change Service information. Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains.",
});

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function bytesFromBase64(text) {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function validZone(timeZone) {
  try { new Intl.DateTimeFormat("en-US", { timeZone }); return true; } catch { return false; }
}
const formatters = new Map();
function isoDay(ms, timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, formatter);
  }
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(formatter.format(new Date(ms)));
  if (!match) throw new TypeError("Unexpected local date format");
  return `${match[3]}-${match[1]}-${match[2]}`;
}
/**
 * Number of local dates with this calendar key inside the stated complete period.
 * `skipped` lists dates the zone never had (e.g. Pacific/Apia 2011-12-30).
 */
export function contributingYears(key, first, last, skipped = []) {
  let count = 0;
  for (let year = Number(first.slice(0, 4)); year <= Number(last.slice(0, 4)); year++) {
    const date = `${year}-${key}`;
    if (key === "02-29" && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) continue;
    if (date >= first && date <= last && !skipped.includes(date)) count++;
  }
  return count;
}

/** Decode and fully validate one compact record; throws on any inconsistency. */
export function decodePublishedHistory(record) {
  if (!record || record.v !== HISTORY_RECORD_VERSION || !Array.isArray(record.cell) || record.cell.length !== 2
    || !record.cell.every(Number.isFinite) || Math.abs(record.cell[0]) > 90 || Math.abs(record.cell[1]) > 180
    || typeof record.tz !== "string" || !validZone(record.tz) || !ISO_DAY.test(record.first ?? "") || !ISO_DAY.test(record.last ?? "")
    || record.first > record.last || typeof record.method !== "string" || typeof record.d !== "string"
    || (record.skip !== undefined && (!Array.isArray(record.skip) || !record.skip.length
      || record.skip.some((d) => !ISO_DAY.test(d) || d <= record.first || d >= record.last)))) {
    throw new TypeError("Invalid published history record");
  }
  const skipped = record.skip ?? [];
  const bytes = bytesFromBase64(record.d);
  if (bytes.length !== DAY_KEYS.length * DAY_BYTES + WINNER_BYTES) throw new TypeError("Invalid published history length");
  const view = new DataView(bytes.buffer);
  const days = DAY_KEYS.map((key, index) => {
    const tenths = view.getInt16(index * DAY_BYTES, true);
    const years = contributingYears(key, record.first, record.last, skipped);
    if (tenths === ABSENT) {
      if (years) throw new TypeError("Published history omits a covered calendar date");
      return null;
    }
    const utcMs = view.getInt32(index * DAY_BYTES + 2, true) * HOUR_MS;
    const localDate = isoDay(utcMs, record.tz);
    if (!years || localDate.slice(5) !== key || localDate < record.first || localDate > record.last || tenths < -900 || tenths > 450) {
      throw new TypeError("Published calendar-date high is outside its stated period");
    }
    return { key, valueC: tenths / 10, utcMs, localDate, years };
  });
  const winner = (offset) => {
    const index = view.getUint16(DAY_KEYS.length * DAY_BYTES + offset * 2, true);
    if (!days[index]) throw new TypeError("Published winner points at an absent date");
    return days[index];
  };
  const monthly = MONTHS.map((_, month) => {
    const peak = winner(month);
    const candidates = days.filter((day) => day && Number(day.key.slice(0, 2)) === month + 1);
    if (Number(peak.key.slice(0, 2)) !== month + 1 || candidates.some((day) => day.valueC > peak.valueC)) {
      throw new TypeError("Published monthly high is not the month maximum");
    }
    return peak;
  });
  const period = winner(12);
  if (days.some((day) => day && day.valueC > period.valueC)) throw new TypeError("Published period high is not the maximum");
  return { cell: [...record.cell], timeZone: record.tz, first: record.first, last: record.last, skipped: [...skipped], method: record.method, days, monthly, period };
}

/** Today's calendar key in the location's IANA zone; computed per view, never cached in HTML. */
export function historicalTodayEntry(payload, nowMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: payload.tz, month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(nowMs)).map(({ type, value }) => [type, value]));
  const index = DAY_KEYS.indexOf(`${parts.month}-${parts.day}`);
  const entry = index < 0 ? null : payload.days[index];
  return entry ? { key: DAY_KEYS[index], valueC: entry[0], year: entry[1], years: entry[2] } : null;
}

function longDate(localDate) {
  const [year, month, day] = localDate.split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}
function degrees(value, positive, negative) {
  return `${Math.abs(value).toFixed(1)}° ${value >= 0 ? positive : negative}`;
}

/**
 * Cache-safe section: period and monthly highs are server-rendered; the
 * date-specific line is filled client-side from inert JSON (see app runtime),
 * so a 24-hour HTML cache cannot freeze yesterday's local date.
 */
export function renderHistoricalWetBulbSection({ placeName, distanceKm, history }) {
  const h = history;
  const point = `${degrees(h.cell[0], "N", "S")}, ${degrees(h.cell[1], "E", "W")}`;
  const span = `${longDate(h.first)} to ${longDate(h.last)}`;
  const rows = h.monthly.map((peak, month) => `<tr><th scope="row" class="px-3 py-2 text-left font-medium">${MONTHS[month]}</th><td class="px-3 py-2 text-right">${peak.valueC.toFixed(1)} °C</td><td class="px-3 py-2 text-right">${longDate(peak.localDate)}</td></tr>`).join("");
  const payload = JSON.stringify({ tz: h.timeZone, days: h.days.map((day) => day && [day.valueC, Number(day.localDate.slice(0, 4)), day.years]) })
    .replaceAll("<", "\\u003c");
  const name = escapeHtml(placeName);
  return `<section aria-labelledby="historical-wet-bulb-heading" class="rounded-lg border border-gray-200 bg-white p-6" data-historical-wet-bulb>
    <h2 id="historical-wet-bulb-heading" class="text-2xl font-bold text-gray-800 mb-3">Historical modeled wet bulb highs near ${name}</h2>
    <p class="text-gray-700">The highest modeled hourly wet bulb temperature at the ERA5-Land grid point nearest ${name} was <strong>${h.period.valueC.toFixed(1)} °C</strong> on ${longDate(h.period.localDate)} (local date), over the complete period ${span}.</p>
    <p class="mt-2 text-gray-700" data-historical-today hidden></p>
    <noscript><p class="mt-2 text-gray-700">Enable JavaScript to see the modeled high for today's local calendar date.</p></noscript>
    <div class="mt-4 overflow-x-auto"><table class="w-full border-collapse text-sm text-gray-700"><caption class="mb-2 text-left font-semibold text-gray-800">Highest modeled hourly wet bulb by month, ${span}</caption><thead><tr class="border-b border-gray-200"><th scope="col" class="px-3 py-2 text-left">Month</th><th scope="col" class="px-3 py-2 text-right">Modeled high</th><th scope="col" class="px-3 py-2 text-right">Local date</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="mt-4 text-sm text-gray-600">Values are reanalysis model output for one 0.1° grid cell centered at ${point}${Number.isFinite(distanceKm) ? `, about ${distanceKm.toFixed(1)} km from the mapped location` : ""}, computed from simultaneous hourly 2 m temperature, dew point and surface pressure with the Romps (2026) wet bulb method and grouped by local calendar date (${escapeHtml(h.timeZone)}). They are not station observations, official records or all-time records, and may differ from conditions at a specific street or station.</p>
    <p class="mt-2 text-sm text-gray-600">Source: <a class="text-blue-600 hover:underline" href="https://doi.org/${HISTORY_SOURCE.doi}" target="_blank" rel="noopener noreferrer">${HISTORY_SOURCE.dataset}</a> (Copernicus Climate Change Service). ${HISTORY_SOURCE.attribution}</p>
    <script type="application/json" data-historical-wet-bulb-days>${payload}</script>
  </section>`;
}

/**
 * Client runtime snippet (for the shared app script): fills the date-specific line.
 * Literal, self-contained source (no Function#toString), so bundling or minifying
 * this module cannot change what the browser runs; tests execute it directly.
 */
export const HISTORICAL_TODAY_CLIENT_SOURCE = `(() => {
  const keys = Array.from({ length: 366 }, (_, i) => new Date(Date.UTC(2000, 0, i + 1)).toISOString().slice(5, 10));
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const entryFor = (payload, nowMs) => {
    const parts = {};
    for (const part of new Intl.DateTimeFormat("en-US", { timeZone: payload.tz, month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs))) parts[part.type] = part.value;
    const key = parts.month + "-" + parts.day;
    const day = payload.days[keys.indexOf(key)];
    return day ? { key, valueC: day[0], year: day[1], years: day[2] } : null;
  };
  for (const section of document.querySelectorAll("[data-historical-wet-bulb]")) {
    const target = section.querySelector("[data-historical-today]");
    const data = section.querySelector("[data-historical-wet-bulb-days]");
    if (!target || !data) continue;
    const render = () => {
      let entry = null;
      try { entry = entryFor(JSON.parse(data.textContent), Date.now()); } catch (error) { entry = null; }
      target.hidden = !entry;
      if (entry) target.textContent = "Today's local date there, " + months[Number(entry.key.slice(0, 2)) - 1] + " " + Number(entry.key.slice(3)) + ": highest modeled hourly wet bulb across " + entry.years + " years was " + entry.valueC.toFixed(1) + " °C (" + entry.year + ").";
    };
    render();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });
  }
})();`;
