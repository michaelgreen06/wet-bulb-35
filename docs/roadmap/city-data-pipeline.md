# City data pipeline roadmap

## Status

Roadmap only. This document does not authorize a city-data refresh, URL migration, deployment, or production change.

## Decision

Keep GeoNames as WetBulb35's canonical locality inventory, but replace the lossy one-time importer with a versioned, deterministic pipeline built from `cities1000.zip` and the matching GeoNames reference files.

Use UN World Urbanization Prospects and Natural Earth as independent coverage checks. They should not replace GeoNames or silently overwrite GeoNames identities.

## Why this is needed

The current 130,684-row `scripts/resolved_cities.json` was generated in February 2025 from a GeoNames `allCountries.txt` export. The exact snapshot date, hashes, and required `admin1CodesASCII.txt` input were not preserved.

The current importer:

- keeps populated places with population at least 1,000;
- drops every place without a resolvable administrative-region value;
- drops `geonameid`, feature code, population, alternate names, source codes, and modification date;
- derives country names through hand-written string cleanup;
- cannot distinguish a rename, move, deletion, new place, or source correction during a later refresh; and
- derives URLs from mutable country, region, city, and coordinate values.

A comparison against a current GeoNames snapshot found:

- 147,968 comparable current populated places versus 130,684 committed rows;
- 123,083 exact surviving name/country/coordinate matches;
- Singapore, Hong Kong, Nouakchott, Laayoune, Willemstad, and other important records dropped by the administrative-region requirement;
- Kosovo excluded because the country lookup lacks `XK`;
- `Trinidad and Tobago` rewritten to `Tobago`;
- `Antigua and Barbuda` rewritten to `Barbuda`; and
- `Isle of Man` rewritten to `Man`.

The unmatched totals are audit leads, not automatic additions or removals, because the legacy inventory discarded stable IDs.

The current route inventory also contains 1,419 country/admin1/name collision groups covering 3,014 rows. A reconciliation against the pinned September 16, 2026 `cities1000` snapshot found:

- 1,238 groups reconcile exactly by name and coordinates;
- every reconciled row in those groups has a distinct GeoNames ID;
- 963 reconciled groups span different admin2 areas;
- 1,114 reconciled groups have their closest two places more than 25 km apart; and
- only three reconciled groups contain places within 1 km of each other.

Therefore, most route collisions are distinct namesake localities, not duplicate source records. Shared country, admin1, and display name are not sufficient grounds to merge or delete an entity.

## Target source inputs

Use one dated GeoNames release containing:

- `cities1000.zip`;
- `countryInfo.txt`;
- `admin1CodesASCII.txt`;
- `admin2Codes.txt`;
- `alternateNamesV2.zip`;
- `featureCodes.txt`; and
- applicable modification/deletion files when delta analysis is useful.

For every release, preserve source URLs, retrieval time, byte sizes, SHA-256 hashes, generator version, and source licence. GeoNames data requires CC BY 4.0 attribution.

## Canonical record

Preserve at least:

- immutable WetBulb ID;
- GeoNames ID;
- source and modification date;
- primary, ASCII, and language-tagged alternate names;
- feature class/code;
- population, with source semantics retained;
- WGS84 coordinates;
- ISO country code;
- raw admin1-admin4 codes;
- resolved country/admin display labels;
- timezone;
- inclusion/exclusion reason; and
- active, retired, or review status.

Country and administrative identity must come from codes, never free-text cleanup. Missing admin1 is valid input and must receive an explicit fallback policy rather than deletion.

## Namesakes, duplicates, and primary localities

Classify records before making a route decision:

- **Namesakes** are distinct entities with different stable IDs. Retain each eligible locality.
- **True duplicates** are multiple source records for the same real entity. Merge or retire one only after reviewed evidence based on stable source IDs, feature type, admin codes, aliases, coordinates, and authoritative cross-references.
- **Ambiguous matches** remain separate and held for review. Never deduplicate automatically from display-name or proximity matching alone.

For each country/admin1/name collision group:

1. choose at most one reviewed primary locality for the unsuffixed human-readable route;
2. rank primary candidates using explicit, versioned evidence such as settlement status, feature code, population, admin level, and manual overrides;
3. give every retained secondary namesake a stable-ID suffix, never a coordinate suffix;
4. display admin2/county or another useful disambiguator in search results, directories, headings, and metadata; and
5. preserve the decision in the immutable route registry so later source changes cannot silently select a different winner.

Wilson, Oklahoma illustrates the policy. GeoNames contains distinct populated-place records `4555790` in Carter County and `4555791` in Okmulgee County. The Carter County place is the historical first-row winner and the candidate primary for `/united-states/oklahoma/wilson/`; the retained Okmulgee County namesake needs a stable secondary route such as `wilson-4555791/` and a visible county label. This is a primary-route decision, not evidence that either record should be deleted.

