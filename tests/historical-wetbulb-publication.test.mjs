import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { aggregateHistoricalWetBulb } from '../lib/historical-wetbulb/aggregate.mjs';
import { mergeHistoricalYears } from '../lib/historical-wetbulb/merge.mjs';
import { buildPublishedHistoryRecord, createPublishedHistoryShard, encodeCompletePeriod, assertCompleteStatedPeriod } from '../lib/historical-wetbulb/publication.mjs';
import { historyBucketKey, historyGroupKey } from '../lib/historical-wetbulb/grid.mjs';
import { DAY_KEYS, contributingYears, decodePublishedHistory, HISTORICAL_TODAY_CLIENT_SOURCE, historicalTodayEntry, renderHistoricalWetBulbSection } from '../lib/historical-wetbulb/page-history.mjs';

const cell = [40.7, -74.0];
const timeZone = 'America/New_York';
// Synthetic test hours only (never data): a smooth seasonal/diurnal cycle.
function synthetic(year, gridCell = cell) {
  const rows = [];
  for (let ms = Date.UTC(year - 1, 11, 31); ms <= Date.UTC(year + 1, 0, 2, 23); ms += 3_600_000) {
    const day = (ms - Date.UTC(year, 0, 1)) / 86_400_000;
    const t = 288 + 10 * Math.sin((day - 100) / 58) + 4 * Math.sin((ms / 3_600_000) / 3.82);
    rows.push({ timeUTC: new Date(ms).toISOString(), temperatureK: t, dewpointK: t - 6, pressurePa: 101000, gridCell });
  }
  return rows;
}
const annual = aggregateHistoricalWetBulb(synthetic(2020), { timeZone, gridCell: cell, localYear: 2020 });
const period = mergeHistoricalYears([{ ...annual, localYear: 2020 }], { startYear: 2020, endYear: 2020 });
const bytes = Buffer.from(JSON.stringify(period) + '\n');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const group = { cell, timeZone };
const approval = { scope: 'publish-modeled-history', periodSha256: digest, approvedBy: 'Reviewer', approvedAt: '2026-10-04' };

test('complete stated period passes; a missing local date or calendar key fails closed', () => {
  assert.deepEqual(assertCompleteStatedPeriod(period), { first: '2020-01-01', last: '2020-12-31', completeDays: 366, skipped: [] });
  const partial = structuredClone(period);
  partial.coverage.completeDays -= 1;
  partial.coverage.partialDays.push({ date: '2020-03-08', observedHours: 22 });
  assert.throws(() => assertCompleteStatedPeriod(partial), /missing or partial/);
  const noLeap = structuredClone(period);
  delete noLeap.daily['02-29'];
  assert.throws(() => assertCompleteStatedPeriod(noLeap), /02-29/);
});

test('publication requires a named, dated approval for the exact digest and explicit research provenance acceptance', () => {
  assert.throws(() => buildPublishedHistoryRecord(bytes, { group }), /approval/);
  assert.throws(() => buildPublishedHistoryRecord(bytes, { group, approval: { ...approval, periodSha256: '0'.repeat(64) } }), /approval/);
  assert.throws(() => buildPublishedHistoryRecord(bytes, { group, approval: { ...approval, approvedBy: ' ' } }), /approval/);
  const research = Buffer.from(JSON.stringify({ ...period, researchOnly: true }) + '\n');
  const researchApproval = { ...approval, periodSha256: crypto.createHash('sha256').update(research).digest('hex') };
  assert.throws(() => buildPublishedHistoryRecord(research, { group, approval: researchApproval }), /provenance/);
  assert.ok(buildPublishedHistoryRecord(research, { group, approval: { ...researchApproval, acceptsResearchProvenance: true } }).record);
  const { record, periodSha256 } = buildPublishedHistoryRecord(bytes, { group, approval });
  assert.equal(periodSha256, digest);
  assert.equal(record.v, 2);
});

test('refuses a period whose source cell, timezone or method differs from the route group', () => {
  assert.throws(() => encodeCompletePeriod(period, { cell: [40.8, -74.0], timeZone }), /cell\/timezone/);
  assert.throws(() => encodeCompletePeriod(period, { cell, timeZone: 'America/Chicago' }), /cell\/timezone/);
  assert.throws(() => encodeCompletePeriod({ ...period, methodVersion: 'other' }, group), /method/);
});

