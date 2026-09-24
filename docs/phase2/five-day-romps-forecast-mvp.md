# Five-day Romps forecast MVP

## Scope

The forecast is available on every canonical city page. It does not change current OpenWeather/Stull values, NASA POWER climatology, sitemaps, or canonical routes.

Each daily card shows the maximum hourly wet bulb value and its expected local peak time. Open-Meteo attribution, retrieval time, timezone, Romps method, and a forecast disclaimer appear beside the result.

## Calculation

The Worker requests these hourly Open-Meteo fields for five local calendar days:

- `temperature_2m` in °C;
- `dew_point_2m` in °C; and
- `surface_pressure` in hPa.

The typed adapter converts pressure to Pa and converts dew point to vapor pressure using the pinned Romps liquid-saturation relation. This avoids relying on an undocumented cold-weather liquid-versus-ice convention in a provider's relative-humidity field. Every complete, aligned hourly row is calculated independently with the thermodynamic liquid wet-bulb method from Romps. Daily maxima are selected only after all hourly wet bulb values have been calculated.

The implementation is pinned as `romps-thermodynamic-liquid` version `2026-heatindex-0.0.2` and ports the required subset of `davidromps/heatindex` commit `ebe4a831c1c01de071c8debf27863f1ad92b5782`. Its MIT notice is retained in `docs/licenses/romps-heatindex-MIT.txt`.

The 500-point reference fixture is reproducible from a hash-locked environment:

```bash
uv venv /tmp/wetbulb-romps-reference
VIRTUAL_ENV=/tmp/wetbulb-romps-reference uv pip install -r requirements/romps-reference.txt
/tmp/wetbulb-romps-reference/bin/python scripts/generate-romps-reference-fixture.py
```

`requirements/romps-reference.txt` pins the official `heatindex==0.0.2` source archive by SHA-256 together with its transitive dependency. The fixture records that archive hash, upstream source commit, deterministic seed, and point count. Regeneration from a fresh environment must be byte-for-byte identical.

The initial parity suite contains official-reference vectors for warm, saturated, dry, high-elevation, low-pressure, freezing, triple-point, and bistable-regime inputs. An additional deterministic 500-point comparison against the pinned official Python extension produced a maximum absolute difference of approximately `1.14e-13 K` during implementation verification.

## API usage

One forecast request covers one location, three variables, and five days. Open-Meteo's current query-weight calculation charges this as one API call:

```text
max(variables / 10, variables / 10 × days / 14) × locations
max(3 / 10, 3 / 10 × 5 / 14) × 1 = 0.3
minimum charge per location = 1.0 call
```

The Worker explicitly uses `models=best_match`, `timezone=auto`, and `forecast_days=5`. It never requests Open-Meteo's precomputed wet bulb field.

## Request and cache boundaries

`GET /api/forecast?path=<canonical-city-path>` accepts only an exact path resolved from the canonical route manifest and private country shard. The Worker never accepts coordinates from the browser.

The existing WeatherGate Durable Object handles a distinct `/forecast` operation with:

- an independent Open-Meteo attempt counter;
- a 2,000-attempt site-wide daily safety limit, matching current-condition protection;
- one provider attempt and no retries per refresh;
- a five-second timeout;
- three hours of freshness; and
- twelve hours of stale availability.

Normalized Open-Meteo observations and Romps results are stored under separate versioned keys. Formula revisions can therefore reuse still-fresh provider data. The public Cache API stores only validated result envelopes. Browser responses remain `private, no-store`.

Known crawlers receive `204` before route resolution, cache lookup, or provider access. Server-side HTML rendering never fetches a forecast.

## Failure behavior

Malformed provider arrays, units, metadata, physical inputs, or formula outputs fail closed. If an unexpired stale forecast exists, provider or budget failure returns it without extending its timestamps. Forecast failures do not affect page rendering or current weather and remain warning-only for release decisions.

## Rollout

1. Deploy to the route-free staging Worker.
2. Verify representative hot/humid, dry, high-elevation, freezing, and timezone cases.
3. Confirm attribution, mobile layout, bot isolation, cache reuse, and provider-attempt accounting.
4. Release all-city availability only after explicit approval.
5. Monitor usage, cache misses, budget exhaustion, and failures before changing the safety limit or moving to a paid Open-Meteo customer endpoint.

The free Open-Meteo endpoint is restricted to non-commercial use under its current terms. Advertising, subscriptions, or other commercial operation requires the appropriate customer endpoint and licence before launch. The forecast is explicitly configured as `public-noncommercial` on staging and production. Before WetBulb35 introduces advertising, subscriptions, or another commercial use, production must move to `customer-commercial` with an `OPEN_METEO_API_KEY` secret configured through Wrangler's secret store and never committed.
