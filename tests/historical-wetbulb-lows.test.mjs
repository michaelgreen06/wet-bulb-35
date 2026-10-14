import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { aggregateHistoricalWetBulb, aggregateHistoricalWetBulbExtrema } from '../lib/historical-wetbulb/aggregate.mjs';
import { assertLowsReproducible, mergeHistoricalLowYears } from '../lib/historical-wetbulb/lows.mjs';
import { assertCompleteStatedPeriod } from '../lib/historical-wetbulb/publication.mjs';
import { reduceTile } from '../scripts/historical-wetbulb/reduce-tile-chunks.mjs';
import { calculateRompsWetBulbKelvin } from '../lib/forecast/romps.ts';

const HOUR = 3_600_000;
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const CELL = [61.2, -149.9];
// Synthetic test hours only (never data): sub-freezing, so lows are negative.
function rows(from, to, cell = CELL) {
  const out = [];
  for (let ms = from; ms <= to; ms += HOUR) {
    const t = 262 + 14 * Math.sin(ms / 3.1e9) + 6 * Math.sin(ms / 1.37e7);
    const [a, b, c] = Float32Array.from([t, t - 3 - 2 * Math.cos(ms / 9e6), 98000 + 900 * Math.sin(ms / 5e8)]);
    out.push({ timeUTC: new Date(ms).toISOString(), temperatureK: a, dewpointK: b, pressurePa: c, gridCell: cell });
  }
  return out;
}
const YEAR_2020 = rows(Date.UTC(2019, 11, 31), Date.UTC(2021, 0, 2, 23));

test('high output is byte-identical to the pre-low aggregator (09bfbf8 golden digests)', () => {
  const golden = {
    'America/Anchorage': '723355c7e99443c86cd1d868ef6c252e9f0fa8fb0ace64a0d3128d6b25135346',
    'Pacific/Kiritimati': 'b243cb744b88d92fab338982b19c6151dbdcbe0badc6d19898eb46cb9b7e2685',
    'Etc/GMT+12': '24f9bdcaf4dff4f36b76f3d5657114d95ef8b28d95b58a1276cb04933ce18377',
    'Asia/Kolkata': '76db4f81451f823fff117f511a708c1adddbdc5243b9cac6a3c63b716c8b420f',
  };
  for (const [timeZone, digest] of Object.entries(golden)) {
    const opts = { timeZone, gridCell: CELL, localYear: 2020 };
    assert.equal(sha(JSON.stringify(aggregateHistoricalWetBulb(YEAR_2020, opts))), digest, timeZone);
    assert.equal(sha(JSON.stringify(aggregateHistoricalWetBulbExtrema(YEAR_2020, opts).high)), digest, timeZone);
  }
});

test('pinned Romps matches 500 cold heatindex 0.0.2 vectors down to 190 K', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/romps-reference-vectors-cold.v1.json', import.meta.url), 'utf8'));
  assert.equal(fixture.source.commit, 'ebe4a831c1c01de071c8debf27863f1ad92b5782');
  assert.equal(fixture.vectors.length, 500);
  let worst = 0;
  for (const v of fixture.vectors) worst = Math.max(worst, Math.abs(calculateRompsWetBulbKelvin(v) - v.wetBulbK));
  assert.ok(worst < 1e-8, String(worst));
});

test('lows come from the same hours: each day low ≤ high, negative values kept, coverage identical', () => {
  const { high, low } = aggregateHistoricalWetBulbExtrema(YEAR_2020, { timeZone: 'America/Anchorage', gridCell: CELL, localYear: 2020 });
  assert.equal(low.extremum, 'low');
  assert.deepEqual(low.coverage, high.coverage);
  assert.deepEqual(Object.keys(low.daily), Object.keys(high.daily));
  assert.equal(Object.keys(low.daily).length, 366, 'leap year');
  assert.ok(low.daily['02-29']);
  for (const [key, entry] of Object.entries(low.daily)) {
    assert.ok(entry.valueC <= high.daily[key].valueC, key);
    assert.equal(entry.hours, high.daily[key].hours);
    assert.deepEqual(entry.contributingYears, [2020]);
  }
  assert.ok(low.periodLow.valueC < 0, 'negative modeled wet bulb is a valid low, not an outlier');
  assert.equal(low.daily['03-08'].hours, 23, 'DST start day has 23 local hours');
  assert.equal(low.daily['11-01'].hours, 25, 'DST end day has 25 local hours');
  const all = Object.values(low.daily);
  const min = Math.min(...all.map((e) => e.valueC));
  assert.equal(low.periodLow.valueC, min);
  for (const [month, m] of Object.entries(low.monthly)) {
    assert.equal(m.valueC, Math.min(...Object.entries(low.daily).filter(([k]) => k.startsWith(month)).map(([, e]) => e.valueC)));
  }
});

