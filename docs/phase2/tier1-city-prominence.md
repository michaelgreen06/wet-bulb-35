# Tier-1 city prominence

## Scope

This feature adds a sanitized, versioned Tier-1 city manifest and uses it only for internal-link prominence. It does not expose research scores, analytics, Search Console data, or raw research inputs.

## Manifest

`scripts/tier1-city-manifest.json` contains exactly 200 canonical paths:

- ranks 1–50: Tier 1A;
- ranks 51–100: Tier 1B;
- ranks 101–200: Tier 1C; and
- exactly 40 entries marked for the user-facing Popular Cities section.

Each entry contains only `rank`, `tier`, `path`, and `popular`. Runtime validation fails closed on malformed paths, duplicate or missing ranks, duplicate paths, incorrect tier counts, or an incorrect Popular count. Every path must resolve exactly once from the canonical city inventory.

## Visible behavior

- `/wetbulb-temperature/` displays **Popular Wet Bulb Temperatures** with 40 unique canonical city links, ordered alphabetically for navigation.
- Country directory pages place regions containing Tier-1 cities first.
- Region directory pages place Tier-1 cities first, preserving alphabetical order within the featured and ordinary groups.
- Ranks, tiers, and scores are not shown to users.
- The homepage is unchanged; it continues to link to `/wetbulb-temperature/`.

## Added canonical cities

Two reviewed GeoNames capital records were absent because the legacy importer rejected records without an administrative-region value:

- Singapore (`geonameid` 1880252): `/wetbulb-temperature/singapore/singapore/singapore/`
- Hong Kong (`geonameid` 1819729): `/wetbulb-temperature/hong-kong/hong-kong/hong-kong/`

The temporary country-as-region fallback preserves the current three-level route contract. The broader city-data pipeline correction is tracked in [PR #14](https://github.com/michaelgreen06/wet-bulb-35/pull/14).

## Sitemap behavior

The sitemap tree contains 130,686 canonical city routes. Singapore receives its own country sitemap; Hong Kong is added to its existing country sitemap. No sitemap `priority` or `changefreq` metadata is added.

## Verification

Tests require:

- exact manifest size, rank sequence, tier split, Popular count, and path uniqueness;
- no analytics or scoring fields in the production manifest;
- all 200 paths to resolve exactly once;
- Singapore and Hong Kong to render canonical pages;
- exactly 40 unique Popular links from both static and Worker renderers;
- Tier-1 directory ordering without duplicate links;
- exact renderer/sitemap city-route equality; and
- the complete 130,686-city Worker metadata inventory to resolve.
