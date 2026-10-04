# All-location city facts: population, local time, elevation

**PR implementation; isolated staging deployed October 4, 2026; production not deployed.** This adds a compact, sourced “About [location]” section below the wet bulb card. The page still loads no weather provider while rendering. The three facts are optional **per field** when source evidence is missing; an unavailable location never inherits a nearby town's values. URLs, canonicals, directories, sitemaps, weather, and forecast are unchanged.

## Public source and coverage

A pinned GeoNames `cities1000.zip` snapshot from September 29, 2026 (SHA-256 `0ba3eedb8b7c04f2b0fa9396e8c5f8746c432c76c4f247f63cc9fd63f39ceec5`; CC BY 4.0) provides all three facts. Its **retrieval/snapshot date is not the population measurement year**. Copy explicitly says GeoNames' population reference year is not provided and avoids “population as of September 2026.” Population represents the source settlement, not necessarily its metropolitan area. Elevation is the approximate mapped point's value, using the source elevation field or DEM fallback, not citywide altitude.

- Canonical routes: 130,686, unchanged.
- Verified GeoNames identity/timezone/elevation joins: 129,313; 1,367 remain unmatched and six routes share three ambiguous matched IDs and are quarantined. No incorrect ID is published to either claimant.
- Usable displayed values: population 129,310, IANA timezone/local clock 129,313, elevation 129,076. Three source populations are zero/unknown; 237 DEM cells have `-9999` NoData and display no elevation. Each unsupported field is omitted rather than shown as zero.
- The older population sidecar remains in place for nearby-link ranking. It is keyed by coordinates and from a different snapshot; it is **not** blindly joined to the three public page facts. Identity is keyed by canonical path and reviewed GeoNames ID here, with namesake and coordinate-distance gates.

The browser updates local time in the validated IANA timezone and on tab resume. Crawlers receive the timezone and static facts in HTML, but no frozen “current time” in a 24-hour cached page. The `About` section follows the primary wet bulb card. Existing Popular-40 climate pages already show elevation in their climate module, so it is not repeated there.

## Identity review backlog — six ambiguous routes

The pinned identity pass assigned the **same GeoNames ID to two different canonical routes** in each pair below. Both routes keep their URL and page, but this first facts release leaves their population, local clock, and elevation unavailable rather than assigning one source locality to both. These are **not** the separate 1,367 unmatched routes.

- GeoNames ID `3979846`: `/wetbulb-temperature/mexico/michoacan/zacapu-19-8140-w101-7916/` and `/wetbulb-temperature/mexico/michoacan/zacapu-19-8219-w101-7893/`.
- GeoNames ID `4010155`: `/wetbulb-temperature/mexico/coahuila/coyote/` and `/wetbulb-temperature/mexico/coahuila/san-antonio-del-coyote/`.
- GeoNames ID `695357`: `/wetbulb-temperature/ukraine/donetsk/kurakhove/` and `/wetbulb-temperature/ukraine/donetsk/kurakhovo/`.

**Later review:** compare each candidate's GeoNames coordinates, admin codes, feature class, alternate names and source history with both inventory coordinates and route history. Decide whether these are two settlements, an alias, or a historical route collision before associating a unique ID, changing copy, or proposing any redirect. No automatic canonical/route migration and no borrowed facts in this PR.

## Regeneration and test boundary

Private input ZIP and the cautious 2026-09-29 path-to-GeoNames-ID index stay outside Git. To regenerate, build the exact current route index, then run:

```sh
node scripts/probe-location-route-identity.mjs --source=scripts/resolved_cities.json --out=/PRIVATE/routes.json
python3 scripts/generate-location-facts.py \
  --source=/PRIVATE/geonames-cities1000-2026-09-29.zip \
  --identity-index=/PRIVATE/city-index-c8b6-20260929.json \
  --route-index=/PRIVATE/routes.json \
  --output=data/location-facts.v1.json
npm run test:location-facts
npm run dry-run:weather-production-domain
```

The generator requires the pinned source hash and the **entire** canonical route set. It rejects source drift, identity/source timezone mismatch, >3 km matched-coordinate drift, invalid IANA zones, or unphysical values; it quarantines shared source IDs and omits NoData values. Two real-input regenerations were byte-identical (`5b42b7b7d0f337a2df6ea44d4e5725c178daf9fc483871f369cbfad86b0d47cd`). The derived 12.86 MB artifact is public data; no raw source ZIP, credentials, private analytics or research report is committed.

The production Worker asset build validates every route/fact pair and folds the compact tuple into its existing private country metadata shards. In local checks, all 130,686 rows and their count contracts matched; the largest shard was 8.14 MB. The production-config Wrangler dry run succeeded. Existing renderer, route, forecast, weather and Turnstile tests passed. A route-free **local** Wrangler run rendered sampled large-country and international pages, a missing-data route, private-metadata 404s and provider-free crawler requests without errors; a real 390-pixel browser had no horizontal overflow and its clock used the location's timezone.

## Isolated Cloudflare staging — October 4, 2026

Michael separately authorized a staging deployment, **not** a PR merge or production deployment. PR head `98a2b21a506643d683b71fceec3aeb730619ea8a` was built and deployed to a new, route-free `wetbulb35-location-facts-staging` Worker version `6d6219f3-e4b8-4438-ab86-85508a0f1c7f` at `https://wetbulb35-location-facts-staging.mgdevstuff.workers.dev`. Its no-route/no-custom-domain settings, active 100% version and untouched shared staging Worker were read back via Cloudflare. This preview uses a staging-only config and copied asset tree outside Git; `robots.txt` disallows crawling. Analytics is disabled.

Remote Googlebot-UA HTML requests succeeded for ordinary pages across nine countries, including the five largest shards, with a second five-shard pass after LRU eviction. Three sampled ambiguous routes still omit the facts. Private manifest and shard URLs return 404. A real 390px browser showed population, an updating `America/Chicago` local clock, approximate elevation and no horizontal overflow. This isolated preview intentionally has **no OpenWeather secret and no Turnstile secret**: use it to inspect the static facts/layout, **not** to assess current-weather parity. We did not copy production secrets or enable provider calls. Forecast and existing shared staging behavior are outside this preview. Live production and PR merge remain separately approval-gated.
