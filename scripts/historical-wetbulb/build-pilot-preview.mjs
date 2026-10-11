#!/usr/bin/env node
/** Access-protected, staging-only HTML from content-pinned complete pilot periods. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pageHtml, routePathForCity } from '../../lib/page-renderer.mjs';
import { buildPublishedHistoryRecord } from '../../lib/historical-wetbulb/publication.mjs';
import { decodePublishedHistory, HISTORICAL_TODAY_CLIENT_SOURCE } from '../../lib/historical-wetbulb/page-history.mjs';
import { HISTORICAL_PILOT_PATHS, pilotPageAsset } from '../../lib/historical-wetbulb/pilot-preview.ts';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = path.join(ROOT, 'worker-assets-historical');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const match = /^--(plan|periods|approval)=(.+)$/.exec(arg);
  if (!match) throw new Error('Expected --plan, --periods, and --approval paths');
  return [match[1], match[2]];
}));
if (Object.keys(args).length !== 3) throw new Error('Three explicit paths required');
const planBytes = fs.readFileSync(args.plan);
const plan = JSON.parse(planBytes);
const approval = JSON.parse(fs.readFileSync(args.approval, 'utf8'));
if (approval.scope !== 'publish-modeled-history' || approval.destination !== 'historical-pilot-access-staging-only'
    || approval.planSha256 !== sha(planBytes) || approval.sourcePinningRequired !== true || approval.noProduction !== true
    || !/^\d{4}-\d{2}-\d{2}$/.test(approval.approvedAt) || !approval.approvedBy?.trim()
    || !Array.isArray(approval.periodSha256s) || approval.periodSha256s.length !== 10
    || new Set(approval.periodSha256s).size !== 10) throw new Error('No exact staging-only publication approval');
const selected = plan.rows.filter(row => HISTORICAL_PILOT_PATHS.includes(row.path));
if (selected.length !== 10 || new Set(selected.map(row => row.path)).size !== 10
    || selected.some(row => row.stage !== 'pilot' || row.status !== 'research-complete-unpublished' || typeof row.group !== 'string')) {
  throw new Error('Pilot routes drifted from the reviewed private plan');
}
const cities = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/resolved_cities.json'), 'utf8'));
const wanted = new Set(HISTORICAL_PILOT_PATHS);
const matched = new Map();
for (const city of cities) {
  const route = routePathForCity(city);
  if (wanted.has(route)) {
    if (matched.has(route)) throw new Error(`Ambiguous canonical city route: ${route}`);
    matched.set(route, city);
  }
}
if (matched.size !== 10) throw new Error('One or more pilot cities are missing from the current route inventory');
const pages = [];
for (const row of selected) {
  const groupDir = path.join(args.periods, sha(row.group).slice(0, 20));
  const periodBytes = fs.readFileSync(path.join(groupDir, 'period.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(groupDir, 'manifest.json'), 'utf8'));
  const digest = sha(periodBytes);
  const source = JSON.parse(periodBytes);
  if (manifest.groupKey !== row.group || manifest.periodSha256 !== digest || !approval.periodSha256s.includes(digest)
      || source.researchOnly !== false || source.sourcePinned !== true || manifest.sourcePinned !== true
      || manifest.researchOnly !== false || manifest.hourlyChunks?.length < 2
      || manifest.hourlyChunks.some(chunk => !chunk.source?.pinned || !chunk.source?.objects?.length)) {
    throw new Error(`Period is not approved, complete and source-pinned for ${row.path}`);
  }
  const { record } = buildPublishedHistoryRecord(periodBytes, { approval: {
    scope: 'publish-modeled-history', approvedBy: approval.approvedBy, approvedAt: approval.approvedAt,
    periodSha256: digest, acceptsResearchProvenance: false,
  }, group: { cell: row.cell, timeZone: row.timeZone } });
  const history = decodePublishedHistory(record);
  const city = matched.get(row.path);
  const html = pageHtml(city, { siteUrl: 'https://www.wetbulb35.com', googleAnalyticsId: '', forecastEnabled: false,
    historicalPilotPreview: true, historicalWetBulb: history, historyDistanceKm: row.distanceKm });
  if (!html.includes('noindex, nofollow') || !html.includes('data-historical-wet-bulb') || html.includes('data-weather-widget')) {
    throw new Error(`Unsafe preview page: ${row.path}`);
  }
  pages.push({ path: row.path, city: city.name, asset: pilotPageAsset(row.path), html, digest });
}
if (new Set(pages.map(p => p.digest)).size !== 10) throw new Error('Pilot periods unexpectedly share a digest');
// Validate all sources before replacing previously built local assets.
if (fs.existsSync(OUT) && fs.lstatSync(OUT).isSymbolicLink()) throw new Error('Preview output must not be a symlink');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'preview/pages'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true, mode: 0o700 });
for (const page of pages) fs.writeFileSync(path.join(OUT, page.asset.slice(1)), page.html, { mode: 0o600 });
const links = [...pages].sort((a, b) => a.city.localeCompare(b.city)).map(p => `<li><a class="text-blue-700 underline" href="${p.path}">${escape(p.city)}</a></li>`).join('');
const index = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Historical wet bulb pilot — private staging</title><link rel="stylesheet" href="/assets/app.css"></head><body><main class="mx-auto max-w-3xl p-8"><h1 class="mb-4 text-3xl font-bold">Historical modeled wet bulb highs — private pilot</h1><p class="mb-4">Source-pinned 1950–2025 ERA5-Land model results; not official records. Lows and live weather are not included in this preview.</p><ul class="list-disc space-y-2 pl-5">${links}</ul></main></body></html>`;
fs.writeFileSync(path.join(OUT, 'preview/index.html'), index, { mode: 0o600 });
fs.writeFileSync(path.join(OUT, 'assets/app.js'), HISTORICAL_TODAY_CLIENT_SOURCE + '\n', { mode: 0o600 });
for (const name of ['logo.svg', 'favicon.svg']) fs.copyFileSync(path.join(ROOT, 'public', name), path.join(OUT, name));
execFileSync(path.join(ROOT, 'node_modules/.bin/tailwindcss'), ['-i', path.join(ROOT, 'scripts/static-tailwind.css'), '-o', path.join(OUT, 'assets/app.css'), '--minify'], { cwd: ROOT, stdio: 'pipe' });
console.log(JSON.stringify({ pages: pages.length, cssBytes: fs.statSync(path.join(OUT, 'assets/app.css')).size,
  pageBytes: pages.map(p => Buffer.byteLength(p.html)), paths: pages.map(p => p.path), periodSha256s: pages.map(p => p.digest) }));
