/**
 * Public browser assets that Cloudflare may serve before the Worker runs.
 * Everything else, including private /locations metadata, robots, sitemaps,
 * HTML, redirects and APIs, stays Worker-first. Keep this list exact: a
 * broader pattern would bypass the Worker's private-metadata 404.
 */
export const PUBLIC_ASSET_FIRST_PATHS = Object.freeze([
  "/assets/app.css",
  "/assets/app.js",
  "/assets/locations.json",
  "/favicon.svg",
  "/logo.svg",
  "/openweather-logo.png",
  "/images/wetbulb-default.jpg",
]);

export const PUBLIC_ASSET_RUN_WORKER_FIRST = Object.freeze(["/*", ...PUBLIC_ASSET_FIRST_PATHS.map((pathname) => `!${pathname}`)]);

// Mirrors publicAssetResponse() in workers/hono-page-renderer.mjs for 200 responses.
export function publicAssetFirstHeaders(pathname) {
  if (!PUBLIC_ASSET_FIRST_PATHS.includes(pathname)) throw new Error(`Not an asset-first path: ${pathname}`);
  return {
    "cache-control": pathname === "/assets/locations.json" ? "public, max-age=0, must-revalidate" : "public, max-age=14400, must-revalidate",
    "content-disposition": `inline; filename="${pathname.split("/").at(-1)}"`,
    "strict-transport-security": "max-age=63072000",
    "access-control-allow-origin": "*",
  };
}

/** Cloudflare static-assets `_headers` file; it applies only when the asset layer answers. */
export function publicAssetHeadersFile() {
  return `${PUBLIC_ASSET_FIRST_PATHS.map((pathname) => [
    pathname,
    ...Object.entries(publicAssetFirstHeaders(pathname)).map(([name, value]) => `  ${name}: ${value}`),
  ].join("\n")).join("\n")}\n`;
}