test('decoded record reproduces calendar-date, monthly and period highs and local dates across DST', () => {
  const history = decodePublishedHistory(encodeCompletePeriod(period, group));
  for (const [i, key] of DAY_KEYS.entries()) {
    assert.equal(history.days[i].valueC, Math.round(period.daily[key].valueC * 10) / 10);
    assert.equal(new Date(history.days[i].utcMs).toISOString(), period.daily[key].utcTime);
    assert.equal(history.days[i].localDate, period.daily[key].localDate);
  }
  for (let m = 0; m < 12; m++) assert.equal(new Date(history.monthly[m].utcMs).toISOString(), period.monthly[String(m + 1).padStart(2, '0')].highUTC);
  assert.equal(new Date(history.period.utcMs).toISOString(), period.periodHigh.utcTime);
  assert.equal(history.days[DAY_KEYS.indexOf('03-08')].localDate, '2020-03-08');
  assert.equal(history.days[DAY_KEYS.indexOf('02-29')].years, 1);
});

test('display-precision ties keep the unrounded winner', () => {
  const tied = structuredClone(period);
  const july = Object.keys(tied.daily).filter((k) => k.startsWith('07-'));
  const winner = july.reduce((a, b) => (tied.daily[a].valueC >= tied.daily[b].valueC ? a : b));
  const other = july.find((k) => k !== winner && tied.daily[k].utcTime !== tied.daily[winner].utcTime);
  const base = Math.floor(tied.daily[winner].valueC * 10) / 10 + 0.14; // above every July day
  tied.daily[winner].valueC = base;
  tied.daily[other].valueC = base - 0.03; // both display as the same tenth
  tied.monthly['07'].highC = base;
  if (base > tied.periodHigh.valueC || tied.periodHigh.utcTime === tied.daily[winner].utcTime) {
    tied.periodHigh = { valueC: base, utcTime: tied.daily[winner].utcTime, localDate: tied.daily[winner].localDate };
  }
  const history = decodePublishedHistory(encodeCompletePeriod(tied, group));
  assert.equal(history.days[DAY_KEYS.indexOf(other)].valueC, history.days[DAY_KEYS.indexOf(winner)].valueC);
  assert.equal(history.monthly[6].key, winner);
});

test('decoder rejects tampered or out-of-period payloads', () => {
  const record = encodeCompletePeriod(period, group);
  assert.throws(() => decodePublishedHistory({ ...record, d: record.d.slice(0, -8) }), /length/);
  assert.throws(() => decodePublishedHistory({ ...record, first: '2020-02-01' }), /outside its stated period/);
  assert.throws(() => decodePublishedHistory({ ...record, tz: 'Not/AZone' }), /Invalid/);
  const raw = Buffer.from(record.d, 'base64');
  raw.writeUInt16LE(DAY_KEYS.indexOf('01-01'), 366 * 6 + 12 * 2);
  assert.throws(() => decodePublishedHistory({ ...record, d: raw.toString('base64') }), /period high/);
});

test('shards accept only approval-gated records in their own bucket, keyed by their own cell and zone', () => {
  const unapproved = encodeCompletePeriod(period, group);
  assert.throws(() => createPublishedHistoryShard([unapproved], { bucket: 'n40w74' }), /approval-gated/);
  assert.throws(() => createPublishedHistoryShard([{ ...buildPublishedHistoryRecord(bytes, { group, approval }).record }], { bucket: 'n40w74' }), /approval-gated/);
  const { record } = buildPublishedHistoryRecord(bytes, { group, approval });
  assert.throws(() => { record.cell[0] = 1; }, TypeError);
  assert.throws(() => createPublishedHistoryShard([record], { bucket: 'n40w76' }), /different shard bucket/);
  assert.throws(() => createPublishedHistoryShard([record, record], { bucket: 'n40w76' }), /Duplicate|bucket/);
  assert.throws(() => createPublishedHistoryShard([record], { bucket: historyBucketKey(cell), maxBytes: 100 }), /budget/);
  const shard = JSON.parse(createPublishedHistoryShard([record], { bucket: historyBucketKey(cell) }).contents);
  assert.deepEqual(Object.keys(shard.records), [historyGroupKey(cell, timeZone)]);
});

test('today line follows the location IANA date at rollover, never the server or a cached date', () => {
  const payload = { tz: 'America/New_York', days: DAY_KEYS.map((_, i) => [20 + i / 100, 2001, 75]) };
  assert.equal(historicalTodayEntry(payload, Date.parse('2024-03-10T04:59:00Z')).key, '03-09');
  assert.equal(historicalTodayEntry(payload, Date.parse('2024-03-10T05:00:00Z')).key, '03-10');
  assert.equal(historicalTodayEntry({ ...payload, tz: 'Pacific/Kiritimati' }, Date.parse('2024-02-28T10:00:00Z')).key, '02-29');
  assert.equal(historicalTodayEntry({ ...payload, tz: 'Pacific/Pago_Pago' }, Date.parse('2024-03-01T10:00:00Z')).key, '02-29');
  const gap = { ...payload, days: payload.days.map((d, i) => (DAY_KEYS[i] === '02-29' ? null : d)) };
  assert.equal(historicalTodayEntry(gap, Date.parse('2024-02-29T12:00:00Z')), null);
});

