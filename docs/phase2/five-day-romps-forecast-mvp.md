# Five-day Romps forecast MVP

## Scope

The forecast is available on every canonical city page. It does not change current OpenWeather/Stull values, NASA POWER climatology, sitemaps, or canonical routes.

Each daily card shows the maximum hourly wet bulb value and its expected local peak time. Open-Meteo attribution, retrieval time, timezone, Romps method, and a forecast disclaimer appear beside the result.

## Calculation

The Worker requests these hourly Open-Meteo fields and displays five local calendar dates: today's remaining forecast hours plus four complete future dates:

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

The Worker explicitly uses `models=ecmwf_ifs025` (ECMWF IFS 0.25°, the same named model as the Top-50 hotspot products), `timezone=auto`, and `forecast_days=5`. It never requests Open-Meteo's precomputed wet bulb field.

### Model run attribution

When the inhabited hotspot feature is enabled, the current snapshot supplies one exact IFS initialization for **every canonical city**. On a human forecast view and cache miss, the Worker requests only that city from Open-Meteo Single Runs with `models=ecmwf_ifs025`, `run=<snapshot initialization>`, `forecast_hours=193`, and `timezone=auto`. It requires simultaneous hourly temperature, dew point and pressure for today's remaining model hours and four full future local dates; missing coverage returns an aligned-forecast-unavailable state rather than mixing in a newer run. The snapshot publication itself makes no five-day city forecast calls. Outside that gated feature, the existing explicit-model `forecast_days=5` path remains separate.

For the ungated latest-model path, metadata run attribution may remain unconfirmed. The gated pinned path needs no metadata inference because `run=` is explicit, and its response is labeled with that initialization. Never present a different run as aligned with the Top-50 ranking.

## Request and cache boundaries

`GET /api/forecast?path=<canonical-city-path>` accepts only an exact path resolved from the canonical route manifest and private country shard. The Worker never accepts coordinates from the browser.

The existing WeatherGate Durable Object handles a distinct `/forecast` operation with:

- an independent Open-Meteo attempt counter;
- a 2,000-attempt site-wide daily safety limit, matching current-condition protection;
- one provider attempt and no retries per refresh;
- a five-second timeout;
- three hours of freshness; and
- twelve hours of stale availability.

Normalized Open-Meteo observations and Romps results use versioned keys. Forecast version 5 invalidates earlier future-only cached results. The gated aligned path caches by canonical city and exact initialization, for three hours fresh and at most twelve hours stale, without substituting an older or newer run. A current-day peak is invalidated as soon as its hourly timestamp passes, even inside the TTL. The public Cache API stores validated envelopes; browser responses remain `private, no-store`. Both paths return exactly five dates beginning today: only still-upcoming hourly peaks today, followed by four complete local days. If no forecast hour remains today, its card has no numeric high; incomplete future dates fail closed.

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
