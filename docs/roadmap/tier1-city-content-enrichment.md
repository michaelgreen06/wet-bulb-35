# Tier-1 city content enrichment roadmap

## Status and authorization

This document records a proposed deterministic content-enrichment pipeline. It does not authorize source downloads, production changes, ranking changes, deployment, or automatic publication. Each implementation phase requires a reviewed pull request. Raw third-party datasets stay outside Git; only compact derived records, provenance, templates, and validation code belong in the repository.

## Objective

Add useful, city-specific climate and geographic context to priority pages without LLM-written facts, duplicated filler, invented precision, or implying that SEO priority equals physical danger.

Keep three independent concepts:

1. **Popular 40:** recognizable navigation destinations, alphabetized.
2. **Opportunity 200:** pages selected for audience and search opportunity.
3. **Climate-qualified subsets:** cities that meet explicit humid-heat relevance requirements.

Use Top 50, Top 100, and Top 200 as internal investment levels. Do not show ranks or tiers to visitors and do not reorder country or region directories; normal directories remain alphabetical.

## Recommended source architecture

### Climate classification

Use the Beck et al. global Köppen-Geiger maps for 1991–2020 at approximately 1 km resolution:

- Source: https://www.gloh2o.org/koppen/
- Output: climate code, plain-English class, source period, confidence, and the dominant class around the urban point or polygon.
- Limitation: Köppen class describes long-term climate, not wet-bulb danger.

### Historical humid heat

Use ERA5-Land hourly 2 m temperature and dew-point temperature for a fixed reference period, initially 1991–2020:

- Source: https://copernicus.eu/en/access-data/copernicus-services-catalogue/era5-land-hourly-time-series-data-1950-present
- Resolution: approximately 9 km.
- Derive relative humidity and wet-bulb temperature with versioned formulas.
- Output monthly distributions, percentiles, threshold frequencies, seasonality, and trends.
- Describe results as reanalysis estimates rather than station observations.

NASA POWER is an acceptable prototype source because its point API directly exposes climatology and wet-bulb-related parameters:

- Source: https://power.larc.nasa.gov/docs/services/api/temporal/climatology/
- Limitation: meteorological resolution is approximately 0.5° × 0.625°, so it is weaker for coasts, mountains, islands, and urban microclimates.

Do not mix NASA POWER and ERA5-Land values on published pages without clearly identifying each source and reference period.

### High-resolution climate normals

Use one source consistently when terrain-sensitive normals are useful:

- CHELSA climatologies: https://www.chelsa-climate.org/datasets/chelsa_climatologies
- WorldClim 2.1: https://www.worldclim.org/data/worldclim21.html

CHELSA is preferred for a new implementation because it provides global kilometer-scale climatology under CC0. WorldClim remains useful for monthly temperature, precipitation, vapor pressure, wind, and standard bioclimatic variables, but its principal present-day baseline is 1970–2000.

### Urban context

Use the Global Human Settlement Layer Urban Centre Database for internationally comparable urban-centre facts:

- Source: https://data.europa.eu/doi/10.2905/JRC.05RDPR0
- Output: urban-centre population, land area, density, built-up area, and change through time.

UN World Urbanization Prospects may validate population and growth for major cities. Do not silently combine municipal, metropolitan, and continuous-urban-area populations.

### Geographic context

Use GeoNames stable identifiers and Natural Earth geometry:

- GeoNames: identity, alternate names, timezone, elevation, feature class, country and administrative codes.
- Natural Earth: https://www.naturalearthdata.com/
- Derive latitude band and distance to the ocean or major coastline.

Treat elevation and coastal distance as context, not proof of climate causation.

### National validation

For US cities, NOAA 1991–2020 Climate Normals can validate gridded estimates:

- Source: https://www.ncei.noaa.gov/products/land-based-station/us-climate-normals

Equivalent national services can be added to manually reviewed Top-50 pages later. They should not be required for the first globally consistent pipeline.

## Derived content fields

Store compact, typed values rather than prose:

