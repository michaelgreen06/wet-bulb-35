/* Combine single-cell, single-timezone annual LOW summaries (aggregateHistoricalWetBulbExtrema().low).
 * Versioned companion to merge.mjs: the legacy high merge and its bytes are untouched. */
const SOURCE = 'ERA5-Land hourly time series';
export const LOW_SCHEMA = 'low-v1';
function validPeak(v) {
  return v && Number.isFinite(v.valueC) && typeof v.utcTime === 'string'
    && Number.isFinite(Date.parse(v.utcTime)) && /^\d{4}-\d{2}-\d{2}$/.test(v.localDate || '');
}
// Years are merged in ascending order with a strict comparison: the earliest hour wins a tie.
function lower(left, right) { return !left || right.valueC < left.valueC ? right : left; }
function keyOf(v) { return `${v.gridCell[0].toFixed(1)},${v.gridCell[1].toFixed(1)}`; }

/** Same fail-closed inventory/provenance rules as mergeHistoricalYears, selecting minima. */
export function mergeHistoricalLowYears(summaries, { startYear, endYear } = {}) {
  if (!Array.isArray(summaries) || !Number.isInteger(startYear) || !Number.isInteger(endYear)
    || startYear < 1950 || endYear < startYear || endYear > 2100
    || summaries.length !== endYear - startYear + 1) throw new TypeError('Missing or invalid annual low summary range.');
  const first = summaries[0];
  if (first?.source !== SOURCE || first.extremum !== 'low' || !first.methodVersion || !first.timeZone
    || !Array.isArray(first.gridCell) || first.gridCell.length !== 2 || !first.gridCell.every(Number.isFinite)) {
    throw new TypeError('Invalid historical low source metadata.');
  }
  const days = new Map(), months = new Map(), partial = [];
  let periodLow = null, validHours = 0, completeDays = 0, firstComplete = null, lastComplete = null;
  const years = [];
  for (const summary of [...summaries].sort((a, b) => a.localYear - b.localYear)) {
    const year = startYear + years.length;
    if (summary?.schemaVersion !== 1 || summary.extremum !== 'low' || summary.source !== SOURCE || summary.localYear !== year
      || summary.methodVersion !== first.methodVersion || summary.timeZone !== first.timeZone
      || !Array.isArray(summary.gridCell) || summary.gridCell.length !== 2
      || !summary.gridCell.every(Number.isFinite) || keyOf(summary) !== keyOf(first)
      || !summary.coverage || !Number.isSafeInteger(summary.coverage.validHours)
      || !Number.isSafeInteger(summary.coverage.completeDays) || !Array.isArray(summary.coverage.partialDays)
      || typeof summary.daily !== 'object' || typeof summary.monthly !== 'object') {
      throw new TypeError('Mixed or invalid annual ERA5-Land low summary.');
    }
    years.push(year);
    validHours += summary.coverage.validHours;
    completeDays += summary.coverage.completeDays;
    for (const [field, edge] of [['firstComplete', 'first'], ['lastComplete', 'last']]) {
      const value = summary.coverage[field];
      if (value === null || value === undefined) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !value.startsWith(`${year}-`)) throw new TypeError(`Invalid annual ${edge} complete date.`);
      if (edge === 'first') firstComplete ??= value; else lastComplete = value;
    }
    partial.push(...summary.coverage.partialDays);
    if (Object.keys(summary.daily).length !== summary.coverage.completeDays) throw new TypeError('Annual low days differ from coverage.');
    for (const [date, entry] of Object.entries(summary.daily)) {
      if (!/^\d\d-\d\d$/.test(date) || !validPeak(entry) || entry.localDate !== `${year}-${date}`
        || entry.contributingYears?.length !== 1 || entry.contributingYears[0] !== year
        || !Number.isSafeInteger(entry.hours) || entry.hours < 1 || entry.hours > 26) {
        throw new TypeError('Invalid annual calendar-day minimum.');
      }
      const aggregate = days.get(date) ?? { peak: null, contributingYears: 0, hours: 0 };
      aggregate.peak = lower(aggregate.peak, entry);
      aggregate.contributingYears++;
      aggregate.hours += entry.hours;
      days.set(date, aggregate);
    }
    for (const [month, entry] of Object.entries(summary.monthly)) {
      if (!/^(0[1-9]|1[0-2])$/.test(month) || !validPeak(entry) || !entry.localDate.startsWith(`${year}-${month}-`)
        || !Number.isSafeInteger(entry.hours) || entry.hours < 1) {
        throw new TypeError('Invalid annual monthly minimum.');
      }
      const m = months.get(month) ?? { peak: null, hours: 0 };
      m.peak = lower(m.peak, entry);
      m.hours += entry.hours;
      months.set(month, m);
    }
    if (summary.periodLow) {
      if (!validPeak(summary.periodLow) || !summary.periodLow.localDate.startsWith(`${year}-`)) {
        throw new TypeError('Invalid annual period minimum.');
      }
      periodLow = lower(periodLow, summary.periodLow);
    }
  }
  const daily = Object.fromEntries([...days].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, {
    valueC: v.peak.valueC, utcTime: v.peak.utcTime, localDate: v.peak.localDate,
    contributingYears: v.contributingYears, hours: v.hours,
  }]));
  const monthly = Object.fromEntries([...months].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, {
    lowC: v.peak.valueC, lowUTC: v.peak.utcTime, lowLocalDate: v.peak.localDate, hours: v.hours,
  }]));
  const summary = { schemaVersion: 1, extremum: 'low', lowSchema: LOW_SCHEMA, source: SOURCE, methodVersion: first.methodVersion,
    timeZone: first.timeZone, gridCell: [...first.gridCell], startYear, endYear, daily, monthly, periodLow,
    researchOnly: summaries.some((s) => s.researchOnly === true),
    coverage: { years, validHours, completeDays, firstComplete, lastComplete,
      partialDays: partial.sort((a, b) => a.date.localeCompare(b.date)) } };
  assertLowsReproducible(summary);
  return summary;
}

/** Monthly and period lows must be exactly the minima of the calendar-day lows (fail closed). */
export function assertLowsReproducible(summary) {
  const entries = Object.entries(summary.daily);
  const pick = (items) => items.reduce((best, [, e]) => (!best || e.valueC < best.valueC
    || (e.valueC === best.valueC && Date.parse(e.utcTime) < Date.parse(best.utcTime)) ? e : best), null);
  for (const [month, m] of Object.entries(summary.monthly)) {
    const best = pick(entries.filter(([k]) => k.startsWith(`${month}-`)));
    if (!best || best.valueC !== m.lowC || best.utcTime !== m.lowUTC || best.localDate !== m.lowLocalDate) {
      throw new TypeError(`Monthly low ${month} is not reproducible from calendar-date lows`);
    }
  }
  const best = pick(entries);
  const p = summary.periodLow;
  if (!best || !p || best.valueC !== p.valueC || best.utcTime !== p.utcTime || best.localDate !== p.localDate) {
    throw new TypeError('Period low is not reproducible from calendar-date lows');
  }
}