## URL and rename policy

Create an immutable route registry:

`wetbulb_id -> canonical WetBulb35 path`

Existing canonical paths remain unchanged when a source changes a display name, administrative region, population, feature code, or coordinates. Visible labels may update after review without moving the page.

Only an explicitly approved legal/correctness migration may change a canonical path. It must have a one-hop permanent redirect tied to the same stable entity ID. Never infer redirects by fuzzy matching or proximity.

For new route collisions, preserve the existing claimant of an unsuffixed path. Allocate a stable-ID suffix to the new entity. Never rename every member of a group merely because a collision appeared or disappeared.

The one-time migration must account for all previously advertised route forms:

- unsuffixed country/admin1/city paths that formerly collapsed multiple records;
- current coordinate-suffixed paths; and
- older city/admin1/country paths.

Each former URL must redirect in one hop to the reviewed stable entity route. Where an old ambiguous path historically rendered the first matching row, preserve that identity unless an explicit reviewed primary-locality decision changes it.

## Required tests

### Source accounting

- Every qualifying GeoNames ID is included or has one explicit exclusion reason.
- Every source/reference file has a pinned hash.
- Generation from identical inputs is byte-for-byte deterministic.
- IDs, paths, and active records are unique.
- Every collision group is classified as namesakes, true duplicates, or unresolved review items.
- Every retained namesake has one stable route and enough admin metadata to distinguish it from peers.
- Every primary-route decision is deterministic, reviewable, and preserved across source refreshes.
- Coordinates, country codes, dates, feature codes, and population values validate.

### Independent coverage

Maintain an independent fixture covering:

- every Tier-1 city;
- national capitals;
- a reviewed UN WUP major-city set;
- representative city-states and territories;
- non-Latin scripts and renamed cities;
- missing-admin cases;
- disputed or unusual administrative structures; and
- route-collision examples.

Each fixture must resolve to exactly one stable entity, the expected ISO country, plausible coordinates, an active canonical route, a rendered 200 page, and one sitemap entry.

### Release continuity

- No existing entity loses or changes its route without an approved retirement or redirect decision.
- Renderer lookup, canonical tags, JSON-LD, Open Graph URLs, internal links, and sitemaps use the same route registry.
- Redirects are exact, one hop, cycle-free, absent from sitemaps, and point to active routes.
- Missing or deleted upstream records remain held for review rather than disappearing automatically.

### Change guardrails

Block for review on:

- any major-city fixture failure;
- any unexplained canonical-route removal or reassignment;
- more than 0.25% removals;
- more than 1% additions;
- more than 0.5% country/admin reassignments;
- more than 0.5% coordinate changes;
- any coordinate move over 25 km;
- unexpected population or feature-code changes; or
- more than 25 proposed redirects.

Thresholds are tripwires, not automatic approval below the threshold.

## Scheduled workflow

Run a monthly scheduled candidate job:

1. Acquire and hash a new GeoNames snapshot.
2. Normalize it without network access during generation.
3. Reconcile by GeoNames ID against the last approved snapshot.
4. Preserve the route registry.
5. Classify additions, metadata changes, label changes, boundary changes, suspected omissions, retirements, and route migrations.
6. Run all coverage, determinism, route, renderer, and sitemap tests.
7. Produce a review report and candidate PR.
8. Never merge or deploy automatically.

Review approved metadata updates quarterly. Important corrections may use the same workflow out of cycle.

## One-time migration

The first migration is high risk because the current inventory discarded GeoNames IDs:

1. Freeze and hash the existing inventory and full canonical route set.
2. Reconcile legacy rows to a pinned GeoNames snapshot using names, aliases, source codes where recoverable, coordinates, feature type, and population.
3. Classify every route-collision group and review all possible true duplicates.
4. Assign primary unsuffixed and secondary stable-ID routes without deleting legitimate namesakes.
5. Carry every confirmed stable route forward and create one-hop redirects from superseded unsuffixed and coordinate-suffixed forms.
6. Retain unmatched legacy routes under stable temporary legacy IDs; do not delete them.
7. Allocate routes only for reviewed new entities.
8. Require every existing route to be matched or explicitly retained, with zero unexplained route loss.
9. Stage and verify the exact candidate artifact before requesting production approval.

## Implementation sequence

1. **Pipeline PR:** schema, source manifest, deterministic generator, tests, and scheduled candidate workflow; no city or URL changes.
2. **Reconciliation PR:** stable IDs and immutable route registry for all existing routes; no route removals.
3. **Correction PR:** reviewed missing cities and country-name fixes, including Singapore, Hong Kong, Nouakchott, Kosovo, and Port of Spain.
4. **Recurring updates:** monthly candidate generation, human approval, staged verification, and immutable rollback artifacts.

Production remains behind the existing backup, restore, staging, and explicit-approval gates.