import { Hono } from "hono";

const LOCATION_ROOT = "/locations";

function assetRequest(request, pathname) {
  return new Request(new URL(pathname, request.url));
}

async function readAssetJson(request, assets, pathname) {
  const response = await assets.fetch(assetRequest(request, pathname));
  if (!response.ok) return null;
  return response.json();
}

function htmlResponse(request, routePath, label) {
  const canonical = `${new URL(request.url).origin}${routePath}/`;
  return new Response(
    `<!doctype html><html><head><link rel="canonical" href="${canonical}"></head><body>${label}</body></html>`,
    { headers: { "content-type": "text/html; charset=UTF-8" } },
  );
}

export function createHonoBindingProbe() {
  const app = new Hono();

  app.get("*", async (context) => {
    const request = context.req.raw;
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    if (parts[0] !== "wetbulb-temperature" || parts.length < 2 || parts.length > 4) {
      return context.notFound();
    }

    const manifest = await readAssetJson(request, context.env.ASSETS, `${LOCATION_ROOT}/route-manifest.json`);
    if (!manifest || manifest.v !== 1 || !Array.isArray(manifest.countries)) return context.notFound();
    const country = manifest.countries.find((item) => item.countrySlug === parts[1]);
    if (!country || typeof country.file !== "string") return context.notFound();

    if (parts.length === 2) {
      return htmlResponse(request, `/wetbulb-temperature/${parts[1]}`, country.country);
    }

    const state = country.states?.find((item) => item.slug === parts[2]);
    if (!state || typeof state.name !== "string") return context.notFound();
    const shard = await readAssetJson(request, context.env.ASSETS, `${LOCATION_ROOT}/shards/${country.file}`);
    if (!shard || shard.v !== 1 || !Array.isArray(shard.r)) return context.notFound();
    const stateRows = shard.r.filter((row) => Array.isArray(row) && row[1] === state.name);
    if (!stateRows.length) return context.notFound();

    if (parts.length === 3) {
      return htmlResponse(request, `/wetbulb-temperature/${parts[1]}/${parts[2]}`, parts[2]);
    }

    const city = stateRows.find((row) => row[4] === parts[3]);
    if (!city) return context.notFound();
    return htmlResponse(request, `/wetbulb-temperature/${parts[1]}/${parts[2]}/${parts[3]}`, city[0]);
  });

  return app;
}

export default {
  fetch(request, env, executionContext) {
    return createHonoBindingProbe().fetch(request, env, executionContext);
  },
};
