# Global inhabited wet bulb hotspot forecast MVP

## Status

Implemented behind two independent gates:

- The once-daily GitHub Actions job does not run on schedule unless `GLOBAL_HOTSPOTS_ENABLED=true` is configured as a repository variable.
- The Worker page and API return `404` unless `HOTSPOT_FEATURE_MODE=enabled` and an approved `HOTSPOT_SNAPSHOTS` R2 binding are configured.

The review branch adds a private R2 binding to the production-domain Wrangler config but leaves both serving gates unset. The bucket exists privately; no snapshot is published, Worker deployed, or PR merged by this change.

## Product

Once daily, the pipeline targets the 00Z ECMWF IFS cycle, identifies high forecast wet bulb regions on the public ECMWF IFS 0.25° grid over the first 24 complete UTC hours after retrieval, intersects buffered cells with the complete canonical WetBulb35 location manifest, refines only those locations with the same 24 hourly values from one fixed ECMWF model through Open-Meteo, and prepares one validated snapshot per product. Actual scheduled publication remains disabled pending separate approval.

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
5. After explicit activation, `.github/workflows/global-inhabited-hotspots.yml` uploads:
   - a content-addressed immutable object at `inhabited-hotspots/v1/snapshots/sha256-<digest>.json`;
   - only after read-back verification, the current alias at `inhabited-hotspots/v1/latest.json`.
   - The guard described under *Run readiness and publication* decides each product independently.

## Run readiness and publication

- One scheduled job starts at 06:35Z for the day's 00Z initialization (`35 6 * * *`), before ECMWF's documented 7–9 hour dissemination delay ends. The daily job will not fall back to yesterday's 18Z run; a delayed job may use a newer complete run.
- `scripts/await-ifs-run-readiness.py` polls for at most 285 minutes, every five minutes plus up to one minute of jitter. It honors `Retry-After` and backs off exponentially on 429/5xx/transport errors.
- Each poll reads only the Azure mirror's `.index` files (the downloader's mirror; about 40 KB each), never GRIB data. It parses their JSON rows: every step covering the 24 future hours from the next full UTC hour must list `2t`, `2d`, and `sp` for that exact run and step with a nonempty byte range, and step 0 must list `lsm`. An index that exists but lacks a required row is not ready. The last bracketing step is checked first.
- If retrieval of a ready cycle still fails, the downloader (`--retry-until`) retries every five minutes plus jitter until the same deadline. It then warns, generates nothing, and keeps the prior immutable snapshots.
- A cycle is usable only after Open-Meteo's static `ecmwf_ifs025` metadata also reports that initialization (or a newer one) available for at least ten minutes. That confirms Single Runs refinement can pin the identical run.
- Newest-first: an older cycle is never selected over a newer complete one. Cycles at or older than the currently published snapshot are skipped.
- The first poll that saw the run usable is recorded as `firstSeenReadyAt`, separately from `initialization` and the grid `retrievedAt`. Readiness is never inferred from the scheduler start time.
- Late runs follow the existing window rule. A run first retrieved hours after it became available is used only if it covers 24 consecutive future hours starting at the next full UTC hour after the actual retrieval. Elapsed hours are never ranked, and a run that cannot cover a full future window is skipped.
- `scripts/hotspot-publish-guard.mjs` compares each validated candidate with that product's current `latest.json`:
  - a newer initialization publishes;
  - an older one is refused;
  - the same run publishes a new future window only after the published window has ended;
  - an unreadable R2 response (anything other than a missing object) stops the job rather than letting an older run through.
- The workflow's single concurrency group serializes read-compare-write. It verifies a backup of each existing alias and **both** content-addressed new objects before either `latest` alias is changed. A pre-commit pair check requires matching initialization and native grid source bounds bracketing the inhabited hourly window (the two bounds are not identical). If a write/read-back fails, a best-effort trap restores both old aliases (or deletes a newly-created alias), verifies restored bytes, and fails the job. The final step separately re-reads both remote aliases and checks pair identity and expiry, so a crash between writes is detectable. R2 does not provide an atomic transaction across these two keys: readers can briefly see a split pair, and SIGKILL or failed rollback can leave one; a failed remote pair check blocks release and requires manual reconciliation from the verified immutable objects with the feature gates off. Do not describe this as atomic paired publication.
- If no usable cycle arrives within the bounded window, the job warns and keeps the prior immutable snapshot. When a published product has no current snapshot (missing or past `validTo`), a final step fails the job so the failure alerts. It keeps failing on each cycle until a valid snapshot is published.

A failed download, incomplete GRIB, budget overrun, provider failure, malformed response, validation error, or R2 verification failure stops the run. It cannot replace the prior current snapshot before a new snapshot has passed generation and immutable-object verification.