test('ties go to the earliest hour, day and year (deterministic)', () => {
  const flat = rows(Date.UTC(2019, 11, 31), Date.UTC(2021, 0, 2, 23)).map((r) => ({ ...r, temperatureK: 270, dewpointK: 268, pressurePa: 100000 }));
  const { low } = aggregateHistoricalWetBulbExtrema(flat, { timeZone: 'UTC', gridCell: CELL, localYear: 2020 });
  assert.equal(low.daily['06-15'].utcTime, '2020-06-15T00:00:00.000Z');
  assert.equal(low.monthly['06'].utcTime, '2020-06-01T00:00:00.000Z');
  assert.equal(low.periodLow.utcTime, '2020-01-01T00:00:00.000Z');
  const twoYears = rows(Date.UTC(2019, 11, 31), Date.UTC(2022, 0, 2, 23)).map((r) => ({ ...r, temperatureK: 270, dewpointK: 268, pressurePa: 100000 }));
  const years = [2020, 2021].map((localYear) => ({ ...aggregateHistoricalWetBulbExtrema(twoYears, { timeZone: 'UTC', gridCell: CELL, localYear }).low, localYear }));
  const merged = mergeHistoricalLowYears(years, { startYear: 2020, endYear: 2021 });
  assert.equal(merged.daily['06-15'].localDate, '2020-06-15', 'earliest year wins a calendar-date tie');
  assert.equal(merged.monthly['06'].lowUTC, '2020-06-01T00:00:00.000Z');
  assert.equal(merged.periodLow.localDate, '2020-01-01');
});

test('skipped local dates and UTC+14/−12 year boundaries keep full low coverage', () => {
  const span = rows(Date.UTC(2010, 11, 31), Date.UTC(2012, 0, 2, 23));
  const apia = aggregateHistoricalWetBulbExtrema(span, { timeZone: 'Pacific/Apia', gridCell: CELL, localYear: 2011 }).low;
  assert.equal(apia.daily['12-30'], undefined, 'Apia skipped 2011-12-30');
  assert.equal(apia.coverage.completeDays, 364);
  for (const timeZone of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
    const low = aggregateHistoricalWetBulbExtrema(span, { timeZone, gridCell: CELL, localYear: 2011 }).low;
    assert.equal(low.coverage.completeDays, 365, timeZone);
    assert.equal(low.coverage.firstComplete, '2011-01-01');
    assert.equal(low.coverage.lastComplete, '2011-12-31');
  }
});

test('low merge fails closed on mixed provenance, wrong years and unreproducible winners', () => {
  const low = { ...aggregateHistoricalWetBulbExtrema(YEAR_2020, { timeZone: 'UTC', gridCell: CELL, localYear: 2020 }).low, localYear: 2020 };
  const merged = mergeHistoricalLowYears([low], { startYear: 2020, endYear: 2020 });
  assert.equal(merged.daily['01-01'].contributingYears, 1);
  assert.equal(merged.monthly['01'].lowC, low.monthly['01'].valueC);
  assert.throws(() => mergeHistoricalLowYears([{ ...low, extremum: undefined }], { startYear: 2020, endYear: 2020 }), /low/);
  assert.throws(() => mergeHistoricalLowYears([{ ...low, timeZone: 'Asia/Tokyo' }, low], { startYear: 2020, endYear: 2021 }), /Mixed/);
  assert.throws(() => mergeHistoricalLowYears([low], { startYear: 2019, endYear: 2020 }), /range/);
  const { '01-01': _drop, ...fewer } = low.daily;
  assert.throws(() => mergeHistoricalLowYears([{ ...low, daily: fewer }], { startYear: 2020, endYear: 2020 }), /coverage/);
  assert.throws(() => assertLowsReproducible({ ...merged, periodLow: { ...merged.periodLow, valueC: merged.periodLow.valueC + 1e-9 } }), /Period low/);
  assert.throws(() => assertLowsReproducible({ ...merged, monthly: { ...merged.monthly, '02': { ...merged.monthly['02'], lowUTC: merged.monthly['01'].lowUTC } } }), /Monthly low 02/);
});

