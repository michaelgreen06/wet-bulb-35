import { describe, expect, it } from 'vitest';
import preview from '../workers/historical-pilot-preview.ts';
import { HISTORICAL_PILOT_PATHS, pilotPageAsset } from '../lib/historical-wetbulb/pilot-preview.ts';

const host = 'https://wetbulb35-historical-pilot-staging.mgdevstuff.workers.dev';
const fetched: string[] = [];
const env = { ASSETS: { async fetch(request: Request) {
  const path = new URL(request.url).pathname;
  fetched.push(path);
  if (path === '/preview/index.html' || path === '/assets/app.css' || path === '/assets/app.js' || HISTORICAL_PILOT_PATHS.some(p => pilotPageAsset(p) === path)) {
    return new Response(`<p>${path}</p>`, { headers: { 'content-type': path.endsWith('.css') ? 'text/css' : 'text/html' } });
  }
  return new Response(null, { status: 404 });
} } };

describe('isolated historical pilot staging worker', () => {
  it('serves exactly ten canonical city paths and a preview index, without a provider', async () => {
    expect(HISTORICAL_PILOT_PATHS).toHaveLength(10);
    expect(new Set(HISTORICAL_PILOT_PATHS).size).toBe(10);
    for (const path of ['/', ...HISTORICAL_PILOT_PATHS]) {
      const r = await preview.fetch(new Request(host + path), env);
      expect(r.status).toBe(200);
      expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(r.headers.get('cache-control')).toBe('private, no-store');
      expect(await r.text()).toContain('<p>');
    }
    for (const [path, mime] of [['/assets/app.js', 'text/javascript; charset=utf-8'], ['/assets/app.css', 'text/css; charset=utf-8']]) {
      const asset = await preview.fetch(new Request(host + path), env);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toBe(mime);
    }
    expect(fetched).toHaveLength(13);
  });
  it('refuses private generated assets, APIs, unknown cities and writes', async () => {
    for (const path of ['/preview/index.html', '/preview/pages/india--delhi--new-delhi.html', '/api/weather', '/locations/route-manifest.json', '/wetbulb-temperature/india/delhi/not-a-city/']) {
      expect((await preview.fetch(new Request(host + path), env)).status).toBe(404);
    }
    expect((await preview.fetch(new Request(host + '/', { method: 'POST' }), env)).status).toBe(405);
    const head = await preview.fetch(new Request(host + HISTORICAL_PILOT_PATHS[0], { method: 'HEAD' }), env);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});
