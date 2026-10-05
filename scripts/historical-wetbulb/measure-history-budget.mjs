#!/usr/bin/env node
/**
 * Measure static-asset and Worker-side cost of published history using real
 * private pilot periods, projected over every planned cell|timezone group.
 * Gate-free encoding is used for measurement only; output stays private.
 * Run with: node --expose-gc --experimental-strip-types … (for heap deltas).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { encodeCompletePeriod } from '../../lib/historical-wetbulb/publication.mjs';
import { decodePublishedHistory, renderHistoricalWetBulbSection } from '../../lib/historical-wetbulb/page-history.mjs';
import { historyBucketKey } from '../../lib/historical-wetbulb/grid.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const time = (fn, runs) => { const start = process.hrtime.bigint(); for (let i = 0; i < runs; i++) fn(); return Number(process.hrtime.bigint() - start) / 1e6 / runs; };
const heap = () => { globalThis.gc?.(); return process.memoryUsage().heapUsed; };

export function measure({ periodsRoot, planFile }) {
  const records = [];
  for (const dir of fs.readdirSync(periodsRoot)) {
    const file = path.join(periodsRoot, dir, 'period.json');
    if (!fs.existsSync(file)) continue;
    const period = JSON.parse(fs.readFileSync(file, 'utf8'));
    records.push({ key: period.groupKey, record: encodeCompletePeriod(period, { cell: period.gridCell, timeZone: period.timeZone }) });
  }
  if (!records.length) throw new Error('No complete private periods to measure');
  const recordBytes = records.map(({ key, record }) => Buffer.byteLength(JSON.stringify({ [key]: record })) - 2).sort((a, b) => a - b);
  const mean = recordBytes.reduce((s, v) => s + v, 0) / recordBytes.length;
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const groups = new Map();
  for (const row of plan.rows) if (row.group) groups.set(row.group, row.cell);
  const buckets = new Map();
  for (const cell of groups.values()) { const key = historyBucketKey(cell); buckets.set(key, (buckets.get(key) ?? 0) + 1); }
  const shardBytes = [...buckets.values()].map((n) => Math.ceil(n * (mean + 1) + 400)).sort((a, b) => a - b);
  const largestGroups = Math.max(...buckets.values());
  // Synthetic worst-case shard for parse/heap timing only: real record payloads under distinct keys.
  const big = {};
  for (let i = 0; i < largestGroups; i++) { const { record } = records[i % records.length]; big[`m${i}|${record.tz}`] = record; }
  const bigText = JSON.stringify({ v: 2, records: big });
  const before = heap();
  const parsed = JSON.parse(bigText);
  const parsedHeap = heap() - before;
  const parseMs = time(() => JSON.parse(bigText), 5);
  const sample = records[0].record;
  const decodeMs = time(() => decodePublishedHistory(sample), 50);
  const history = decodePublishedHistory(sample);
  const html = renderHistoricalWetBulbSection({ placeName: 'Measurement', distanceKm: 3.2, history });
  const renderMs = time(() => renderHistoricalWetBulbSection({ placeName: 'Measurement', distanceKm: 3.2, history }), 200);
  const realShard = JSON.stringify({ v: 2, records: Object.fromEntries(records.map(({ key, record }) => [key, record])) });
  void parsed;
  return {
    schemaVersion: 1, measuredRecords: records.length,
    recordBytes: { min: recordBytes[0], max: recordBytes.at(-1), mean: Math.round(mean) },
    pilotShard: { records: records.length, bytes: Buffer.byteLength(realShard), gzipBytes: zlib.gzipSync(realShard).length,
      brotliBytes: zlib.brotliCompressSync(realShard).length },
    projection: { plannedGroups: groups.size, bucketDegrees: 2, files: buckets.size, largestBucketGroups: largestGroups,
      totalBytes: shardBytes.reduce((s, v) => s + v, 0), maxShardBytes: shardBytes.at(-1), p95ShardBytes: quantile(shardBytes, 0.95),
      medianShardBytes: quantile(shardBytes, 0.5) },
    worstShardRuntime: { bytes: Buffer.byteLength(bigText), parseMs: Number(parseMs.toFixed(2)), retainedHeapBytes: parsedHeap },
    perPage: { decodeMs: Number(decodeMs.toFixed(3)), renderMs: Number(renderMs.toFixed(3)), sectionBytes: Buffer.byteLength(html),
      sectionGzipBytes: zlib.gzipSync(html).length },
    nodeVersion: process.version, heapMeasured: typeof globalThis.gc === 'function',
  };
}

function main() {
  const args = new Map(process.argv.slice(2).map((a) => a.split('=', 2)));
  for (const key of ['--periods', '--plan', '--out']) if (!args.get(key)) throw new TypeError(`Missing ${key}=path`);
  const out = path.resolve(args.get('--out'));
  if (out.startsWith(ROOT + path.sep)) throw new Error('Measurement output stays private');
  const result = measure({ periodsRoot: args.get('--periods'), planFile: args.get('--plan') });
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.writeFileSync(out, JSON.stringify(result, null, 1) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
