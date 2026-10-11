import { HISTORICAL_PILOT_PATHS, pilotPageAsset } from '../lib/historical-wetbulb/pilot-preview.ts';

interface PilotEnv { ASSETS: { fetch(request: Request): Promise<Response> } }
const STATIC_PATHS = new Set(['/assets/app.css', '/assets/app.js', '/logo.svg', '/favicon.svg']);
const SAFE_HEADERS = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };

export default {
  async fetch(request: Request, env: PilotEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: SAFE_HEADERS });
    if (pathname === '/robots.txt') {
      return new Response(request.method === 'HEAD' ? null : 'User-agent: *\nDisallow: /\n', { headers: { ...SAFE_HEADERS, 'content-type': 'text/plain; charset=utf-8' } });
    }
    const target = pathname === '/' ? '/preview/index.html' : pilotPageAsset(pathname) ?? (STATIC_PATHS.has(pathname) ? pathname : null);
    if (!target) return new Response(null, { status: 404, headers: SAFE_HEADERS });
    if (target.startsWith('/preview/pages/') && !HISTORICAL_PILOT_PATHS.includes(pathname as typeof HISTORICAL_PILOT_PATHS[number])) {
      return new Response(null, { status: 404, headers: SAFE_HEADERS });
    }
    try {
      const asset = await env.ASSETS.fetch(new Request(new URL(target, request.url), { method: 'GET' }));
      if (asset.status !== 200) return new Response(null, { status: 503, headers: SAFE_HEADERS });
      const headers = new Headers(SAFE_HEADERS);
      const type = target.endsWith('.html') ? 'text/html; charset=utf-8'
        : target.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : target.endsWith('.css') ? 'text/css; charset=utf-8'
        : target.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
      headers.set('content-type', type);
      return new Response(request.method === 'HEAD' ? null : asset.body, { status: 200, headers });
    } catch {
      return new Response(null, { status: 503, headers: SAFE_HEADERS });
    }
  },
};
