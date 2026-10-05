# Global inhabited wet bulb hotspot forecast MVP

## Status

Implemented behind two independent gates:

- The daily GitHub Actions job does not run on schedule unless `GLOBAL_HOTSPOTS_ENABLED=true` is configured as a repository variable.
- The Worker page and API return `404` unless `HOTSPOT_FEATURE_MODE=enabled` and an approved `HOTSPOT_SNAPSHOTS` R2 binding are configured.

The MVP does not create an R2 bucket, alter production configuration, deploy a Worker, or merge its branch.

## Product

Once daily, the pipeline identifies high forecast wet bulb regions on the public ECMWF IFS 0.25° grid over the first 24 complete UTC hours after retrieval, intersects buffered cells with the complete canonical WetBulb35 location manifest, refines only those locations with the same 24 hourly values from one fixed ECMWF model through Open-Meteo, and publishes one validated snapshot.

Public wording remains deliberately narrow:

> Highest forecast wet bulb temperatures identified by today’s global inhabited-hotspot scan.

The page does not claim a measured value, official record, city-center precision, or the guaranteed highest location on Earth.

## Offline generation flow

1. `scripts/build-hotspot-city-manifest.mjs` builds the canonical coordinate manifest from `scripts/resolved_cities.json` using the production route-identity code.
2. `scripts/download-ecmwf-hotspot-grid.py` downloads public ECMWF IFS `0p25` forecast fields from the Azure Open Data mirror, avoiding the primary distribution host's tighter rate limiting:
   - `2t`
   - `2d`
   - `sp`
   - The three indexed fields for all required forecast steps are fetched with one multi-range client retrieval and written to one local GRIB file; the land/sea mask is a second small retrieval.
   - dynamically selected three-hourly source steps that bracket a publication-relative window beginning at the next full UTC hour after retrieval
   - metadata recording retrieval time, the inclusive first/last evaluated hours, the exclusive validity end, source steps, and the 24 evaluated hourly lead times
   - one matching `lsm` land-sea mask
3. `scripts/generate-ecmwf-hotspot-candidates.py`:
   - validates the complete GRIB message set and common initialization/grid;
   - linearly interpolates simultaneous temperature, dew point, and surface pressure fields to the exact 24 hourly valid times before calculating Romps liquid wet bulb;
   - never interpolates relative humidity, wet bulb, or separately selected extrema;
   - retains land cells above the absolute threshold or within the configured margin of the global land maximum;
   - expands selected cells by a configurable number of neighboring rings with longitude wrapping;
   - maps every canonical location to its nearest model cell locally;
   - emits all qualifying locations without a population cutoff or silent candidate cap.
4. `scripts/generate-inhabited-hotspot-snapshot.ts`:
   - adds a deterministic daily sample of excluded locations as recall controls;
   - fails if discovered candidates plus controls exceed the explicit daily location budget;
   - requests the exact same publication-relative 24 aligned UTC hourly values from fixed model `ecmwf_ifs025`;
   - calculates each hourly Romps value before selecting each location maximum;
   - deduplicates only the presentation results by the model cell returned by Open-Meteo;
   - validates the complete snapshot and atomically writes one local JSON file.
5. `.github/workflows/global-inhabited-hotspots.yml` uploads:
   - a content-addressed immutable object at `inhabited-hotspots/v1/snapshots/sha256-<digest>.json`;
   - only after read-back verification, the current alias at `inhabited-hotspots/v1/latest.json`.
   - The daily job begins at 15:15 UTC, 9 hours 15 minutes after the 06Z initialization, because ECMWF documents a 7–9 hour dissemination delay. The forecast window is not fixed to initialization; it begins at the next full UTC hour after successful retrieval. A missing mirror object is treated as incomplete dissemination and retried every five minutes for 30 minutes; it is not treated as proof that the run does not exist.

A failed download, incomplete GRIB, budget overrun, provider failure, malformed response, validation error, or R2 verification failure stops the run. It cannot replace the prior current snapshot before a new snapshot has passed generation and immutable-object verification.

## Serving

`workers/hotspots-edge.ts` reads only the fixed current R2 object, enforces a 512 KiB size limit, validates its strict schema, and caches the validated response briefly at the edge.

Read-only routes:

- HTML: `/wetbulb-temperature/forecast/global-hotspots/`
- JSON: `/api/inhabited-hotspots`

The HTML contains the ranking values and city links in the server response. Visitors and crawlers never initiate ECMWF or Open-Meteo requests.

## Validation controls

Each daily run refines a deterministic sample of locations excluded by discovery. If a sampled control appears in the published top 20, the snapshot records `validation.recallWarning=true` and the page displays a visible warning. This is a monitoring signal, not proof of recall.

Before strengthening the product claim, run periodic broad or exhaustive reference scans and calibrate:

- discovery margin;
- absolute wet bulb threshold;
- neighbor-ring expansion;
- excluded-control sample size.

The target remains recovery of the true reference top 20 and reference maximum across representative seasons, coasts, islands, and terrain boundaries.

## Configuration gates

Generation variables/secrets:

