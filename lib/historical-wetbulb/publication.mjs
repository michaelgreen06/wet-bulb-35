/* Build-time publication gate: approved complete periods → compact v2 page records. Node only. */
import crypto from 'node:crypto';
import { ROMPS_METHOD_VERSION } from '../forecast/romps.ts';
import { historyBucketKey, historyGroupKey } from './grid.mjs';
import { DAY_KEYS, HISTORY_RECORD_VERSION, HISTORY_SOURCE, contributingYears, decodePublishedHistory } from './page-history.mjs';

const SOURCE = 'ERA5-Land hourly time series';
const DAY_BYTES = 6;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const approvedRecords = new WeakSet();
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const tenths = (value) => Math.round(value * 10);

function assertApproval(approval, periodSha256, researchOnly) {
  if (!approval || approval.periodSha256 !== periodSha256 || approval.scope !== 'publish-modeled-history'
    || typeof approval.approvedBy !== 'string' || !approval.approvedBy.trim()
    || !ISO_DAY.test(approval.approvedAt ?? '')) {
    throw new TypeError('Publication requires a named, dated approval for this exact period digest');
  }
  if (researchOnly && approval.acceptsResearchProvenance !== true) {
    throw new TypeError('Research-only (unpinned source) period lacks explicit provenance acceptance');
  }
}

const skippedCache = new Map();
/**
 * Plain-calendar dates the IANA zone never had between first and last (dateline
 * jumps). Every real local date lasts ≥ 23 h, so 6-hour UTC samples hit it.
 */
export function skippedLocalDates(timeZone, first, last) {
  const cacheKey = `${timeZone}|${first}|${last}`;
  if (skippedCache.has(cacheKey)) return skippedCache.get(cacheKey);
  const format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const seen = new Set();
  const from = Date.parse(`${first}T00:00:00Z`) - 15 * 3_600_000, to = Date.parse(`${last}T00:00:00Z`) + 39 * 3_600_000;
  for (let ms = from; ms <= to; ms += 6 * 3_600_000) {
    const [m, d, y] = format.format(new Date(ms)).split('/');
    seen.add(`${y}-${m}-${d}`);
  }
  const skipped = [];
  for (let ms = Date.parse(`${first}T00:00:00Z`); ms <= Date.parse(`${last}T00:00:00Z`); ms += 86_400_000) {
    const date = new Date(ms).toISOString().slice(0, 10);
    if (!seen.has(date)) skipped.push(date);
  }
  skippedCache.set(cacheKey, skipped);
  return skipped;
}

