# All-location climate context: Köppen-Geiger and NASA POWER monthly wet bulb

**PR implementation only. Not merged, not deployed.** This extends the Popular-40 pilot's climate context — Köppen-Geiger class, modeled 1991–2020 monthly mean wet bulb, and peak month — to every canonical route the sources support. URLs, canonicals, sitemaps, directories, current weather, forecast and the 40 Popular pages' HTML are unchanged.

## Method

Climate is a property of the route's own mapped coordinates (the same point used for current weather), so no name or GeoNames identity join is needed. The artifact is keyed by canonical path and pinned to the exact inventory by a SHA-256 over `path, latitude, longitude` that the Python generator and JS validator both compute. The route index comes from `scripts/probe-location-route-identity.mjs` (130,686 rows; identical to the September 29 private index).

### Köppen-Geiger — offline, every route

- Source: Beck et al. v3 1991–2020 0.00833° raster, the same pinned zip/raster/legend hashes as the pilot (CC BY 4.0).
- Rule (unchanged from pilot): show the class only when the centre cell equals the 3×3 modal class and modal share ≥ 0.67. NoData (water) neighbours are ignored.
- **One class per location.** The v3 bundle has no confidence or probability layer, so no source supports showing two zones for one place. Mixed 3×3 neighbourhoods are excluded, not shown as overlap.

### NASA POWER — one request per native MERRA-2 cell

- Same request contract as the pilot: point climatology API, `T2MWET`, community `RE`, 1991–2020, LST, JSON.
- Bounded probes (Oct 3, 2026, 13 requests) established:
  - Point requests return the **nearest 0.5° × 0.625° cell's** values: three points in one cell were identical; ±0.001° either side of a lat and a lon edge switched cells.
  - An exact edge tie rounded north. The other directions are unverified, so the **362 routes exactly on a cell edge are excluded** rather than guessed.
  - The API is now v2.10.0; the pilot used v2.9.7. Kolkata's v2.10.0 response is identical to the pilot's.
  - The regional endpoint ignores `start/end` and returns a fixed 2001–2020 climatology. It was **rejected** as a period substitute.
- So 17,063 distinct cells cover all 130,324 non-tie routes, instead of one request per route.
- 200 extra **route-coordinate validation** requests (all 40 Popular paths plus 160 seeded random routes) must equal their assigned cell exactly, or generation fails.
- Values are rounded half-up to 0.1 °C. Peak months come from unrounded values; ties are kept.

### Gates (generator fails closed)

Source hash drift; inventory drift or coordinates with more than five decimals; NASA URL/contract/header/version change; mixed API versions; response checksum mismatch; missing cell; route-coordinate validation mismatch; fewer than 200 validation samples; any Popular-40 Köppen, monthly value or peak month differing from the committed pilot artifact. Fill or out-of-range NASA values are excluded per route, never imputed.

## Coverage — 130,686 canonical routes

| | Routes | Share |
|---|---:|---:|
| Köppen-Geiger shown | 124,642 | 95.4% |
| — excluded: 3×3 modal share < 0.67 | 3,609 | 2.8% |
| — excluded: centre ≠ 3×3 modal class | 1,309 | 1.0% |
| — excluded: centre cell NoData (coast/water) | 1,126 | 0.9% |
| NASA POWER monthly wet bulb shown | 130,324 | 99.7% |
| — excluded: exact MERRA-2 cell-edge tie | 362 | 0.3% |
| — excluded: fill or invalid NASA value | 0 | 0% |
| **Both shown** | **124,305** | **95.1%** |
| **At least one shown** | **130,661** | **99.98%** |
| Neither (no climate section) | 25 | 0.02% |

Köppen coverage is 123,335 of 129,313 GeoNames-matched routes and 1,307 of 1,373 unmatched or ambiguous routes. All Popular-40 routes pass both sources.

Every excluded path, grouped by reason, is listed in `data/climate-context.v1.json` under `exclusions`. Countries with the most exclusions: Philippines (254 NoData), Mexico, United States, Italy, France (mixed neighbourhoods), Romania (69 cell-edge ties).

