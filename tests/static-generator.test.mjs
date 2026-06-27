import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeHtml,
  getRouteParts,
  pageHtml,
  prepareCities,
} from "../scripts/prototype-static-generator.mjs";

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

function routeFor(city) {
  const { countrySlug, stateSlug, citySlug } = getRouteParts(city);
  return `${countrySlug}/${stateSlug}/${citySlug}`;
}

function tagSignature(html) {
  return [...html.matchAll(/<([a-z][a-z0-9]*)([^>]*)>/gi)].map(
    ([, tagName, attrs]) => {
      const attrNames = [...attrs.matchAll(/\s([:@a-zA-Z0-9_-]+)(?==|\s|$)/g)]
        .map((match) => match[1])
        .sort();
      return `${tagName.toLowerCase()}[${attrNames.join(",")}]`;
    },
  );
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
  assert.match(html, /id="weather-widget"/);
  assert.match(html, /data-lat="42\.53176"/);
  assert.match(html, /data-lng="1\.56654"/);

  const jsonLdMatch = html.match(
    /<script type="application\/ld\+json">(.+?)<\/script>/,
  );
  assert.ok(jsonLdMatch);

  const jsonLd = JSON.parse(jsonLdMatch[1]);
  assert.equal(jsonLd["@type"], "BreadcrumbList");
  assert.equal(jsonLd.itemListElement.length, 4);
  assert.equal(jsonLd.itemListElement[3].name, "Vila");
});

test("generated pages share the same structural fingerprint", () => {
  const [firstCity, secondCity] = prepareCities([
    uniqueCity,
    {
      name: "Paraipaba",
      resolvedCountryName: "Brazil",
      resolvedAdmin1Code: "Ceara",
      latitude: -3.43944,
      longitude: -39.14833,
    },
  ]).cities;

  assert.deepEqual(
    tagSignature(pageHtml(firstCity)),
    tagSignature(pageHtml(secondCity)),
  );
});
