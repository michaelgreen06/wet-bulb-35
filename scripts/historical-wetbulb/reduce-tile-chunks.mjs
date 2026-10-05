#!/usr/bin/env node
/**
 * Reduce one ERA5-Land tile's checksummed hourly chunks to annual summaries and
 * complete periods for every cell|timezone group in it. No provider calls.
 * Deterministic and idempotent: a restart re-reduces retained chunks and must
 * reproduce any annual file already written byte-for-byte, or it stops.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { aggregateHistoricalWetBulb } from '../../lib/historical-wetbulb/aggregate.mjs';
import { mergeHistoricalYears } from '../../lib/historical-wetbulb/merge.mjs';
import { assertCompleteStatedPeriod } from '../../lib/historical-wetbulb/publication.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HOUR = 3_600_000, DAY = 86_400_000;
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const groupId = (key) => sha(key).slice(0, 20);

/** Padded UTC window that contains local year Y in every IANA offset (−12…+14 h). */
export function yearWindow(year, dataStartMs) {
  return [Math.max(Date.UTC(year - 1, 11, 31), dataStartMs), Date.UTC(year + 1, 0, 2, 23)];
}

export function readChunk(dir, name) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  const raw = fs.readFileSync(path.join(dir, `${name}.bin`));
  if (manifest.schemaVersion !== 1 || sha(raw) !== manifest.sha256
    || raw.length !== manifest.hours * manifest.cells.length * 3 * 4 || !Number.isSafeInteger(manifest.hours)) {
    throw new Error(`Hourly chunk ${name} failed its checksum or shape check`);
  }
  const start = Date.parse(manifest.startUTC);
  if (!Number.isFinite(start) || start % HOUR) throw new Error(`Hourly chunk ${name} has an invalid start hour`);
  return { manifest, start, values: new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4) };
}

/**
 * Pure reduction over in-memory chunks; `emit(groupKey, year, summary)` per complete
 * window. A problem confined to one cell (gap, invalid input) makes that cell
 * unavailable with a reason instead of blocking the tile; chunk-level integrity
 * failures (checksum, contiguity) still stop.
 */
export function reduceChunks(chunks, { groups, startYear, endYear, dataStartMs, emit }) {
  const buffers = new Map(), nextYear = new Map(), masked = new Set(), valid = new Set(), seen = new Set();
  const unavailable = new Map();
  const drop = (cellKey, reason) => { unavailable.set(cellKey, reason); buffers.delete(cellKey); masked.delete(cellKey); };
  let expected = null;
  const flush = (cellKey, upTo) => {
    const rows = buffers.get(cellKey) ?? [];
    let year = nextYear.get(cellKey) ?? startYear;
    while (year <= endYear) {
      const [from, to] = yearWindow(year, dataStartMs);
      if (to > upTo) break;
      const window = rows.filter((r) => { const t = Date.parse(r.timeUTC); return t >= from && t <= to; });
      if (window.length !== (to - from) / HOUR + 1) return drop(cellKey, `missing-hours-${year}`);
      const cell = cellKey.split(',').map(Number);
      const summaries = [];
      try {
        for (const timeZone of groups[cellKey]) summaries.push([timeZone, aggregateHistoricalWetBulb(window, { timeZone, gridCell: cell, localYear: year })]);
      } catch (error) {
        return drop(cellKey, `invalid-input-${year}: ${error.message}`);
      }
      for (const [timeZone, summary] of summaries) emit(`${cellKey}|${timeZone}`, year, summary);
      year++;
      const keepFrom = yearWindow(year, dataStartMs)[0];
      buffers.set(cellKey, rows.filter((r) => Date.parse(r.timeUTC) >= keepFrom));
    }
    nextYear.set(cellKey, year);
  };
  for (const { manifest, start, values } of chunks) {
    if (expected !== null && start !== expected) throw new Error('Hourly chunks are not contiguous');
    expected = start + manifest.hours * HOUR;
    manifest.cells.forEach((cellKey, c) => {
      if (!groups[cellKey] || unavailable.has(cellKey)) return;
      seen.add(cellKey);
      const rows = buffers.get(cellKey) ?? [];
      const cell = cellKey.split(',').map(Number);
      let missing = 0;
      for (let h = 0; h < manifest.hours; h++) {
        const o = (h * manifest.cells.length + c) * 3;
        const [t, d, p] = [values[o], values[o + 1], values[o + 2]];
        if (![t, d, p].every(Number.isFinite)) { missing++; continue; }
        rows.push({ timeUTC: iso(start + h * HOUR), temperatureK: t, dewpointK: d, pressurePa: p, gridCell: cell });
      }
      // Masked means no value in any chunk; any gap in a cell with data is partial.
      if (missing === manifest.hours && !valid.has(cellKey)) { masked.add(cellKey); buffers.delete(cellKey); return; }
      if (missing || masked.has(cellKey)) return drop(cellKey, 'partial-hourly-coverage');
      valid.add(cellKey);
      buffers.set(cellKey, rows);
      flush(cellKey, expected - HOUR);
    });
  }
  return { masked: [...masked].sort(), seen: [...seen].sort(), unavailable: Object.fromEntries([...unavailable].sort()),
    complete: Object.fromEntries([...nextYear].filter(([k]) => !unavailable.has(k)).map(([k, y]) => [k, y > endYear])) };
}