- `GLOBAL_HOTSPOTS_ENABLED=true` — allows scheduled runs; absent/false keeps the schedule inert.
- `OPEN_METEO_API_MODE=public-noncommercial` or `customer-commercial` — explicit licensing mode.
- `OPEN_METEO_BASE_URL` — optional approved endpoint override.
- `OPEN_METEO_API_KEY` — required only for customer-commercial mode.
- `HOTSPOT_DAILY_LOCATION_LIMIT` — hard ceiling; the pipeline fails rather than truncating.
- `HOTSPOT_EXCLUDED_SAMPLE_SIZE` — deterministic excluded-location control count; default 100.
- `HOTSPOT_INTER_BATCH_DELAY_MS` — provider pacing between multi-location batches; scheduled default 20,000 ms. With batches of 100, this caps normal demand at 300 location-equivalents per minute before retry/backoff handling.
- `HOTSPOT_R2_BUCKET` — approved existing R2 bucket name.
- `CLOUDFLARE_ACCOUNT_ID` and `WETBULB35_CLOUDFLARE_API_TOKEN` — required only for publishing.

Serving requires an approved Worker configuration change after storage authorization:

```toml
[[r2_buckets]]
binding = "HOTSPOT_SNAPSHOTS"
bucket_name = "<approved-existing-bucket>"

[vars]
HOTSPOT_FEATURE_MODE = "enabled"
```

Do not add Cloudflare or Open-Meteo credentials to Git.

## Local verification

```bash
npm ci --ignore-scripts
npm run test:global-hotspots
npm run test:forecast

python3 -m venv .venv-hotspots
.venv-hotspots/bin/python -m pip install --require-hashes -r requirements/global-hotspots.txt
.venv-hotspots/bin/python -m unittest \
  tests/test_download_ecmwf_hotspot_grid.py \
  tests/test_download_gfs_hotspot_grid.py \
  tests/test_generate_ecmwf_hotspot_candidates.py \
  tests/test_generate_global_grid_hotspot_snapshot.py \
  tests/test_compare_hotspot_shadow_snapshots.py \
  tests/test_capture_hotspot_shadow_stations.py \
  tests/test_score_hotspot_shadow_observations.py
```

Build the complete city manifest:

```bash
npm run build:hotspot-city-manifest
```

The full live generation is intentionally an offline/operator workflow. Generated manifests, GRIB files, candidates, and snapshots live under `.hotspots/` and are ignored by Git.

## Data and licensing

- ECMWF Open Data discovery uses the public 0.25° three-hourly source grid, interpolated to an explicitly labeled hourly evaluation cadence, and requires ECMWF attribution under CC BY 4.0.
- Exact final ranking uses hourly Open-Meteo `ecmwf_ifs025` data.
- Open-Meteo public access is noncommercial. Advertising, subscriptions, sponsorships, or other commercial use requires an appropriate customer endpoint and license before monetization is activated.

## Direct-model shadow comparison

`scripts/download-gfs-hotspot-grid.py` retrieves only NOAA GFS 0.25° surface pressure, 2 m temperature, and 2 m dew point messages for the exact same validity window. The direct GFS path calculates Romps locally, makes zero Open-Meteo calls, and never deploys or publishes a page.

`scripts/compare-hotspot-shadow-snapshots.py` records top-20/top-50 native-grid overlap, candidate-path overlap, model initializations, and maxima. A seven-run local shadow schedule retains the complete artifacts under `/home/laclaw/.local/share/wetbulb35-model-shadow/`; model differences are observations, not release gates. Production remains on IFS unless the completed comparison and later observation scoring justify a change.

### Independent station-observation scoring

Every daily shadow run also writes `stations.json` before the source GRIBs can be replaced. `scripts/capture-hotspot-shadow-stations.py` samples both models at the same NOAA GHCNh station panel for all 24 valid hours using each model's nearest native grid cell. The panel combines 22 fixed humid-climate airport stations with up to 20 deterministic stations within 100 km of the union of both models' top grid cells. IFS fields are interpolated to the product hours before sampling; GFS fields remain native hourly values. The capture is private, local-only, and never affects staging or production output.

After the window ends and a 36-hour observation-availability delay has elapsed, `scripts/score-hotspot-shadow-observations.py` retrieves the selected stations' yearly NOAA GHCNh PSV files. It performs deterministic one-to-one matching to the nearest report within 30 minutes without interpolating or reusing observations, preserves NOAA quality and provenance fields, and calculates observed Romps wet bulb only when quality-accepted simultaneous temperature, dew point, and station-level pressure are present. Scores include component and wet bulb bias, MAE, RMSE, threshold misses/false alarms, fixed-versus-dynamic panels, lead-hour bins, and paired IFS-versus-GFS error counts.

Open-Meteo reanalysis and historical forecasts are not treated as independent observations. NOAA files are cached with their ETag, Last-Modified value, retrieval time, and SHA-256 digest because GHCNh is updated daily and can be revised. Scores remain provisional and are refreshed daily until at least 120 hours after the forecast window; a final score also requires at least one quality-accepted wet bulb pair and no retryable source errors. A station-year that NOAA does not publish is retained as an explicit coverage gap rather than blocking every other station. Missing or delayed observations therefore remain retryable and never invalidate or replace a forecast capture.