function writeTile(dir, from, to, cells) {
  const hours = (to - from) / HOUR + 1, values = new Float32Array(hours * cells.length * 3);
  cells.forEach((cellKey, c) => {
    const series = rows(from, to, cellKey.split(',').map(Number));
    series.forEach((r, h) => values.set([r.temperatureK, r.dewpointK, r.pressurePa], (h * cells.length + c) * 3));
  });
  const raw = Buffer.from(values.buffer);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'chunk-0000.bin'), raw);
  fs.writeFileSync(path.join(dir, 'chunk-0000.json'), JSON.stringify({ schemaVersion: 1, cells, hours,
    startUTC: new Date(from).toISOString(), dataStartUTC: new Date(from).toISOString(), sha256: sha(raw), source: { pinned: true } }));
}

test('tile reduction writes a digest-bound low companion without touching high files; restart reproduces it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-low-'));
  try {
    const tileDir = path.join(dir, 'tile'), out = path.join(dir, 'out');
    writeTile(tileDir, Date.UTC(2010, 11, 31), Date.UTC(2013, 0, 2, 23), ['61.2,-149.9']);
    const args = { tileDir, groups: { '61.2,-149.9': ['America/Anchorage', 'Pacific/Apia'] }, startYear: 2011, endYear: 2012, out };
    const first = reduceTile(args);
    assert.equal(first.lowSchema, 'low-v1');
    assert.deepEqual(first.failedLowGroups, []);
    assert.equal(first.lowPeriods.length, 2);
    const group = path.join(out, fs.readdirSync(out).sort()[0]);
    assert.deepEqual(fs.readdirSync(path.join(group, 'low-v1')).sort(), ['manifest.json', 'period.json']);
    assert.equal(fs.readdirSync(group).filter((n) => /^y\d{4}\.json$/.test(n)).length, 2, 'no extra annual files');
    const snapshot = () => Object.fromEntries(fs.readdirSync(group).filter((n) => n.endsWith('.json')).map((n) => [n, sha(fs.readFileSync(path.join(group, n)))]));
    const before = snapshot();
    const manifest = JSON.parse(fs.readFileSync(path.join(group, 'low-v1', 'manifest.json'), 'utf8'));
    const lowText = fs.readFileSync(path.join(group, 'low-v1', 'period.json'), 'utf8');
    assert.equal(manifest.lowPeriodSha256, sha(lowText));
    assert.equal(manifest.highPeriodSha256, before['period.json']);
    assert.equal(manifest.highManifestSha256, before['manifest.json']);
    assert.equal(manifest.publicationApproved, false);
    assert.equal(manifest.annualLowDigests.length, 2);
    const period = JSON.parse(lowText);
    assertCompleteStatedPeriod(period);
    const high = JSON.parse(fs.readFileSync(path.join(group, 'period.json'), 'utf8'));
    assert.deepEqual(period.coverage, high.coverage);
    for (const key of Object.keys(high.daily)) assert.ok(period.daily[key].valueC <= high.daily[key].valueC);
    const again = reduceTile(args);
    assert.equal(again.newAnnualFiles, 0);
    assert.deepEqual(again.lowPeriods, first.lowPeriods);
    assert.deepEqual(snapshot(), before);
    fs.writeFileSync(path.join(group, 'low-v1', 'period.json'), lowText.replace('"schemaVersion":1', '"schemaVersion":1 '));
    assert.throws(() => reduceTile(args), /differs from retained/);
    assert.deepEqual(snapshot(), before, 'a low failure never rewrites a high file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
