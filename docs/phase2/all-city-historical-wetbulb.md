# Historical modeled wet bulb highs: offline implementation status

Status: **offline pipeline prototype; not a live page feature**. The PR implements bounded acquisition, source alignment, stable-route identity lookup, Romps hourly calculation, local-day/month/year aggregation, and a compact static-asset encoding. It does **not** include complete ERA5-Land history, production Worker routes, public page copy, or a deployment. Do not merge or publish it as a completed all-city feature.

## Verified on 2026-09-29

- CDS authenticated privately; the 1950 Phoenix request provided two CSV field groups and **8,736** aligned hourly temperature/dew-point/surface-pressure rows at the same actual grid point. One source year (~169 KB ZIP) was normalized, reduced with the production Romps engine, and packaged as a **research-only** 5,251-byte static shard. The high within that **1950-only** sample was ~24.26 °C; this is **not** the historical period high.
- A bounded 0.1° area request returned **four cells × 48 hours** in the same two-group source schema; the CDS cost estimator charges 300/500 for a four-cell request and 7,500/500 for a 1° square in this tested case. Do not assume the web form's maximum area is a usable bulk request. The bounded downloader was exercised against a **real New York October 31–November 3, 2020** request: 96/96 simultaneous valid hours, with **25 hours on local November 1** as expected at DST fall-back. The time-series API is likely inefficient at global scale; benchmark geo-chunked ARCO regional throughput and fair use before bulk download.
- A pinned 2026-09-29 GeoNames `cities1000.zip` source joined 129,319 canonical rows by a cautious name/alternate + country + distance match with verified IANA timezone; 1,367 rows remain explicitly unmatched. The 129,319 matched rows occupy 76,154 approximate 0.1° cells and 76,545 cell+timezone proxy groups. These are **not** validated actual ERA5-Land cell counts. Private source, route index and full join report remain off Git under `~/.local/share/wetbulb35/historical-wbt/private`.
- Tests cover simultaneous field alignment, rejecting null pressure/source-cell mismatches, incomplete UTC-window edge dates, 23/25-hour IANA DST dates, leap day, annual merge provenance, compact history encoding, size caps and private output refusal. The normal static-asset packer refuses incomplete local-year coverage; the 1950 sample is labeled `researchOnly` and cannot be published through the default packer.

## Reproducible offline commands

Run these only against privately obtained, bounded CDS data; never run a site visitor or Worker request against CDS:

```bash
python3 -m unittest tests/test_historical_cds_download.py tests/test_historical_cds_normalizer.py tests/test_historical_city_index.py
node --experimental-strip-types --test tests/historical-wetbulb-aggregate.test.mjs tests/historical-wetbulb-merge.test.mjs tests/historical-wetbulb-assets.test.mjs
# In a separate private Python venv with cdsapi installed, after accepting CDS terms:
python3 scripts/historical-wetbulb/download_cds.py --point 33.4484 -112.074 --start 1950-02-28 --end 1950-03-01 --out /PRIVATE/phoenix.zip
python3 scripts/historical-wetbulb/normalize_cds.py --source /PRIVATE/phoenix.zip --out /PRIVATE/phoenix-normalized
node --experimental-strip-types scripts/historical-wetbulb/aggregate-year.mjs --normalized /PRIVATE/phoenix-normalized --cell 33.4,-112.1 --timezone America/Phoenix --year 1950 --out /PRIVATE/phoenix-1950.json
```

`download_cds.py` accepts a point or a ≤0.1° research area, at most 367 UTC dates and an approved CDS cost ≤500; pending jobs return a job ID for `--resume-job`. Never run parallel unbounded loops against CDS. The GeoNames city-index CLI consumes the exact route index from `scripts/probe-location-route-identity.mjs` and writes a private 0600 index. Source ZIPs and normalized rows are not tracked in Git.

## Remaining implementation gates

1. Establish a fair-use, high-throughput regional data acquisition method. Authenticated CDS API time-series estimates for a four-cell 0.1° area were 300/500, while a 1° square was 7,500/500 and rejected by our bounded downloader. We also authenticated directly to ECMWF's geo-chunked ARCO Zarr metadata and read real Phoenix hours using the existing private CDS Bearer token. The official 2m-temperature and pressure-group Zarr stores contain aligned `t2m`, `d2m`, and `sp`, each chunked by **33,792 UTC hours × 4 latitude cells × 8 longitude cells**. A 1950 Phoenix year (8,736 hours) fetched in ~12 seconds for temperature/dew point and ~3 seconds for pressure, matched every CDS CSV hour and value within CSV rounding (<0.01 Pa/<0.00002 K). The three compressed 1950 chunk objects were ~7.08 MB total, shared among up to 32 cells. These single-cell numbers are a *feasibility signal*, not a safe full-globe throughput estimate; measure actual spatial-chunk occupancy, egress, throttling and land/ocean masks before bulk fetching. The global ~76k cell+timezone proxy is too large for unaudited point-job fanout.
2. Resolve the 1,367 unmatched identities using historical/allCountries GeoNames source and explicit reviewed overrides; preserve canonical paths and expose unsupported rows honestly.
3. Build a durable, resumable, backed-up **private** yearly/tile run with pinned input hashes and deterministic validation. Complete all approved cell/timezone histories for 1950–last complete year. Enforce 23/25-hour local-day completeness, Feb 29, missing hours and land/ocean masks; produce all-city coverage and uncertainty manifests. Do not call a partial year a period record.
4. Measure full-size shard counts and sizes, Cloudflare upload and Worker isolate memory. If static assets fail limits/performance, request approval for a read-only R2 history binding; raw private source storage is a separate decision.
5. Add a gated Worker asset loader, timezone-local current date and clock, accessible city-page table/copy and dynamic date rollover. Do not alter the 24-hour/7-day city HTML cache naively: version+route-only cache keys can freeze yesterday's local date.
6. Verify every one of 130,686 routes resolves to one fact/history record or explicit unavailability, then stage and stress across large/shard-diverse cities; production still requires separately approved merge, backup/restore, deploy and monitor. Forecast/current weather and NASA POWER Popular-40 content stay unchanged until reviewed.

The planned wording is **highest modeled hourly wet bulb temperature in ERA5-Land over the stated complete period**, not an observed official or absolute all-time record.
