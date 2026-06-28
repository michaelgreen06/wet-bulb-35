import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSiteData,
  escapeHtml,
  generateStaticSite,
  getRouteParts,
  pageHtml,
  prepareCities,
  renderBrowsePage,
  renderCountryPage,
  renderHomePage,
  renderStatePage,
  routePathForCity,
} from "../scripts/prototype-static-generator.mjs";
import {
  createWeatherHandler,
  isBlockedBot,
} from "../lib/server/weather-api.js";

const uniqueCity = {
  name: "Vila",
  resolvedCountryName: "Andorra",
  resolvedAdmin1Code: "Encamp",
  latitude: 42.53176,
  longitude: 1.56654,
};

const collidingCities = [
  {
    name: "Metsamor",
    resolvedCountryName: "Armenia",
    resolvedAdmin1Code: "Armavir",
    latitude: 40.07233,
    longitude: 44.29169,
  },
  {
    name: "Metsamor",
    resolvedCountryName: "Armenia",
    resolvedAdmin1Code: "Armavir",
    latitude: 40.14447,
    longitude: 44.1167,
  },
];

const sampleCities = [
  uniqueCity,
  ...collidingCities,
  {
    name: "Denver",
    resolvedCountryName: "United States",
    resolvedAdmin1Code: "North Carolina",
    latitude: 35.53124,
    longitude: -81.0298,
  },
  {
    name: "Raleigh",
    resolvedCountryName: "United States",
    resolvedAdmin1Code: "North Carolina",
    latitude: 35.77959,
    longitude: -78.63818,
  },
  {
    name: "Austin",
    resolvedCountryName: "United States",
    resolvedAdmin1Code: "Texas",
    latitude: 30.26715,
    longitude: -97.74306,
  },
];

function routeFor(city) {
  const { countrySlug, stateSlug, citySlug } = getRouteParts(city);
  return `${countrySlug}/${stateSlug}/${citySlug}`;
}

function tagSignature(html) {
  return [...new Set([...html.matchAll(/<([a-z][a-z0-9-]*)([^>]*)>/gi)].map(
    ([, tagName, attrs]) => {
      const attrNames = [...attrs.matchAll(/\s([:@a-zA-Z0-9_-]+)=/g)]
        .map((match) => match[1])
        .sort();
      return `${tagName.toLowerCase()}[${attrNames.join(",")}]`;
    },
  ))];
}

function collectHrefs(html) {
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
}

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    ended: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(payload = "") {
      this.body = payload;
      this.ended = true;
    },
  };
}

test("prepareCities keeps normal URLs clean and makes collisions unique", () => {
  const result = prepareCities([uniqueCity, ...collidingCities]);
  const routes = result.cities.map(routeFor);

  assert.equal(result.collisionGroups, 1);
  assert.equal(result.collisionRows, 2);
  assert.equal(new Set(routes).size, routes.length);
  assert.ok(routes.includes("andorra/encamp/vila"));
  assert.ok(routes.includes("armenia/armavir/metsamor-40-0723-44-2917"));
  assert.ok(routes.includes("armenia/armavir/metsamor-40-1445-44-1167"));
});

test("escapeHtml protects generated text and attributes", () => {
  assert.equal(
    escapeHtml('A&B <Test> "Town"'),
    "A&amp;B &lt;Test&gt; &quot;Town&quot;",
  );
});

test("pageHtml emits required SEO and weather widget structure", () => {
  const [city] = prepareCities([uniqueCity]).cities;
  const html = pageHtml(city, { siteUrl: "https://example.test" });

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Wet Bulb Temperature in Vila, Encamp, Andorra<\/title>/);
  assert.match(
    html,
    /<meta name="description" content="Live wet bulb temperature and weather conditions for Vila, Encamp, Andorra\.">/,
  );
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/example\.test\/wetbulb-temperature\/andorra\/encamp\/vila\/">/,
  );
  assert.match(html, /data-weather-widget=""/);
  assert.match(html, /data-lat="42\.53176"/);
  assert.match(html, /data-lon="1\.56654"/);

  const jsonLdMatch = html.match(
    /<script type="application\/ld\+json">(.+?)<\/script>/,
  );
  assert.ok(jsonLdMatch);

  const jsonLd = JSON.parse(jsonLdMatch[1]);
  assert.equal(jsonLd["@type"], "BreadcrumbList");
  assert.equal(jsonLd.itemListElement.length, 4);
  assert.equal(jsonLd.itemListElement[3].name, "Vila");
});