**Later review, not in this PR:** coastal NoData centres might use the nearest land cell; mixed neighbourhoods might use a finer rule or a source with class probabilities; edge ties might use direct point responses at route coordinates. Each needs its own reviewed rule. None is forced here.

## Rendering

- The 40 Popular pages keep the reviewed pilot record, with byte-identical HTML.
- Other routes get a "Climate context for X" section after "About X". It shows only the parts that passed: the Köppen sentence, and/or the peak-month sentence plus a 12-month table.
- Timezone and elevation are not repeated, because "About" already shows them with GeoNames attribution.
- Source notes reuse the pilot's Beck and NASA POWER wording, links, CC BY 4.0 attribution and "modeled monthly means, not station observations or records" qualification. They are numbered by which sources appear.
- Excluded routes render no climate section.

## Worker packaging and limits

- The validated artifact is folded into existing private country shards at build time. Each row gets `[koppenClass|null, localCellIndex|null]`, and each shard carries only the NASA cells its rows use (`c`).
- The Worker validates every shard row and cell before indexing. The manifest records `climateSource` (inventory hash, Beck hash, NASA lock hash, API version). The runtime never imports the 9 MB artifact or calls NASA or Beck.
- A new build guard rejects any shard over 24 MiB (Cloudflare's limit is 25 MiB).
- Measured on the full inventory:
  - Total shards: 67.76 → 69.71 MB (+2.9%).
  - Largest shard `united-states.json`: 8.14 → 8.40 MB.
  - Node retained heap with the three largest shards parsed: 143.4 → 146.6 MB (+2.2%).
  - Expanded climate objects are memoized and frozen per shard. Without that, routes sharing a class and cell each got their own copy and the heap rose to 159.3 MB.
- Pre-existing note: the baseline 143 MB is Node `heapUsed` for three cached shards, not a workerd measurement. Isolate headroom deserves a separate check before any deploy.

## Snapshot and reproducibility

- NASA snapshot: October 3–4, 2026 (lock `accessedDate` 2026-10-04, UTC); API v2.10.0 throughout.
- 17,263 requests at 0.5 req/s, one in flight, with zero retries, 429s or 5xx. Latency p50 265 ms, p95 314 ms.
- About 80 MB of raw responses plus the journal and lock are kept privately outside Git.
- All 200 route-coordinate validation responses equal their assigned cell. All 40 Popular routes reproduce the pilot's rounded monthly values and peak months exactly.
- Two generator runs were byte-identical: `9bfe72baf74dff2560cedb71a18b6da006259a77babdaf7bb78930d2dc2927c0`, 9.80 MB.

## Regeneration

Python 3.11 with `scripts/enrichment-requirements.txt` (`rasterio`). The generator reads the full Köppen band into memory (about 1.9 GB peak RSS; about 12 s).

```sh
node scripts/probe-location-route-identity.mjs --source=scripts/resolved_cities.json --out=/PRIVATE/routes.json
# Plan only (no network) — prints cell and request counts:
python scripts/fetch-nasa-power-cells.py --route-index=/PRIVATE/routes.json --out-dir=/PRIVATE/nasa-power
# Approved fetch: single in-flight request, >= 2 s between starts, Retry-After (seconds or HTTP-date),
# long backoff on 429/5xx, exit 3 on sustained throttling, 4 on contract change, 5 on checkpoint corruption.
python scripts/fetch-nasa-power-cells.py ... --approved-by=<name>
python scripts/generate-climate-context.py --route-index=/PRIVATE/routes.json \
  --beck-zip=/PRIVATE/koppen_geiger_tif.zip --raster=/PRIVATE/koppen_geiger_0p00833333.tif \
  --legend=/PRIVATE/legend.txt --nasa-dir=/PRIVATE/nasa-power --output=data/climate-context.v1.json
npm run test:climate-context
```

The fetcher checkpoints each validated response with fsync and appends to a JSONL journal. On restart it hash-verifies every checkpoint and atomically truncates a torn final line before resuming. It writes `source-lock.json` only after every planned request is checkpointed. Raw responses, journal, lock and route index stay outside Git.