test('the shipped client snippet fills the today line in the location zone and re-renders on resume', () => {
  const history = decodePublishedHistory(encodeCompletePeriod(period, group));
  const html = renderHistoricalWetBulbSection({ placeName: 'Town', distanceKm: 1, history });
  const json = html.match(/data-historical-wet-bulb-days>([^<]*)<\/script>/)[1];
  const target = { hidden: true, textContent: '' };
  const listeners = [];
  const data = { textContent: json };
  const section = { querySelector: (sel) => (sel === '[data-historical-today]' ? target : data) };
  const document = { hidden: false, querySelectorAll: () => [section], addEventListener: (_, fn) => listeners.push(fn) };
  let now = Date.parse('2024-03-10T04:59:00Z'); // 23:59 on 03-09 in New York
  const FakeDate = class extends Date { static now() { return now; } };
  new Function('document', 'Date', HISTORICAL_TODAY_CLIENT_SOURCE)(document, FakeDate);
  const march9 = history.days[DAY_KEYS.indexOf('03-09')];
  assert.equal(target.hidden, false);
  assert.equal(target.textContent, `Today's local date there, March 9: highest modeled hourly wet bulb across 1 years was ${march9.valueC.toFixed(1)} °C (2020).`);
  now = Date.parse('2024-03-10T05:00:00Z');
  listeners[0]();
  assert.match(target.textContent, /March 10:/);
  data.textContent = 'not json';
  listeners[0]();
  assert.equal(target.hidden, true, 'bad payload hides the line instead of showing stale text');
});

test('section wording is qualified, attributed, escaped and cache-safe', () => {
  const history = decodePublishedHistory(encodeCompletePeriod(period, group));
  const html = renderHistoricalWetBulbSection({ placeName: 'Town <script>', distanceKm: 4.26, history });
  assert.match(html, /highest modeled hourly wet bulb temperature at the ERA5-Land grid point nearest Town &lt;script&gt;/);
  assert.match(html, /complete period January 1, 2020 to December 31, 2020/);
  assert.match(html, /40\.7° N, 74\.0° W, about 4\.3 km from the mapped location/);
  assert.match(html, /not station observations, official records or all-time records/);
  assert.match(html, /doi\.org\/10\.24381\/cds\.e2161bac/);
  assert.match(html, /Contains modified Copernicus Climate Change Service information/);
  assert.ok(!html.includes('Town <script>'));
  assert.doesNotMatch(html, /today[^"]*\d{4}-\d{2}-\d{2}/i, 'no server-rendered current date');
  const json = html.match(/data-historical-wet-bulb-days>([^<]*)<\/script>/)[1];
  assert.equal(JSON.parse(json).days.length, 366);
});

test('contributing years count leap days only in leap years inside the stated period', () => {
  assert.equal(contributingYears('02-29', '1950-01-03', '2025-12-31'), 19);
  assert.equal(contributingYears('01-01', '1950-01-03', '2025-12-31'), 75);
  assert.equal(contributingYears('01-03', '1950-01-03', '2025-12-31'), 76);
});

test('zones that skipped a local date publish against their own calendar', () => {
  const apiaCell = [-13.8, -171.8];
  const apia = mergeHistoricalYears([{ ...aggregateHistoricalWetBulb(synthetic(2011, apiaCell), { timeZone: 'Pacific/Apia', gridCell: apiaCell, localYear: 2011 }), localYear: 2011 }],
    { startYear: 2011, endYear: 2011 });
  assert.equal(apia.coverage.completeDays, 364);
  assert.equal(apia.daily['12-30'], undefined);
  assert.deepEqual(assertCompleteStatedPeriod(apia).skipped, ['2011-12-30']);
  const record = encodeCompletePeriod(apia, { cell: apiaCell, timeZone: 'Pacific/Apia' });
  assert.deepEqual(record.skip, ['2011-12-30']);
  const history = decodePublishedHistory(record);
  assert.equal(history.days[DAY_KEYS.indexOf('12-30')], null);
  assert.equal(history.days[DAY_KEYS.indexOf('02-29')], null);
  assert.throws(() => decodePublishedHistory({ ...record, skip: undefined }), /omits a covered calendar date/);
  assert.throws(() => decodePublishedHistory({ ...record, skip: ['2011-13-40'] }), /Invalid/);
});