```json
{
  "schemaVersion": 1,
  "geonameId": 0,
  "canonicalPath": "/wetbulb-temperature/country/region/city/",
  "referencePeriod": "1991-2020",
  "koppen": {
    "code": "Aw",
    "label": "tropical wet-and-dry",
    "confidence": 0.0,
    "sourceVersion": ""
  },
  "humidHeat": {
    "formulaVersion": "",
    "peakMonths": [],
    "monthlyWetBulbC": [],
    "p95WetBulbC": 0.0,
    "p99WetBulbC": 0.0,
    "annualHoursAboveC": {
      "24": 0,
      "26": 0,
      "28": 0,
      "30": 0
    },
    "trendCPerDecade": 0.0
  },
  "geography": {
    "elevationM": 0,
    "coastalDistanceKm": 0.0,
    "timezone": ""
  },
  "urbanCentre": {
    "definition": "GHSL Degree of Urbanisation urban centre",
    "population": 0,
    "populationYear": 0,
    "landAreaKm2": 0.0,
    "densityPerKm2": 0.0
  },
  "provenance": []
}
```

Use `null` for unavailable values. Never substitute zero for missing data in implementation.

## Deterministic generation

For every build:

1. Pin source name, release, reference period, URL, license, retrieval date, and SHA-256 checksum.
2. Resolve cities through stable GeoNames IDs and the canonical route registry, not names alone.
3. Use a documented spatial rule: urban polygon aggregate when available; otherwise centroid plus a fixed neighborhood sensitivity check.
4. Calculate all statistics with versioned, tested formulas and fixed rounding rules.
5. Store source units and convert only in one tested normalization layer.
6. Emit a reviewable derived JSON record per city.
7. Render prose through versioned conditional templates.
8. Fail closed when identity, source coverage, confidence, range, or provenance checks fail.
9. Publish through a human-reviewed PR only; never auto-merge or auto-deploy.

## Useful page modules

### Climate context

Template inputs: Köppen code, label, period, and confidence.

Example form:

> The 1991–2020 Köppen-Geiger classification identifies this area as [label] ([code]). This classification summarizes long-term temperature and precipitation patterns; it is not a measure of daily heat risk.

### Humid-heat seasonality

Show:

- typical monthly wet-bulb values;
- months with the highest historical wet-bulb conditions;
- 95th and 99th percentiles;
- estimated annual hours above reviewed thresholds;
- a compact accessible chart and equivalent table.

Avoid “record,” “safe,” “dangerous,” or return-period claims unless the data and methodology specifically support them.

### Current-versus-normal context

Compare the live reading with the historical distribution for the same calendar month. State the dataset, period, percentile method, and uncertainty. Do not compare live OpenWeather observations directly with gridded reanalysis without labeling the sources.

### Geographic and urban context

Conditionally show elevation, coastal proximity, timezone, urban-centre population, land area, and density. Avoid generic city descriptions and causal claims.

## Investment levels

### Top 50

- all climate, humid-heat, geographic, and urban modules;
- manual source and prose review;
- national-station validation where practical;
- indexing and performance monitoring.

### Top 100

- climate classification;
- wet-bulb seasonality and percentiles;
- urban population and geographic context;
- automated QA plus spot review.

### Top 200

- climate classification;
- peak humid-heat months;
- elevation, timezone, and urban-centre population when available;
- canonical, provenance, and completeness validation.

Selection for the climate-qualified Top 50 and Top 100 should require an explicit minimum humid-heat relevance score. Approaching 35°C wet bulb is not a requirement. Mild-climate cities can remain in Popular or Opportunity groups without being described as high humid-heat locations.

## Pilot

Prototype ten cities spanning tropical, arid, coastal, inland, mountainous, temperate, and data-sparse cases. Include at least one city near a Köppen boundary and one city whose Opportunity rank is driven primarily by search demand rather than climate relevance.

The pilot should compare NASA POWER and ERA5-Land outputs before selecting the production humid-heat source. Review the rendered pages for factual usefulness, repetition, accessibility, attribution, and false precision before expanding to the Top 50.

## Validation gates

A production implementation must verify:

- one stable identity and one canonical path per enriched record;
- pinned sources and checksums;
- license and attribution requirements;
- coordinate and urban-polygon match quality;
- complete units, periods, and provenance;
- physical range and cross-field consistency;
- deterministic rebuilds from the same inputs;
- no unsupported medical or safety claims;
- no public ranking language;
- alphabetical country and region directories;
- accessible charts with equivalent text or tables;
- renderer, canonical, sitemap, and structured-data tests;
- isolated staging review before any production decision.

## Explicit exclusions

Do not use:

- LLM-generated city facts;
- scraped travel or encyclopedia summaries;
- live weather observations as climate normals;
- unversioned APIs as reproducible source records;
- probability of reaching 35°C wet bulb as the selection criterion;
- sitemap priority as an SEO lever;
- duplicated paragraphs that differ only by city name; or
- automatic publication, merging, or deployment.