## Serving

`workers/hotspots-edge.ts` reads only the fixed current R2 object, enforces a 256 KB size limit, validates its strict schema, and caches the validated response briefly at the edge.

### Freshness

A snapshot is usable only within its original `validFrom`–`validTo` bounds; timestamps are never extended.

- Before `validFrom`, the page shows the fixed window and its start time.
- After `validFrom`, the page labels the ranking as the original fixed window, not a rolling “next 24 hours”. Peaks whose time has passed are marked “(passed)”.
- From `validTo`, both the HTML page and the API stop presenting the ranking:
  - The page keeps its URL and returns `503` with `Retry-After: 900`. It shows an unavailable state with only the ended window's bounds.
  - The API returns a `503` JSON body without hotspots.
  - The Worker logs `hotspot_snapshot_expired` for alerting.
- API `cache-control` never extends beyond `validTo`. HTML keeps the site's `max-age=0, must-revalidate` policy.
- The unfiltered global-grid product follows the same rules independently.
- An enabled product with no readable snapshot also returns the accessible `503` unavailable page instead of plain text.

### Navigation

- While `HOTSPOT_FEATURE_MODE=enabled`, every Worker-rendered page includes a server-rendered `Top 50 inhabited hotspots` link. It sits in a `nav` landmark labeled "Forecast hotspots" and has `aria-current` on the page itself. Covered pages: home, directory, country, state, city, and both hotspot pages.
- With the gate off, the link is omitted and the HTML is byte-identical to before. The route then returns 404, so the link is never shown pointing to a 404.
- The HTML cache key includes the deployment version, so gate changes, which require a deploy, cannot leave stale links.
- The inhabited page links to the unfiltered grid page only while `GLOBAL_GRID_HOTSPOT_FEATURE_MODE=enabled`. Its label says the grid page includes ocean and uninhabited cells and is not a ranking of inhabited locations. The grid page links back only while the inhabited gate is on.

### Top-50 five-day reuse

- After ranking, the generator makes one extra pinned Single Runs request for the published locations only: at most 50, `forecast_hours=145`, `timezone=auto`. It does not fetch 120 hours at every scan candidate.
- Each published hotspot stores daily maxima for complete local dates covered by the same initialization (`hotspots[].fiveDay`). The schema rejects any other initialization.
- This step fails closed after bounded retries: if any of the 50 published locations lacks five complete local dates from the pinned initialization, the job retains the prior snapshot and alerts. It does not publish an unaligned ranking.
- While the snapshot is current, `/api/forecast` for a Top-50 path reads the snapshot (never a provider):
  - It serves the pinned run alone, with no provider call, when that run covers all five current local dates.
  - Otherwise, each remaining day comes from the latest explicit IFS run, and every day is labeled with its run and initialization.
  - It fails closed rather than truncating, and never joins runs reported with different UTC offsets.

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
- `HOTSPOT_RUN_LOCATION_LIMIT` — fixed to 1,500 for this scheduled public job, inclusive of excluded controls; the pipeline fails rather than truncating. The shared Open-Meteo location-attempt envelope is 1,500 × 3 refinement attempts + 50 × 3 pinned five-day attempts + 2,000 city-forecast attempts = **6,650/day** in the worst case of one job. Current weather uses **OpenWeather**, not Open-Meteo, and is not added here. `scripts/hotspot-provider-budget.mjs` fails before provider work above 9,000 location attempts. Open-Meteo's actual call-equivalence can depend on locations, variables, time range, and models, so this proxy is **not** a verified provider-side quota ledger: manual reruns, other projects using the service, weighted calls, and a delayed job crossing UTC days can breach the public API's fewer-than-10,000/day, 5,000/hour, 600/minute, and 300,000/month limits. At the envelope every day, the location-attempt proxy is 199,500 per 30 days before other Open-Meteo traffic; neither hourly nor monthly usage is enforced by this script. Do not activate without confirming the representative request's actual equivalence and accounting for other traffic; do not enable overlapping/manual provider runs without a shared daily ledger or separately budgeted provider plan. `HOTSPOT_DAILY_LOCATION_LIMIT` remains a legacy fallback name for local callers.
- `HOTSPOT_EXCLUDED_SAMPLE_SIZE` — deterministic excluded-location control count; default 100.
- `HOTSPOT_INTER_BATCH_DELAY_MS` — fixed at 20,000 ms for the scheduled job, between both successful batches **and retries**. With batches of 100, this caps the generator's sustained demand at about 300 location-equivalents per minute. This does not centrally meter concurrent city-page traffic, so the provider's 600/minute shared limit still requires monitoring.
- `HOTSPOT_R2_BUCKET` — approved existing R2 bucket name.
- `CLOUDFLARE_ACCOUNT_ID` and `WETBULB35_CLOUDFLARE_API_TOKEN` — required only for publishing.

