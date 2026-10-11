import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { reduceChunks, reduceTile, yearWindow } from '../scripts/historical-wetbulb/reduce-tile-chunks.mjs';
import { aggregateHistoricalWetBulb } from '../lib/historical-wetbulb/aggregate.mjs';

const HOUR = 3_600_000;
const A = '10.0,20.0', B = '10.0,20.1';
const start = Date.UTC(2019, 11, 31), end = Date.UTC(2021, 0, 2, 23) + HOUR;
// Synthetic test hours only (never data).
const value = (ms, c) => { const t = 290 + 8 * Math.sin(ms / 3.1e9) + 3 * Math.sin(ms / 1.37e7) + c; return [t, t - 5, 100500]; };
function chunk(from, to, cells, mask = () => false) {
  const hours = (to - from) / HOUR, values = new Float32Array(hours * cells.length * 3);
  for (let h = 0; h < hours; h++) cells.forEach((cell, c) => {
    const triple = mask(cell, from + h * HOUR) ? [NaN, NaN, NaN] : value(from + h * HOUR, c);
    values.set(triple, (h * cells.length + c) * 3);
  });
  return { manifest: { cells, hours }, start: from, values };
}
function run(chunks, groups) {
  const out = new Map();
  const result = reduceChunks(chunks, { groups, startYear: 2020, endYear: 2020, dataStartMs: start, emit: (k, y, s) => out.set(`${k}:${y}`, s) });
  return { result, out };
}

test('chunk boundaries do not change annual results; several timezones share one cell', () => {
  const groups = { [A]: ['Asia/Kolkata', 'America/New_York'], [B]: ['UTC'] };
  const one = run([chunk(start, end, [A, B])], groups);
  const split = Date.UTC(2020, 6, 15, 7);
  const two = run([chunk(start, split, [A, B]), chunk(split, end, [A, B])], groups);
  assert.equal(one.out.size, 3);
  assert.deepEqual([...two.out], [...one.out]);
  const rows = [];
  for (let ms = start; ms < end; ms += HOUR) { const [t, d, p] = Float32Array.from(value(ms, 0)); rows.push({ timeUTC: new Date(ms).toISOString(), temperatureK: t, dewpointK: d, pressurePa: p, gridCell: [10, 20] }); }
  assert.deepEqual(one.out.get(`${A}|Asia/Kolkata:2020`), aggregateHistoricalWetBulb(rows, { timeZone: 'Asia/Kolkata', gridCell: [10, 20], localYear: 2020 }));
  assert.equal(one.out.get(`${A}|America/New_York:2020`).coverage.completeDays, 366);
});

test('an all-missing cell is masked; a gap makes only that cell unavailable; broken chunk order stops', () => {
  const masked = run([chunk(start, end, [A, B], (cell) => cell === B)], { [A]: ['UTC'], [B]: ['UTC'] });
  assert.deepEqual(masked.result.masked, [B]);
  assert.equal([...masked.out.keys()].some((k) => k.startsWith(B)), false);
  const gap = run([chunk(start, end, [A, B], (cell, ms) => cell === A && ms === Date.UTC(2020, 4, 1, 3))], { [A]: ['UTC'], [B]: ['UTC'] });
  assert.equal(gap.result.unavailable[A], 'partial-hourly-coverage');
  assert.equal(gap.result.complete[A], undefined);
  assert.ok(gap.out.has(`${B}|UTC:2020`), 'neighbouring clean cell still reduces');
  const split = Date.UTC(2020, 6, 1);
  assert.equal(run([chunk(start, split, [A]), chunk(split, end, [A], () => true)], { [A]: ['UTC'] }).result.unavailable[A], 'partial-hourly-coverage');
  assert.throws(() => run([chunk(start, split, [A]), chunk(split + HOUR, end, [A])], { [A]: ['UTC'] }), /contiguous/);
  const truncated = run([chunk(start, Date.UTC(2021, 0, 1), [A])], { [A]: ['UTC'] });
  assert.equal(truncated.result.complete[A], false);
  assert.equal(truncated.out.size, 0, 'no annual result without the full padded window');
});