test("page templates include expected listings and route counts", () => {
  const siteData = createSiteData(sampleCities);
  const homeHtml = renderHomePage(siteData, { siteUrl: "https://example.test" });
  const browseHtml = renderBrowsePage(siteData, { siteUrl: "https://example.test" });
  const countryHtml = renderCountryPage(
    siteData.countries.find((item) => item.slug === "united-states"),
    { siteUrl: "https://example.test" },
  );
  const stateHtml = renderStatePage(
    siteData.states.find(
      (item) =>
        item.countrySlug === "united-states" &&
        item.stateSlug === "north-carolina",
    ),
    { siteUrl: "https://example.test" },
  );

  assert.match(homeHtml, /Current Wet Bulb Temperature/);
  assert.match(homeHtml, /Browse all countries/);
  assert.match(browseHtml, /Browse Wet Bulb Temperature by Country/);
  assert.match(browseHtml, />United States</);
  assert.match(browseHtml, />3 locations</);
  assert.match(countryHtml, /Browse United States by State\/Province/);
  assert.match(countryHtml, />North Carolina</);
  assert.match(countryHtml, />2 locations</);
  assert.match(stateHtml, /Cities in North Carolina, United States/);
  assert.match(stateHtml, /Denver/);
  assert.match(stateHtml, /Raleigh/);
});

test("generated pages share stable DOM fingerprints per page type", () => {
  const siteData = createSiteData(sampleCities);
  const [cityA, cityB] = siteData.cities.filter(
    (item) => item.resolvedCountryName === "United States",
  );
  const [countryA, countryB] = siteData.countries;
  const [stateA, stateB] = siteData.states.filter(
    (item) => item.countryName === "United States",
  );

  assert.deepEqual(tagSignature(pageHtml(cityA)), tagSignature(pageHtml(cityB)));
  assert.deepEqual(
    tagSignature(renderCountryPage(countryA)),
    tagSignature(renderCountryPage(countryB)),
  );
  assert.deepEqual(
    tagSignature(renderStatePage(stateA)),
    tagSignature(renderStatePage(stateB)),
  );
});

test("generateStaticSite writes expected routes and valid internal assets", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wetbulb-static-test-"));
  const sourcePath = path.join(tmpDir, "source.json");
  fs.writeFileSync(sourcePath, JSON.stringify(sampleCities));

  const result = generateStaticSite({
    outDir: path.join(tmpDir, "dist"),
    sourceFile: sourcePath,
    siteUrl: "https://example.test",
  });

  assert.equal(result.written, 15);

  const expectedFiles = [
    "index.html",
    "wetbulb-temperature/index.html",
    "wetbulb-temperature/andorra/index.html",
    "wetbulb-temperature/andorra/encamp/index.html",
    "wetbulb-temperature/andorra/encamp/vila/index.html",
    "wetbulb-temperature/united-states/index.html",
    "wetbulb-temperature/united-states/north-carolina/index.html",
    "wetbulb-temperature/united-states/north-carolina/denver/index.html",
    "assets/app.css",
    "assets/app.js",
    "assets/locations.json",
    "robots.txt",
    "favicon.svg",
  ];

  for (const file of expectedFiles) {
    assert.ok(fs.existsSync(path.join(result.outDir, file)), file);
  }

  const siteData = createSiteData(sampleCities);
  const htmlFiles = [...siteData.pageRoutes].map((routePath) =>
    routePath === "/"
      ? path.join(result.outDir, "index.html")
      : path.join(result.outDir, routePath.replace(/^\/|\/$/g, ""), "index.html"),
  );
  const knownAssets = new Set([
    "/favicon.svg",
    "/assets/app.css",
    "/assets/app.js",
    "/assets/locations.json",
    "/images/wetbulb-default.jpg",
    "/robots.txt",
    "/sitemap.xml",
  ]);

  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, "utf8");
    const hrefs = collectHrefs(html);

    for (const href of hrefs) {
      if (href.startsWith("https://") || href.startsWith("mailto:")) {
        continue;
      }

      assert.ok(
        siteData.pageRoutes.has(href) || knownAssets.has(href),
        `${path.relative(result.outDir, file)} -> ${href}`,
      );
    }
  }

  const locations = JSON.parse(
    fs.readFileSync(path.join(result.outDir, "assets/locations.json"), "utf8"),
  );
  assert.equal(locations.length, siteData.cities.length);
  assert.equal(new Set(locations.map((item) => item.url)).size, locations.length);
});