Serving still requires separate approval to deploy the reviewed binding **and** to set feature gates. The PR only adds this binding to `wrangler.weather-production-domain.toml`:

```toml
[[r2_buckets]]
binding = "HOTSPOT_SNAPSHOTS"
bucket_name = "wetbulb35-hotspot-snapshots-prod"

[vars]
# HOTSPOT_FEATURE_MODE and GLOBAL_GRID_HOTSPOT_FEATURE_MODE remain unset
```

**Hosted credential preflight (not yet run):** Once this workflow exists on the default branch after a separately authorized merge, add/invoke a separate read-only, non-publishing `workflow_dispatch` job using the stored token. Read back a harmless test object **only after an independently approved write has seeded it** (the bucket is currently empty); compare exact bytes. A read-only test cannot establish token write access or prove the token is narrowly scoped; verify those separately before launch. Do not use the current `publish=false` dispatch for this: it still performs a full ECMWF download and Open-Meteo refinement. An account-scoped Workers token with R2 access supports the Wrangler REST commands here; a bucket-scoped R2 token would require an S3-compatible client and code changes. GitHub secret values are opaque, so local token success does not establish hosted-token access. Any write/delete preflight or snapshot publication needs separate explicit authorization. Before activation, verify the remote alias pair independently and establish an alert for failed/stale/split pointers. Leave both feature gates off until a current, paired, complete 50/50 snapshot is verified.

Do not add Cloudflare or Open-Meteo credentials to Git.

## Local verification

```bash
npm ci --ignore-scripts
npm run test:global-hotspots
npm run test:forecast

python3 -m venv .venv-hotspots
.venv-hotspots/bin/python -m pip install --require-hashes -r requirements/global-hotspots.txt
.venv-hotspots/bin/python -m unittest \
  tests/test_await_ifs_run_readiness.py \
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
- Exact final ranking and Top-50 five-day reuse use hourly Open-Meteo `ecmwf_ifs025` Single Runs data pinned to the discovery initialization.
- Open-Meteo public access is noncommercial. Advertising, subscriptions, sponsorships, or other commercial use requires an appropriate customer endpoint and license before monetization is activated.

## Direct-model shadow comparison

`scripts/download-gfs-hotspot-grid.py` retrieves only NOAA GFS 0.25° surface pressure, 2 m temperature, and 2 m dew point messages for the exact same validity window. The direct GFS path calculates Romps locally, makes zero Open-Meteo calls, and never deploys or publishes a page.

`scripts/compare-hotspot-shadow-snapshots.py` records top-20/top-50 native-grid overlap, candidate-path overlap, model initializations, and maxima. A seven-run local shadow schedule retains the complete artifacts under `/home/laclaw/.local/share/wetbulb35-model-shadow/`; model differences are observations, not release gates. Production remains on IFS unless the completed comparison and later observation scoring justify a change.

### Independent station-observation scoring

Every daily shadow run also writes `stations.json` before the source GRIBs can be replaced. `scripts/capture-hotspot-shadow-stations.py` samples both models at the same NOAA GHCNh station panel for all 24 valid hours using each model's nearest native grid cell. The panel combines 22 fixed humid-climate airport stations with up to 20 deterministic stations within 100 km of the union of both models' top grid cells. IFS fields are interpolated to the product hours before sampling; GFS fields remain native hourly values. The capture is private, local-only, and never affects staging or production output.

After the window ends and a 36-hour observation-availability delay has elapsed, `scripts/score-hotspot-shadow-observations.py` retrieves the selected stations' yearly NOAA GHCNh PSV files. It performs deterministic one-to-one matching to the nearest report within 30 minutes without interpolating or reusing observations, preserves NOAA quality and provenance fields, and calculates observed Romps wet bulb only when quality-accepted simultaneous temperature, dew point, and station-level pressure are present. Scores include component and wet bulb bias, MAE, RMSE, threshold misses/false alarms, fixed-versus-dynamic panels, lead-hour bins, and paired IFS-versus-GFS error counts.

Open-Meteo reanalysis and historical forecasts are not treated as independent observations. NOAA files are cached with their ETag, Last-Modified value, retrieval time, and SHA-256 digest because GHCNh is updated daily and can be revised. Scores remain provisional and are refreshed daily until at least 120 hours after the forecast window; a final score also requires at least one quality-accepted wet bulb pair and no retryable source errors. A station-year that NOAA does not publish is retained as an explicit coverage gap rather than blocking every other station. Missing or delayed observations therefore remain retryable and never invalidate or replace a forecast capture.