test('padded windows contain local years at UTC−12 and UTC+14', () => {
  const [from, to] = yearWindow(2020, 0);
  assert.ok(from <= Date.UTC(2020, 0, 1) - 14 * HOUR && to >= Date.UTC(2021, 0, 1) + 12 * HOUR - HOUR);
  assert.equal(yearWindow(1950, Date.UTC(1950, 0, 2))[0], Date.UTC(1950, 0, 2));
});

test('tile reduction is checksum-gated and restart-idempotent on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-'));
  try {
    const tileDir = path.join(dir, 'tile'), out = path.join(dir, 'out');
    fs.mkdirSync(tileDir);
    const { values, manifest } = chunk(start, end, [A]);
    const raw = Buffer.from(values.buffer);
    const head = { schemaVersion: 1, cells: manifest.cells, hours: manifest.hours, startUTC: new Date(start).toISOString(),
      dataStartUTC: new Date(start).toISOString(), sha256: crypto.createHash('sha256').update(raw).digest('hex'), source: { pinned: false } };
    fs.writeFileSync(path.join(tileDir, 'chunk-0000.bin'), raw);
    fs.writeFileSync(path.join(tileDir, 'chunk-0000.json'), JSON.stringify(head));
    const args = { tileDir, groups: { [A]: ['UTC'] }, startYear: 2020, endYear: 2020, out };
    const first = reduceTile(args);
    assert.equal(first.periods.length, 1);
    assert.equal(first.periods[0].completeDays, 366);
    const again = reduceTile(args);
    assert.equal(again.newAnnualFiles, 0);
    assert.deepEqual(again.periods, first.periods);
    const annual = fs.readdirSync(out).map((d) => path.join(out, d, 'y2020.json'))[0];
    fs.writeFileSync(annual, fs.readFileSync(annual, 'utf8').replace('"schemaVersion":1', '"schemaVersion":1 '));
    assert.throws(() => reduceTile(args), /differs from retained/);
    raw[0] ^= 1;
    fs.writeFileSync(path.join(tileDir, 'chunk-0000.bin'), raw);
    assert.throws(() => reduceTile(args), /checksum/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('skipped-date zones and UTC−12/+14 produce complete periods instead of halting the tile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-'));
  try {
    const tileDir = path.join(dir, 'tile'), out = path.join(dir, 'out');
    fs.mkdirSync(tileDir);
    const from = Date.UTC(2010, 11, 31), to = Date.UTC(2012, 0, 2, 23) + HOUR;
    const { values, manifest } = chunk(from, to, [A]);
    const raw = Buffer.from(values.buffer);
    fs.writeFileSync(path.join(tileDir, 'chunk-0000.bin'), raw);
    fs.writeFileSync(path.join(tileDir, 'chunk-0000.json'), JSON.stringify({ schemaVersion: 1, cells: manifest.cells, hours: manifest.hours,
      startUTC: new Date(from).toISOString(), dataStartUTC: new Date(from).toISOString(),
      sha256: crypto.createHash('sha256').update(raw).digest('hex'), source: { pinned: false } }));
    const result = reduceTile({ tileDir, groups: { [A]: ['Pacific/Apia', 'Etc/GMT+12', 'Pacific/Kiritimati'] }, startYear: 2011, endYear: 2011, out });
    assert.deepEqual(result.failedGroups, []);
    const days = Object.fromEntries(result.periods.map((p) => [p.groupKey.split('|')[1], p.completeDays]));
    assert.deepEqual(days, { 'Pacific/Apia': 364, 'Etc/GMT+12': 365, 'Pacific/Kiritimati': 365 });
    const manifestOut = JSON.parse(fs.readFileSync(path.join(out, fs.readdirSync(out)[0], 'manifest.json'), 'utf8'));
    assert.deepEqual(manifestOut.gridCell, [10, 20]);
    assert.equal(typeof manifestOut.timeZone, 'string');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
