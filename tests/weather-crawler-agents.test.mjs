import assert from "node:assert/strict";
import test from "node:test";
import { isBlockedBot, weatherResponse } from "../workers/weather-edge.mjs";

// Bare agent names: do not accidentally match `bot` or `crawler` in the URL appended
// to a full UA. These are publicly documented HTTP agents or observed UA claims.
const CRAWLER_NAMES = [
  // Observed on city HTML during the September 29–October 1 UTC audit.
  "Meta-ExternalAgent", "SemrushBot", "Googlebot", "MJ12bot", "DotBot",
  "Bingbot", "Applebot", "DuckDuckBot", "PerplexityBot", "TikTokSpider",
  "facebookexternalhit", "Amazonbot", "Bytespider", "PetalBot", "AhrefsBot",
  "ChatGPT-User", "Google-InspectionTool",
  // Other published, unambiguous automated HTTP agents without bot/spider/crawler in their names.
  "Meta-WebIndexer", "Meta-ExternalAds", "Meta-ExternalFetcher",
  "GoogleOther", "Mediapartners-Google", "APIs-Google", "Google-Safety",
  "Google-Agent", "Google-GeminiNotebook", "GoogleMessages", "Google-Pinpoint",
  "GoogleProducer", "Google-Read-Aloud", "Google-Site-Verification", "Google-CWS",
  "FeedFetcher-Google", "Perplexity-User", "Claude-User",
];

test("documented and observed automated HTTP agent names are skipped at the weather API", () => {
  for (const name of CRAWLER_NAMES) {
    assert.equal(isBlockedBot(name), true, `${name} was not skipped`);
    assert.equal(isBlockedBot(`Mozilla/5.0 (compatible; ${name}/1.1)`), true, `${name} browser-like UA was not skipped`);
  }
  for (const ua of [undefined, "", "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36", "Google-Extended"]) {
    assert.equal(isBlockedBot(ua), false, `${ua} should not be confused with an HTTP crawler`);
  }
});

test("unrecognized published HTTP agents are denied before the cache, Durable Object, or provider", async () => {
  let gateCalls = 0;
  const env = { WEATHER_GATE: { idFromName() { return "gate"; }, get() { return { fetch() { gateCalls += 1; throw new Error("should not be reached"); } }; } },
    OBSERVABILITY: { weatherUnkeyed() {}, weather() {} } };
  for (const name of ["Google-InspectionTool", "GoogleOther", "meta-externalagent", "meta-webindexer", "facebookexternalhit", "Perplexity-User"]) {
    const response = await weatherResponse(new Request("https://www.wetbulb35.com/api/weather?lat=12&lon=42", { headers: { "user-agent": name } }), env);
    assert.equal(response.status, 204, `${name} should not trigger weather refresh`);
  }
  assert.equal(gateCalls, 0);
});