test("weather API handler covers valid input, invalid input, bots, and upstream failures", async () => {
  const payload = {
    location: {
      name: "Denver",
      lat: 35.53124,
      lng: -81.0298,
    },
    weather: {
      temperature: 27.1,
      humidity: 66,
      wetBulb: 21.3,
      timestamp: 1710000000000,
    },
  };

  const handler = createWeatherHandler({
    fetchWeatherData: async (lat, lon) => ({
      ...payload,
      location: { ...payload.location, lat, lng: lon },
    }),
  });

  const okRes = createMockResponse();
  await handler(
    {
      method: "GET",
      url: "http://localhost/api/weather?lat=35.53124&lon=-81.0298",
      headers: { "user-agent": "Mozilla/5.0" },
    },
    okRes,
  );

  assert.equal(okRes.statusCode, 200);
  assert.match(okRes.headers["Cache-Control"], /no-store/);
  assert.deepEqual(JSON.parse(okRes.body), payload);

  const invalidRes = createMockResponse();
  await handler(
    {
      method: "GET",
      url: "http://localhost/api/weather?lat=abc&lon=1",
      headers: { "user-agent": "Mozilla/5.0" },
    },
    invalidRes,
  );
  assert.equal(invalidRes.statusCode, 400);
  assert.match(invalidRes.body, /Valid lat and lon are required/);

  const botRes = createMockResponse();
  await handler(
    {
      method: "GET",
      url: "http://localhost/api/weather?lat=1&lon=2",
      headers: { "user-agent": "Googlebot" },
    },
    botRes,
  );
  assert.equal(botRes.statusCode, 204);
  assert.equal(botRes.body, "");

  const methodRes = createMockResponse();
  await handler(
    {
      method: "POST",
      url: "http://localhost/api/weather?lat=1&lon=2",
      headers: { "user-agent": "Mozilla/5.0" },
    },
    methodRes,
  );
  assert.equal(methodRes.statusCode, 405);
  assert.equal(methodRes.headers.Allow, "GET");

  const failingHandler = createWeatherHandler({
    fetchWeatherData: async () => {
      throw new Error("upstream exploded");
    },
  });

  const errorRes = createMockResponse();
  await failingHandler(
    {
      method: "GET",
      url: "http://localhost/api/weather?lat=1&lon=2",
      headers: { "user-agent": "Mozilla/5.0" },
    },
    errorRes,
  );
  assert.equal(errorRes.statusCode, 500);
  assert.match(errorRes.body, /upstream exploded/);
});

test("bot detection matches major crawler user agents", () => {
  assert.equal(isBlockedBot("Mozilla/5.0"), false);
  assert.equal(isBlockedBot("Googlebot/2.1"), true);
  assert.equal(isBlockedBot("SemrushBot"), true);
  assert.equal(isBlockedBot(undefined), false);
});

test("routePathForCity uses collision-safe slug when needed", () => {
  const prepared = createSiteData(collidingCities).cities;
  const routes = prepared.map(routePathForCity);

  assert.deepEqual(routes.sort(), [
    "/wetbulb-temperature/armenia/armavir/metsamor-40-0723-44-2917/",
    "/wetbulb-temperature/armenia/armavir/metsamor-40-1445-44-1167/",
  ]);
});
