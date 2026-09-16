# Popular-40 deterministic enrichment pilot

## Scope

This phase adds build-time climate and geographic context to the existing 40 Popular city pages. It does not add routes, reorder directories, alter sitemaps, change live weather, use a runtime database, or authorize deployment.

Every page receives:

- reviewed GeoNames identity, IANA timezone, and approximate elevation;
- Beck et al. 1991–2020 Köppen-Geiger classification; and
- NASA POWER 1991–2020 monthly mean `T2MWET` climatology and peak month.

The ten-city review cohort is Dhaka, Dubai, Hong Kong, Houston, Lagos, Mexico City, New Delhi, Phoenix, Singapore, and Tokyo. It spans identity, coastal, island, terrain, arid, temperate, tropical, and high-elevation edge cases. The generator produces all 40 records; these ten receive the deepest source and rendered-copy review.

## Architecture

The production application reads only `data/popular-40-enrichment.v1.json`. The shared renderer imports and validates it once, then renders the same module in static/Vercel and Cloudflare Worker output. No browser, build, Worker, or live request calls GeoNames, Beck, or NASA.

Private raw inputs remain outside Git:

- GeoNames `cities1000.zip` snapshot;
- Beck v3 map archive, 1991–2020 raster, and legend;
- one NASA POWER response per city; and
- the private NASA request/checksum lock.

Committed inputs and outputs are limited to the reviewed canonical-path-to-GeoNames mapping, deterministic generator, compact derived JSON, validator, renderer, tests, and source provenance.

## Source and derivation rules

### GeoNames

- Snapshot: 2026-09-16 `cities1000.zip`.
- License: CC BY 4.0.
- Identity joins by reviewed GeoNames ID, never city name.
- All 40 reviewed records match the site's source coordinates exactly at five decimals.
- Prefer GeoNames `elevation`; otherwise use its `dem` field and retain the source field in the derived record.
- Elevation is approximate point context, not a city-wide average.

### Köppen-Geiger

- Source: Beck et al. v3, 1991–2020, 0.00833333° raster.
- License: CC BY 4.0.
- Render the city-center class only when it equals the 3×3 modal class and modal share is at least 0.67.
- The v3 map bundle has no separate confidence raster. Modal share is a boundary-sensitivity check, not statistical confidence.

### NASA POWER

- Endpoint: point climatology API.
- Parameter: `T2MWET` in °C.
- Period: 1991–2020.
- Time standard: local solar time.
- Source: POWER/MERRA-2.
- Values are rounded half-up to one decimal in the committed artifact.
- Peak months are selected from unrounded source values.
- Copy must call them modeled monthly means, never observations or records.

NASA POWER uses a coarse meteorological grid. Values may not represent local coastal, island, mountain, urban, or neighborhood conditions.

## Regeneration

Use Python 3.11 with `scripts/enrichment-requirements.txt`, then run:

```bash
python scripts/generate-popular-40-enrichment.py \
  --geonames=/private/path/cities1000.zip \
  --beck-zip=/private/path/koppen_geiger_tif.zip \
  --raster=/private/path/koppen_geiger_0p00833333.tif \
  --legend=/private/path/legend.txt \
  --nasa-dir=/private/path/nasa-power-snapshot \
  --out=data/popular-40-enrichment.v1.json
```

The generator fails closed on cohort drift, source hash changes, identity-coordinate mismatches, NASA request-coordinate mismatches, response hash changes, source metadata changes, fill values, invalid units, invalid ranges, raster NoData, or ambiguous Köppen neighborhoods.

A second run from identical private inputs must produce byte-identical output.

## Publication gates

- Exactly 40 records and exact equality with the Popular path set.
- Exactly ten reviewed edge cases.
- One unique path and GeoNames ID per record.
- Static and Worker rendering parity.
- Accessible table and source attribution.
- No visible tier/rank language.
- No route, sitemap, directory-order, live-weather, or autocomplete changes.
- Isolated staging and human review before any production decision.

ERA5-Land hourly processing, date-specific historical extremes, GHSL urban context, coastal distance, station records, and Search Console collection remain separate phases.
