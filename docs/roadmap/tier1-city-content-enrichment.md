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

### Historical highs and lows for today’s calendar date

Add a dynamic module for the visitor’s current local calendar date, but distinguish two different products:

1. **Globally consistent modeled wet-bulb extremes:** the highest and lowest hourly wet-bulb estimates for that month-and-day during a fixed ERA5-Land reference period.
2. **Official observed records where supportable:** station-observed air-temperature records, or derived wet-bulb records when simultaneous quality-controlled temperature and dew point are sufficiently complete.

The recommended global implementation uses [ERA5-Land hourly time series](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land-timeseries), which provides 2 m temperature and dew point from 1950 to the present at approximately 9 km resolution. For each city:

1. Select the reviewed city point or urban-polygon spatial rule.
2. Retrieve hourly temperature and dew point for a fixed baseline, initially 1991–2020.
3. Convert UTC timestamps into the city’s GeoNames/IANA timezone before assigning calendar dates.
4. Derive relative humidity and wet-bulb temperature with the same versioned formulas used elsewhere in the pipeline.
5. Calculate each local day’s hourly wet-bulb minimum and maximum.
6. Group those daily values by month and day across the baseline years.
7. Store the highest and lowest modeled values, timestamp/year, number of contributing years, data completeness, source version, grid coordinates, and formula version for each of 366 possible calendar dates.
8. Treat February 29 separately; never merge it with February 28 or March 1.

A page shown on September 15 could then state:

> For September 15, the highest modeled wet-bulb temperature at this location during 1991–2020 was X°C, and the lowest was Y°C.

Use **“highest/lowest modeled wet-bulb estimate”**, not “record,” for reanalysis data. A grid-cell extreme is not an official station record and may not capture local urban, coastal, or terrain effects. Also show the median daily high and low or percentile range so a single extreme does not dominate the context.

[NASA POWER’s hourly API](https://power.larc.nasa.gov/docs/services/api/temporal/hourly) exposes the `T2MWET` wet-bulb parameter and is suitable for a fast ten-city prototype. Its coarser meteorological grid makes it less suitable for final record-like claims.

For observation-based validation, [NOAA’s Global Historical Climatology Network hourly dataset](https://www.ncei.noaa.gov/products/global-historical-climatology-network-hourly) is the preferred authoritative option. It includes fixed-station temperature, dew point, relative humidity, and in some inputs wet-bulb observations, while preserving source quality flags. A deterministic station workflow must:

- choose stations by distance, elevation difference, reporting cadence, period coverage, and quality flags—not distance alone;
- require simultaneous temperature and dew-point observations when deriving wet bulb;
- publish the station name, identifier, distance, period, observation count, and missing-data rate;
- avoid combining stations into a purported record unless the homogenization method is documented; and
- omit the observed-record module when coverage fails the threshold.

Use GHCNh for manually reviewed Top-50 validation, not as the initial global page source: station availability, relocations, airport bias, missing humidity, and uneven historical coverage prevent uniform worldwide automation.

Extend each derived city record with compact calendar-day data:

```json
{
  "calendarDay": {
    "source": "ERA5-Land",
    "referencePeriod": "1991-2020",
    "timezone": "Asia/Kolkata",
    "formulaVersion": "",
    "days": {
      "09-15": {
        "modeledHighWetBulbC": 0.0,
        "modeledHighTimestamp": "",
        "modeledLowWetBulbC": 0.0,
        "modeledLowTimestamp": "",
        "medianDailyHighWetBulbC": 0.0,
        "medianDailyLowWetBulbC": 0.0,
        "contributingYears": 0,
        "hourlyCompleteness": 0.0
      }
    }
  }
}
```

Validate local-date conversion, physical ranges, minimum contributing years, completeness, duplicate hours around daylight-saving transitions, source updates, and reproducibility. Render nothing when a validation gate fails.

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
