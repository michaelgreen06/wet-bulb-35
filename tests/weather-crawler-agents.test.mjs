import assert from "node:assert/strict";
import test from "node:test";
import { isBlockedBot, weatherResponse } from "../workers/weather-edge.mjs";
import { CRAWLER_USER_AGENT_PATTERNS } from "../lib/crawler-user-agent-patterns.mjs";

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

test("pinned public crawler corpus catches named crawlers beyond the hand-maintained list", () => {
  assert.equal(CRAWLER_USER_AGENT_PATTERNS.length, 1456);
  assert.equal(new Set(CRAWLER_USER_AGENT_PATTERNS).size, CRAWLER_USER_AGENT_PATTERNS.length);
  assert.equal(CRAWLER_USER_AGENT_PATTERNS.some((p) => p === "Google-Extended"), false);
  for (const pattern of CRAWLER_USER_AGENT_PATTERNS) {
    assert.doesNotThrow(() => new RegExp(pattern, "i"));
    assert.equal(new RegExp(pattern, "i").test(""), false, `empty UA should not match ${pattern}`);
  }
  for (const name of ["Nutch", "Qwantify", "ia_archiver", "Sogou", "HeadlessChrome", "Dataprovider.com"]) {
    assert.equal(isBlockedBot(name), true, `${name} is a published crawler agent`);
  }
  // A generic HTTP library is not necessarily a crawler. Keep real API consumers
  // and the existing release-monitor probes out of any overbroad corpus rule.
  for (const ua of ["curl/8.4.0", "python-requests/2.32", "Scrapy/2.0", "Mozilla/5.0 Chrome/151.0 Safari/537.36"]) {
    assert.equal(isBlockedBot(ua), false, `${ua} is not a named crawler in this policy`);
  }
});
