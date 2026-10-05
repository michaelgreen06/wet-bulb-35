# Romps wet bulb migration roadmap

## Status

Informational proposal only. This document does not authorize a formula change, provider migration, historical-data regeneration, production deployment, or publication claim.

## Proposed decision

Adopt the pressure-aware thermodynamic wet bulb method described by Romps as WetBulb35's target calculation standard, subject to an independently validated JavaScript implementation and staged parity review.

Keep weather-provider selection separate from formula selection. Providers should supply normalized meteorological inputs; WetBulb35 should calculate and version wet bulb values centrally.

## Why change

The production site currently has more than one wet bulb lineage:

- current conditions use OpenWeather temperature and relative humidity, then calculate the Stull approximation in the browser;
- the forecast experiment on `wb-predict` uses Open-Meteo temperature and relative humidity, then calculates Stull;
- Popular-40 climatology displays NASA POWER's monthly `T2MWET` product directly rather than a WetBulb35-owned formula calculation.

These values are not guaranteed to represent the same wet bulb definition. Formula provenance is therefore part of the data contract, not an implementation detail.

Romps defines wet-bulb and ice-bulb temperatures from pressure, relative humidity, and air temperature. The published implementation reports agreement with empirical thermodynamic wet bulb measurements to within 0.05 K, while other algorithms can differ by several degrees under some conditions.

A preliminary WetBulb35 comparison over 4,800 Popular-40 forecast points found that Romps differed from Open-Meteo's Stull-based wet bulb by a mean absolute 0.16 °C, a 95th-percentile 0.57 °C, and a maximum 1.27 °C. The largest live differences appeared where surface pressure materially differs from sea-level conditions. These results justify migration review; they do not by themselves validate a new production implementation.

## Formula contract

Create one versioned, pure calculation boundary:

```text
WetBulbEngine.calculate({
  temperatureC,
  relativeHumidityPercent,
  surfacePressurePa,
  phasePolicy
}) -> {
  wetBulbC,
  method,
  methodVersion,
  phase
}
```

Requirements:

- pressure is required and must be surface pressure, not silently substituted sea-level pressure;
- units are explicit and normalized before calculation;
- relative humidity, temperature, and pressure ranges are validated without hidden clipping;
- wet-bulb versus ice-bulb behavior follows an explicit reviewed phase policy;
- intermediate and displayed rounding are separate;
- stored or cached values carry method and version metadata;
- missing or invalid pressure fails closed or uses an explicitly labeled fallback; and
- no provider-supplied wet bulb field is mixed with WetBulb35-calculated values under the same label.

## Reference implementation and validation

Port only the wet bulb behavior required by WetBulb35 from the official `davidromps/heatindex` implementation. Preserve its licence and citation.

Before production use:

1. Pin the paper, official package version, source commit, and licence hashes.
2. Generate reference vectors with the official Python `heatindex` package.
3. Test a broad grid of temperature, humidity, and pressure, including low pressure, near-saturation, freezing, and phase-transition boundaries.
4. Require reviewed tolerances against the official implementation before display rounding.
5. Add monotonicity, bounds, unit, NaN, and malformed-input tests.
6. Compare Romps and current production results in shadow mode without changing user-visible values.
7. Record differences by climate and elevation rather than relying only on an aggregate mean.
8. Fail deployment if the implementation or reference vectors drift without an explicit method-version migration.

Do not call the new implementation “Romps” until parity with the official reference has been independently verified.

## Provider-neutral weather contract

Use a small internal interface rather than coupling rendering or calculation code to a vendor SDK:

```text
WeatherProvider.getCurrent(location)
WeatherProvider.getHourlyForecast(location, horizon)

NormalizedObservation {
  timestamp,
  latitude,
  longitude,
  temperatureC,
  relativeHumidityPercent,
  surfacePressurePa,
  provider,
  providerModel,
  retrievedAt
}
```

Implement provider adapters with ordinary server-side `fetch` unless a vendor SDK provides a demonstrated capability that cannot be implemented safely otherwise. AI-generated code does not remove the need for this boundary; the interface and contract tests constrain generated implementations and make provider replacement reviewable.

Every adapter must have shared contract tests for:

- units and timestamps;
- coordinate and model metadata;
- pressure semantics;
- missing-value behavior;
- timeout, retry, and rate-limit behavior;
- attribution and licence metadata;
- cacheability and stale-data rules; and
- sanitized observability.

The formula engine must consume only normalized observations and must never import a provider client.

## Provider evaluation

### Open-Meteo

Strengths for the forecast:

- hourly temperature, relative humidity, and surface pressure;
- multi-coordinate batching;
- forecasts extending beyond five days;
- several underlying forecast models and a best-match mode;
- a straightforward fit for server-side Romps calculation.

Constraints:

- nearby attribution is required wherever its data appear;
- the public endpoint is for non-commercial use under documented limits;
- commercial operation requires the appropriate customer endpoint and licence; and
- model-selection and pressure semantics must be pinned and tested.

