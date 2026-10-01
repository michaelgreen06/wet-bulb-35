import assert from "node:assert/strict";
import test from "node:test";
import { sourceFromRequest, sanitizeWeatherSource } from "../workers/weather-source-context.ts";

function incoming({ userAgent, referer, cf } = {}) {
  const headers = {};
  if (userAgent !== undefined) headers["user-agent"] = userAgent;
  if (referer !== undefined) headers.referer = referer;
  const request = new Request("https://www.wetbulb35.com/api/weather?lat=12.34&lon=-56.78&appid=raw-secret", { headers });
  Object.defineProperty(request, "cf", { value: cf, configurable: true });
  return request;
}

test("source attribution retains only bounded Cloudflare and browser categories", () => {
  const source = sourceFromRequest(incoming({
    userAgent: "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36; raw-secret",
    referer: "https://www.wetbulb35.com/wetbulb-temperature/secret-city/?private=raw-secret",
    cf: { asn: 13335, asOrganization: "Raw Company Name", country: "DE", botManagement: { verifiedBot: false }, clientIP: "198.51.100.10" },
  }));
  assert.deepEqual(source, { asn: 13335, country: "DE", ua_family: "chrome", ua_major: 151, referrer_class: "city_page", verified_bot: false });
  const serialized = JSON.stringify(source);
  for (const forbidden of ["raw-secret", "secret-city", "Company", "198.51", "Chrome/"]) assert.equal(serialized.includes(forbidden), false);
});

test("missing, forged, and external signals fail closed into coarse categories", () => {
  assert.deepEqual(sourceFromRequest(incoming()), { asn: null, country: null, ua_family: "other", ua_major: null, referrer_class: "none", verified_bot: null });
  const source = sourceFromRequest(incoming({ userAgent: "Token appid=do-not-log", referer: "https://attacker.example/private?key=do-not-log", cf: { asn: "13335;do-not-log", country: "US?", botManagement: { verifiedBot: "true" } } }));
  assert.deepEqual(source, { asn: null, country: null, ua_family: "other", ua_major: null, referrer_class: "external", verified_bot: null });
  assert.deepEqual(sourceFromRequest(incoming({ userAgent: "curl/8.4", referer: "bad://referer", cf: { asn: -1, country: "A1" } })), { asn: null, country: "A1", ua_family: "script", ua_major: null, referrer_class: "invalid", verified_bot: null });
});

test("browser family and same-site categories are stable and non-identifying", () => {
  assert.deepEqual(sourceFromRequest(incoming({ userAgent: "Mozilla/5.0 Edg/151.0", referer: "https://wetbulb35.com/" })).ua_family, "edge");
  assert.deepEqual(sourceFromRequest(incoming({ userAgent: "Mozilla/5.0 Firefox/149.0", referer: "https://www.wetbulb35.com/" })).referrer_class, "site_other");
  assert.deepEqual(sourceFromRequest(incoming({ userAgent: "Mozilla/5.0 Version/18.0 Safari/605.1" })).ua_major, 18);
  assert.deepEqual(sourceFromRequest(incoming({ userAgent: "Mozilla/5.0 Chrome/999.0" })).ua_major, null);
});

test("a forged DO source is revalidated and cannot add raw fields", () => {
  const trusted = sanitizeWeatherSource({ asn: 13335, country: "US", ua_family: "chrome", ua_major: 151, referrer_class: "city_page", verified_bot: true, ip: "198.51.100.10", url: "https://secret.example/?key=raw" });
  assert.deepEqual(trusted, { asn: 13335, country: "US", ua_family: "chrome", ua_major: 151, referrer_class: "city_page", verified_bot: true });
  assert.deepEqual(sanitizeWeatherSource({ asn: 2 ** 40, country: "secret", ua_family: "raw-agent", ua_major: 151, referrer_class: "secret", verified_bot: "true" }), { asn: null, country: null, ua_family: "other", ua_major: null, referrer_class: "invalid", verified_bot: null });
  assert.deepEqual(sanitizeWeatherSource(null), { asn: null, country: null, ua_family: "other", ua_major: null, referrer_class: "invalid", verified_bot: null });
});
