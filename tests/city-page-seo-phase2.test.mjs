import assert from "node:assert/strict";
import test from "node:test";
import { formatCoordinates, pageHtml } from "../lib/page-renderer.mjs";

const usCity = {
  name: "Houston",
  resolvedCountryName: "United States",
  resolvedAdmin1Code: "Texas",
  latitude: 29.7633,
  longitude: -95.3633,
};

function city(overrides) {
  return { ...usCity, ...overrides };
}

function meta(html, selector) {
  return html.match(selector)?.[1];
}

test("city pages have one city-specific H1 and consistent city metadata", () => {
  const html = pageHtml(usCity);
  const title = meta(html, /<title>([^<]+)<\/title>/);
  const description = meta(html, /<meta name="description" content="([^"]+)"/);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<h1[^>]*text-4xl[^>]*>Wet Bulb Temperature in Houston, Texas<\/h1>/);
  const siteHeader = html.match(/<header\b[\s\S]*?<\/header>/)?.[0] ?? "";
  assert.doesNotMatch(siteHeader, /text-4xl/, "the city H1 must be more prominent than the site label");
  assert.equal(title, "Wet Bulb Temperature in Houston, Texas");
  assert.equal(meta(html, /<meta property="og:title" content="([^"]+)"/), title);
  assert.equal(meta(html, /<meta name="twitter:title" content="([^"]+)"/), title);
  assert.equal(meta(html, /<meta property="og:description" content="([^"]+)"/), description);
  assert.equal(meta(html, /<meta name="twitter:description" content="([^"]+)"/), description);
  assert.equal(description, "Get the current wet bulb temperature for Houston, Texas, United States.");
  assert.doesNotMatch(description, /OpenWeather|estimate|wet-bulb/i);
  assert.match(html, /Get the current wet bulb temperature for any location on earth/);
  const subtitleAt = html.indexOf("Get the current wet bulb temperature for any location on earth");
  const searchAt = html.indexOf("data-search-form");
  const currentLocationAt = html.indexOf("data-current-location");
  const breadcrumbAt = html.indexOf('aria-label="Breadcrumb"');
  assert.ok(
    subtitleAt < searchAt && searchAt < currentLocationAt && currentLocationAt < breadcrumbAt,
    "search and current-location controls must follow the subheading and precede breadcrumbs",
  );
  assert.doesNotMatch(html, /wet-bulb/i);
});

test("non-US city titles retain country context deterministically and escape hostile names", () => {
  const html = pageHtml(city({
    name: '<Town & "quoted">',
    resolvedCountryName: "Australia",
    resolvedAdmin1Code: "Queensland",
    latitude: -27.4698,
    longitude: 153.0251,
  }));
  assert.match(html, /<h1[^>]*>Wet Bulb Temperature in &lt;Town &amp; &quot;quoted&quot;&gt;, Queensland, Australia<\/h1>/);
  assert.match(html, /<title>Wet Bulb Temperature in &lt;Town &amp; &quot;quoted&quot;&gt;, Queensland, Australia<\/title>/);
  assert.doesNotMatch(html, /<Town/);
});

test("city coordinates use hemisphere display text while widget datasets retain signed values", () => {
  assert.equal(formatCoordinates(29.7633, -95.3633), "29.7633°N, 95.3633°W");
  assert.equal(formatCoordinates(-33.8688, 151.2093), "33.8688°S, 151.2093°E");
  assert.equal(formatCoordinates(-12.5, -0.25), "12.5000°S, 0.2500°W");
  assert.equal(formatCoordinates(0, 0), "0.0000°N, 0.0000°E");
  const zeroHtml = pageHtml(city({ latitude: 0, longitude: 0 }));
  assert.match(zeroHtml, /data-lat="0"/);
  assert.match(zeroHtml, /data-lon="0"/);
  assert.match(zeroHtml, /0\.0000°N, 0\.0000°E/);
  assert.match(zeroHtml, /Fetching latest weather\.\.\./);
  const html = pageHtml(city({ latitude: -33.8688, longitude: -151.2093 }));
  assert.match(html, /data-lat="-33\.8688"/);
  assert.match(html, /data-lon="-151\.2093"/);
  assert.match(html, /33\.8688°S, 151\.2093°W/);
});

test("city pages expose an ordered, accessible geographic breadcrumb and methodology", () => {
  const html = pageHtml(usCity);
  const canonical = "https://www.wetbulb35.com/wetbulb-temperature/united-states/texas/houston/";
  assert.match(html, /<nav[^>]+aria-label="Breadcrumb"/);
  const breadcrumbs = [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
    .filter(([, href]) => href.startsWith("/wetbulb-temperature/"));
  assert.deepEqual(breadcrumbs.slice(0, 3).map((match) => [match[1], match[2]]), [
    ["/wetbulb-temperature/", "Wet Bulb Temperature"],
    ["/wetbulb-temperature/united-states/", "United States"],
    ["/wetbulb-temperature/united-states/texas/", "Texas"],
  ]);
  assert.match(html, /<span aria-current="page">Houston<\/span>/);
  assert.match(html, /<h2[^>]*>How we calculate the current wet bulb temperature\.<\/h2>/);
  assert.match(html, /We use the Stull formula with current air temperature and relative humidity to calculate the wet bulb temperature\./);
  assert.match(html, /Weather data provided by <a[^>]+href="https:\/\/openweathermap\.org\/"[^>]*>OpenWeather<\/a>/);
  assert.match(html, /<img[^>]+src="\/openweather-logo\.png"[^>]+alt="OpenWeather"[^>]+width="117"[^>]+height="50"/);
  assert.match(html, /Stull/);
  assert.match(html, /Disclaimer: This estimate has limitations/i);
  assert.match(html, /not a substitute for heat safety guidance/i);
  assert.equal((html.match(/estimat/gi) || []).length, 1, "estimate language belongs only in the disclaimer");
  const h1End = html.indexOf("</h1>");
  assert.equal(html.slice(0, h1End).includes("OpenWeather"), false, "provider attribution belongs at the bottom, not in top metadata or copy");
  assert.match(html, new RegExp(`<link rel="canonical" href="${canonical}">`));
  assert.match(html, /"@type":"BreadcrumbList"/);
  assert.doesNotMatch(html, /Related cities/i);
});

test("city-page desktop centering class contract remains intact", () => {
  const html = pageHtml(usCity);
  assert.match(html, /<div class="max-w-4xl mx-auto space-y-8">/);
  assert.match(html, /<div class="bg-white p-6 rounded-lg shadow-lg max-w-2xl mx-auto" data-weather-widget/);
});