### OpenWeather

Strengths:

- already supplies production current conditions;
- established key, operational path, and current-condition contract;
- current, forecast, alert, and historical products under one vendor.

Constraints:

- the free five-day forecast is three-hourly rather than hourly;
- One Call is per-location and has a different cost/rate model;
- provider pressure fields must be verified as suitable surface pressure inputs; and
- the current WetBulb35 adapter discards pressure and calculates Stull in the browser.

### Selection process

Do not switch every workload at once. Run a bounded benchmark across the Popular 40 and representative elevations for at least one forecast cycle:

- availability and missing values;
- temperature, humidity, and surface-pressure differences;
- Romps output differences from identical normalized inputs;
- forecast timeliness and model cadence;
- batching efficiency, cache hit rate, and projected cost;
- attribution and commercial-use requirements; and
- provider outages and stale-data recovery.

Recommended starting point: retain OpenWeather for current conditions, use Open-Meteo for the five-day forecast pilot, calculate Romps centrally for both, and select the long-term provider only after the benchmark and commercial-licence review.

## Migration by data product

### Current conditions

1. Extend the production weather schema to preserve surface pressure.
2. Move wet bulb calculation out of the browser and into the Worker.
3. Calculate current Stull and candidate Romps values in shadow mode.
4. Review differences and provider pressure semantics.
5. Switch the displayed value through a versioned release and retain an immediate rollback.

### Five-day forecast

1. Implement the provider-neutral hourly forecast contract.
2. Pilot Open-Meteo raw temperature, humidity, and surface pressure on the Popular 40.
3. Calculate Romps in the Worker; do not consume Open-Meteo's precomputed wet bulb field.
4. Cache normalized provider observations separately from calculated results.
5. Show forecast issue time, provider attribution, method version, daily maximum, and hourly detail.
6. Ensure crawlers and ordinary HTML rendering never trigger provider requests.
7. Expand beyond the pilot only after cost, licensing, and operational gates pass.

### Popular-40 climatology

The existing monthly values are NASA POWER `T2MWET` climatology. They cannot be converted to Romps by applying the formula to monthly mean temperature and humidity: wet bulb is nonlinear, and Romps also requires pressure.

A valid migration requires hourly historical temperature, relative humidity, and surface pressure from a reviewed source, Romps calculation for every hour, and aggregation of the hourly results into monthly climatology. The regenerated artifact must pin source files, period, time standard, grid resolution, hashes, formula version, and aggregation method. Until that work is complete, label the NASA values by source and do not imply that they use the Romps method.

## Caching and operations

- Cache raw normalized observations independently from formula outputs so a formula migration does not require a provider refetch.
- Include provider, model, retrieval timestamp, formula version, and input hash in cache envelopes.
- Bound provider attempts through the existing WeatherGate design.
- Serve validated stale observations during provider failure without extending their original expiry.
- Keep weather failures warning-only under the production rollback policy.
- Never expose provider credentials to browser code or public artifacts.

## User-facing methodology article

Publish an evidence-based article after the implementation and comparisons are reproducible. Compare:

1. a numerical psychrometric or thermodynamic reference solution;
2. the Stull empirical approximation; and
3. the Romps pressure-aware thermodynamic method.

Explain definitions, required inputs, pressure and phase behavior, valid ranges, computational cost, and measured differences. State why WetBulb35 selected its production method, cite the paper and official implementation, publish reproducible comparison fixtures or data, and identify every site data product that still uses a different lineage.

Do not describe one method as universally “best” without defining the target wet bulb quantity, conditions, evidence, and tolerance.

## Proposed implementation sequence

1. **Reference PR:** reviewed JavaScript Romps engine, official parity vectors, and no production wiring.
2. **Provider-contract PR:** normalized current/forecast interfaces and adapter contract tests; no visible formula change.
3. **Shadow PR:** calculate Romps alongside current Stull values with sanitized aggregate comparison data.
4. **Current-conditions PR:** switch the live value after pressure and parity review, with rollback.
5. **Forecast PR:** five-day Popular-40 pilot with provider attribution, caching, and release monitoring.
6. **Climatology research PR:** select and validate hourly historical inputs.
7. **Climatology migration PR:** regenerate monthly values from hourly Romps calculations.
8. **Methodology-content PR:** publish the reproducible comparison and decision article.

Each production change requires its own explicit approval. Provider migration and formula migration remain independently reversible.

## Decisions required before implementation

- reviewed JavaScript port strategy and acceptable error tolerance;
- wet-bulb versus ice-bulb phase policy;
- Open-Meteo commercial-use plan if monetization begins;
- current-condition pressure semantics for OpenWeather;
- forecast provider/model selection and cache horizon;
- historical hourly climatology source and licence;
- user-facing rounding and method-version display; and
- whether prior values need an archived version label or only a methodology effective date.