function writeOnce(file, text) {
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== text) throw new Error(`Re-reduction differs from retained ${path.basename(file)}`);
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
  return true;
}

function* streamChunks(tileDir, names) {
  for (const name of names) yield readChunk(tileDir, name);
}

export function reduceTile({ tileDir, groups, startYear, endYear, out }) {
  const names = fs.readdirSync(tileDir).filter((n) => /^chunk-\d{4}\.json$/.test(n)).sort().map((n) => n.slice(0, -5));
  if (!names.length) throw new Error('No hourly chunks for tile');
  const heads = names.map((name) => JSON.parse(fs.readFileSync(path.join(tileDir, `${name}.json`), 'utf8')));
  const dataStartMs = Date.parse(heads[0].dataStartUTC);
  if (!Number.isFinite(dataStartMs) || heads.some((h) => h.dataStartUTC !== heads[0].dataStartUTC)) throw new Error('Inconsistent source data start');
  const pinned = heads.every((h) => h.source?.pinned === true);
  const hourlyChunks = heads.map((h, i) => ({ chunk: names[i], sha256: h.sha256, source: h.source }));
  let written = 0;
  const result = reduceChunks(streamChunks(tileDir, names), { groups, startYear, endYear, dataStartMs, emit(key, year, summary) {
    const text = JSON.stringify({ ...summary, localYear: year, researchOnly: !pinned }) + '\n';
    written += writeOnce(path.join(out, groupId(key), `y${year}.json`), text);
  } });
  const periods = [], failed = [];
  const tzdata = process.versions.tz ?? null;
  for (const cellKey of result.seen) {
    if (!result.complete[cellKey]) continue;
    for (const timeZone of groups[cellKey]) {
      const key = `${cellKey}|${timeZone}`, dir = path.join(out, groupId(key));
      try {
        const texts = [];
        for (let year = startYear; year <= endYear; year++) texts.push(fs.readFileSync(path.join(dir, `y${year}.json`), 'utf8'));
        const summary = mergeHistoricalYears(texts.map((t) => JSON.parse(t)), { startYear, endYear });
        const coverage = assertCompleteStatedPeriod(summary);
        const period = JSON.stringify({ groupKey: key, ...summary, sourcePinned: pinned }) + '\n';
        writeOnce(path.join(dir, 'period.json'), period);
        const manifest = { schemaVersion: 1, groupKey: key, gridCell: summary.gridCell, timeZone, researchOnly: !pinned,
          sourcePinned: pinned, tzdata, startYear, endYear, ...coverage, periodSha256: sha(period),
          annualDigests: texts.map((t, i) => ({ year: startYear + i, sha256: sha(t) })), hourlyChunks, periodHigh: summary.periodHigh };
        writeOnce(path.join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n');
        periods.push({ groupKey: key, completeDays: coverage.completeDays, periodSha256: manifest.periodSha256 });
      } catch (error) {
        if (/differs from retained/.test(error.message)) throw error; // reproducibility failures always stop
        failed.push({ groupKey: key, reason: error.message });
      }
    }
  }
  return { masked: result.masked, seen: result.seen, unavailableCells: result.unavailable, failedGroups: failed, tzdata,
    newAnnualFiles: written, periods };
}

function main() {
  const args = new Map();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined || args.has(argv[i])) throw new TypeError('Expected unique --key value pairs');
    args.set(argv[i], argv[i + 1]);
  }
  for (const key of ['--tile-dir', '--groups', '--start-year', '--end-year', '--out']) if (!args.get(key)) throw new TypeError(`Missing ${key}`);
  const out = path.resolve(args.get('--out'));
  if (out === ROOT || out.startsWith(ROOT + path.sep)) throw new Error('Reduced history must remain private');
  const result = reduceTile({ tileDir: path.resolve(args.get('--tile-dir')), groups: JSON.parse(fs.readFileSync(args.get('--groups'), 'utf8')),
    startYear: Number(args.get('--start-year')), endYear: Number(args.get('--end-year')), out });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