/** Fail closed unless every local date of the stated period (zone calendar) is complete. */
export function assertCompleteStatedPeriod(summary) {
  const c = summary?.coverage;
  const first = c?.firstComplete, last = c?.lastComplete;
  if (summary?.schemaVersion !== 1 || summary.source !== SOURCE || !ISO_DAY.test(first ?? '') || !ISO_DAY.test(last ?? '')
    || !Array.isArray(c.years) || c.years.length !== summary.endYear - summary.startYear + 1
    || c.years.some((year, i) => year !== summary.startYear + i)
    || last !== `${summary.endYear}-12-31`
    || (summary.startYear === 1950 ? !['1950-01-02', '1950-01-03'].includes(first) : first !== `${summary.startYear}-01-01`)) {
    throw new TypeError('Stated period does not start/end on complete local-year boundaries');
  }
  const skipped = skippedLocalDates(summary.timeZone, first, last);
  const expected = (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000 + 1 - skipped.length;
  if (c.completeDays !== expected || !Array.isArray(c.partialDays) || c.partialDays.some((d) => d?.date >= first && d.date <= last)
    || !Number.isSafeInteger(c.validHours) || c.validHours < expected * 23) {
    throw new TypeError('Stated period has missing or partial local dates');
  }
  for (const key of DAY_KEYS) {
    const entry = summary.daily?.[key];
    const years = contributingYears(key, first, last, skipped);
    if (years ? entry?.contributingYears !== years : entry !== undefined) {
      throw new TypeError(`Calendar date ${key} lacks full stated-period coverage`);
    }
  }
  return { first, last, completeDays: expected, skipped };
}

/**
 * Encode one approved period for one cell|timezone group. `group` is the planner's
 * mapping for the route(s) that will display it; any mismatch refuses.
 */
export function buildPublishedHistoryRecord(periodBytes, { approval, group }) {
  const periodSha256 = sha256(periodBytes);
  const summary = JSON.parse(periodBytes);
  assertApproval(approval, periodSha256, summary.researchOnly !== false);
  const record = encodeCompletePeriod(summary, group);
  Object.freeze(record.cell);
  if (record.skip) Object.freeze(record.skip);
  Object.freeze(record);
  approvedRecords.add(record);
  return { record, periodSha256 };
}

/** Gate-free encoder for private size/runtime measurement; never a publication path by itself. */
export function encodeCompletePeriod(summary, group) {
  if (summary.methodVersion !== ROMPS_METHOD_VERSION) throw new TypeError('Period used a different wet bulb method version');
  if (!group || group.timeZone !== summary.timeZone || !Array.isArray(group.cell)
    || group.cell.some((value, i) => value.toFixed(1) !== summary.gridCell[i].toFixed(1))) {
    throw new TypeError('Period source cell/timezone does not match the route group');
  }
  const { first, last, skipped } = assertCompleteStatedPeriod(summary);
  const bytes = new Uint8Array(DAY_KEYS.length * DAY_BYTES + 26);
  const view = new DataView(bytes.buffer);
  const best = Array(13).fill(null);
  DAY_KEYS.forEach((key, index) => {
    const entry = summary.daily[key];
    if (!entry) { view.setInt16(index * DAY_BYTES, -32768, true); return; }
    const hour = Date.parse(entry.utcTime) / 3_600_000;
    if (!Number.isSafeInteger(hour) || entry.localDate.slice(5) !== key) throw new TypeError('Invalid calendar-date high');
    view.setInt16(index * DAY_BYTES, tenths(entry.valueC), true);
    view.setInt32(index * DAY_BYTES + 2, hour, true);
    // Winners keep the unrounded maximum, so a display-precision tie names the true high.
    for (const slot of [Number(key.slice(0, 2)) - 1, 12]) {
      if (best[slot] === null || entry.valueC > summary.daily[DAY_KEYS[best[slot]]].valueC) best[slot] = index;
    }
  });
  best.forEach((index, slot) => view.setUint16(DAY_KEYS.length * DAY_BYTES + slot * 2, index, true));
  for (let month = 0; month < 12; month++) {
    const expected = summary.monthly[String(month + 1).padStart(2, '0')];
    const actual = summary.daily[DAY_KEYS[best[month]]];
    if (!expected || expected.highC !== actual.valueC || expected.highUTC !== actual.utcTime) {
      throw new TypeError('Monthly high is not reproducible from calendar-date highs');
    }
  }
  const top = summary.daily[DAY_KEYS[best[12]]];
  if (summary.periodHigh?.valueC !== top.valueC || summary.periodHigh.utcTime !== top.utcTime) {
    throw new TypeError('Period high is not reproducible from calendar-date highs');
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const record = { v: HISTORY_RECORD_VERSION, cell: summary.gridCell.map((v) => Number(v.toFixed(1))), tz: summary.timeZone,
    first, last, ...(skipped.length ? { skip: skipped } : {}), method: summary.methodVersion, d: btoa(binary) };
  decodePublishedHistory(record);
  return record;
}

/** Assemble one 2° bucket shard from records returned by buildPublishedHistoryRecord only. */
export function createPublishedHistoryShard(records, { bucket, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!Array.isArray(records) || !records.length || typeof bucket !== 'string') throw new TypeError('No approved history records');
  const byKey = {};
  for (const record of records) {
    if (!approvedRecords.has(record)) throw new TypeError('Only approval-gated records can enter a published shard');
    decodePublishedHistory(record);
    const key = historyGroupKey(record.cell, record.tz);
    if (Object.hasOwn(byKey, key)) throw new TypeError('Duplicate history group');
    if (historyBucketKey(record.cell) !== bucket) throw new TypeError('Record belongs to a different shard bucket');
    byKey[key] = record;
  }
  const contents = JSON.stringify({ v: HISTORY_RECORD_VERSION, bucket, source: HISTORY_SOURCE, tzdata: process.versions.tz ?? null,
    records: Object.fromEntries(Object.entries(byKey).sort(([a], [b]) => a.localeCompare(b))) });
  const bytes = Buffer.byteLength(contents);
  if (bytes > maxBytes) throw new RangeError('History shard exceeds reviewed byte budget');
  return { contents, bytes, sha256: sha256(contents) };
}
