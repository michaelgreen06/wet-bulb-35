# Historical modeled wet bulb highs: staged rollout (issue #57, stage 1 — pilot)

**Status, 2026-10-04: pipeline, gates and pilot verification only. No page shows historical highs; nothing is published, merged or deployed.** Stacked on research-only PR #41. Supported (published) routes today: **0 of 130,686**.

## What this stage delivers

1. **Every route accounted for.** `plan_all_routes.py` assigns each of the 130,686 canonical routes exactly one status and reason (table below), maps it to its nearest ERA5-Land cell, cell+IANA-timezone group and ARCO 4×8-cell tile, and orders acquisition by stage: pilot → Top 50 → varied regions → remaining. The committed [coverage summary](historical-wetbulb-route-coverage.v1.json) has counts and the review queue; the per-route plan stays private.
2. **A pilot verified two ways.** The 10 complete private 1950–2025 periods from PR #41 were (a) recomputed by an independent Python implementation and (b) re-derived end-to-end by the new tile pipeline. Both match exactly.
3. **A scalable, restartable pipeline.** It fetches each tile's 33,792-hour chunk once for up to 32 cells, so neighbouring routes share source bytes. It checksums every hourly chunk, reduces deterministically and refuses any retained output it cannot reproduce byte-for-byte. ARCO acquisition is approval-gated and content-pins every upstream object.
4. **A publication format, page section and gates.** Compact per-group records, Worker-safe decode and an HTML section with qualified wording and Copernicus attribution. Pages are cache-safe across local-date rollover. Building a record requires a named, dated approval for the exact period digest.

## Source method: ERA5-Land only in v1

- **Primary source: ERA5-Land hourly (0.1°, ~9 km), nearest cell to the route's mapped coordinate** (the same coordinate used for current weather). The route-to-cell-centre distance is median 3.9 km, p95 6.1 km, max 7.9 km. Cells come from the authenticated ARCO axes: latitude −90…90 (1,801 values), longitude −179.9…180.0 (3,600 values). The pure mapper reproduces all 50 metadata-resolved Top-50 cells, grid indices and tiles. JS and Python agree on all 130,686 routes.
- **Half-cell ties (3,215 routes, mostly 2-decimal coordinates)** are equidistant from two cell centres. We select the cell ourselves, so a tie is resolved deterministically to the north/east cell (as the one metadata-resolved tie, Guangzhou, did) and flagged. The page discloses the exact grid point.
- **ERA5 (0.25°) is not used in v1.** This rests on PR #41's evidence, with no new acquisition:
  - Paired same-hour Romps differences (ERA5 − ERA5-Land) at the six masked cities ranged from −0.20 to +1.59 °C in a 1950 sample and +0.30 to +1.16 °C in a 2025 sample.
  - The difference changed sign and size by city and era (Luanda +1.59 → +0.33; Rio +0.03 → +1.16).
  - All six ERA5 cells are mixed land/sea (official land-sea mask 0.33–0.60), and three grid-point centres lie on water.
  - There is no stationary correction, and no station set can validate a blend. So there is no averaging, max-of-models, splicing or station fill.
- **Masked nearest cell → unavailable** with reason `unavailable-masked-cell` and a review queue. All six known cases have ERA5-Land land-cell candidates within 15 km that pass the pinned same-landmass/over-land-path screen. Their full 1950–2025 data has not been acquired, so none is published.
- **Station data** stays excluded from v1, as approved.

## Route accounting (2026-10-04 plan)

| Status | Routes | Meaning |
|---|---:|---|
| `supported` | 0 | Approved, published complete-period history |
| `research-complete-unpublished` | 199 | Complete 1950-01-03 → 2025-12-31 private period for the route's exact cell+timezone (10 groups); awaiting provenance/publication approval |
| `pending-acquisition` | 129,104 | Identity, timezone and cell mapped; source not acquired |
| `unavailable-identity-unmatched` | 1,367 | No verified GeoNames identity/IANA timezone |
| `unavailable-masked-cell` | 7 | Nearest ERA5-Land cell has no land data (Chennai, Singapore, Dar es Salaam, Magomeni, Luanda, Rio de Janeiro, Mogadishu) |
| `unavailable-identity-ambiguous` | 6 | One GeoNames ID claimed by two routes (same quarantine as location facts) |
| `unavailable-incomplete-period` | 3 | Only partial private years (Houston cell: 1950–1952) |
| **Total** | **130,686** | Every route has exactly one status |

Routes whose tile is wholly absent from ARCO (all-ocean in ERA5-Land) will become `unavailable-masked-cell` when their tile is fetched. 2 of 40 sampled tiles are like this (Cabo Rojo, Puerto Rico; Moorea, French Polynesia). This is a sample, not a global rate.

## Pilot verification (real private data)

- **Scope.** 10 groups: Jakarta, Kolkata, Bangkok, Dhaka, Mumbai, Karachi, New Delhi, Hong Kong, Dubai and Lahore, ranks 2–9 and 11–12. Geographic variety is limited to South/Southeast/East Asia and the Gulf; no Americas, Europe, Africa or Oceania period is complete yet (acquisition gate below). The pilot does cover the hard calendar cases:
  - Hong Kong: 28 × 23-hour and 28 × 25-hour local dates.
  - Karachi and Lahore: 3 + 3 DST pairs.
  - Dhaka: 2009 DST.
  - Jakarta: UTC+7:30 → +7 offset change.
  - India: permanent +5:30.
  - Feb 29: 19 years each.
- **Independent recompute** (`verify_period_independent.py`). Its building blocks differ from the pipeline's:
  - Python `zoneinfo` local-midnight bounds.
  - A bisection Romps solver, within 4.5×10⁻¹³ K of the 500 heatindex 0.0.2 reference vectors.
  - Its own checksum/cell/timezone joins over all 760 retained city-years.

  Result for all 10 periods: 27,757 complete local dates, first 1950-01-03, last 2025-12-31, 366 calendar keys. Every calendar-date, monthly and period high matched within 10⁻⁶ °C at the same UTC hour and local date.
- **Pipeline reproduction** (`run_tile_backfill.py --source archive`). It replayed the retained hourly inputs (772 chunk writes, about 3 min, no network) and checked every padded year overlap for exact agreement. All 10 periods were field-identical to PR #41's. The independent verifier (`--tile-run`) also passed on the pipeline's own output and checksummed chunks; tzdata was 2026c on both the Node and Python sides. Deleting a tile status and one chunk caused exactly that chunk to be rebuilt, with byte-identical annual files.
- **Fail-soft at scale.** One bad cell or group no longer stops a tile:
  - A cell with a gap or invalid input becomes `unavailableCells` with a reason.
  - A group failing period validation becomes `failedGroups`.
  - A tile-level integrity failure writes `failed.json` and the stage continues; a rerun retries that tile.
  - Reproducibility mismatches still stop the run.
- **Zones that skipped a calendar date use their own calendar.** Pacific/Apia and Fakaofo skipped 2011-12-30; Kwajalein skipped 1993-08-21; Kiritimati and Kanton skipped 1994-12-31. The record lists these dates in `skip`, and the decoder counts years with them excluded.
- **Negative cases under test:**
  - Half-hour offsets; 23/25-hour dates; a single missing hour (only that local date becomes partial).
  - A cell missing in one chunk but present in another (refused as partial); non-contiguous chunks; tampered hourly/annual/period bytes.
  - Identity/timezone drift; ambiguous IDs; masked cells.
  - Research-only data without explicit provenance acceptance; approvals for a different digest or scope (the planner applies the same rule as the publisher).
  - Shards accept only records returned by the approval gate (frozen), keyed by their own cell and zone, in their own 2° bucket.
  - Each source has its own chunk and output folders, and a restart refuses chunks from a different source.
  - Acquisition caps are cumulative per approval digest and fail closed. The fsynced ledger charges each chunk attempt before its first request. It also reserves each GET's full byte allowance before sending, and only a complete response settles it down to the bytes received. An exception, oversize abort or killed process leaves the allowance charged, so a fresh run cannot re-spend it. Metadata and time-axis reads are charged too, and the ledger never marks work complete.
  - The transport enforces the remaining allowance while reading. A declared Content-Length over the allowance aborts before the body, a body is read in bounded blocks and abandoned past the allowance, and truncated responses are refused.
  - Out-of-period or non-maximal packed records; HTML injection; local-date rollover at a DST change, at UTC+14 and at UTC−11.

## Acquisition plan and gate (not executed)

ARCO stores are appended in place: both `.zmetadata` digests changed between 2026-09-30 and 2026-10-04, and the time axis is now 672,744 hours. A metadata digest therefore cannot pin values. `arco_pinned_source.py` instead:

- records SHA-256 and byte length for every compressed upstream chunk object;
- decodes only those bytes;
- trims every read to 1950-01-02T00Z–2026-01-02T23Z.

Historical objects report stable ETags, with Last-Modified dates of 14–16 February 2025. Before any non-pilot stage, freshly fetched, content-pinned pilot hours must equal PR #41's retained hours exactly over at least 364 **contiguous, unique** days for one cell. The evidence file stores merged unique (cell, UTC hour) intervals plus the upstream object digests of each contributing chunk, so re-fetching or replaying a span adds nothing. A recorded mismatch blocks acquisition until reviewed, and legacy counter-only evidence is rejected.

The estimates use a HEAD-only probe: 240 requests, Content-Length only, 40 stage-sampled tiles. A t2m + d2m + sp time-chunk set averages 6.14 MB (median 6.79 MB). Each tile needs 20 time chunks.

| Stage | Routes | Pending | Tiles | Groups | Est. egress | Est. sequential time |
|---|---:|---:|---:|---:|---:|---:|
| pilot (re-fetch, pinned) | 529 | 327 | 12 | 130 | 1.5 GB | 0.8 h |
| top50 | 885 | 885 | 33 | 308 | 4.1 GB | 2.1 h |
| varied-regions (top-yield tiles in each of 9 IANA regions) | 14,000 | 14,000 | 201 | 3,688 | 24.7 GB | 12.8 h |
| remaining (70 spatial batches) | 113,892 | 113,892 | 16,410 | 72,383 | 2.0 TB | 1,048 h |
| **All** | | | **16,656** | **76,509** | **≈2.05 TB** | **≈1,064 h (~44 days, one worker)** |

Confidence:

- **Bytes: moderate.** Based on 80 samples.
- **Time: low.** It uses the 2026-09-30 sequential rate of 11.5 s per fetch, and throughput and throttling at scale are unmeasured.
- **CPU:** reduction is about 0.2 s per cell-year; JS Romps is not the bottleneck.

Retained hourly chunks need at most ~256 MB per fully used tile (32 cells × 666,240 h × 12 bytes); the varied-regions stage needs roughly 30 GB of local disk. Discarding hourly chunks after reduction is a follow-up. The first three stages need no paid service, external storage or scheduler.

## Page record, wording and budget

- **Record.** One per cell+timezone group: 366 calendar-date highs (int16 tenths °C + int32 UTC hour) plus 13 unrounded winner indices for months and period, 3,111–3,121 bytes as JSON. Contributing years per date, monthly highs and the period high are derived and verified on decode.
- **Shards.** 2° × 2° buckets: 3,166 files for all 76,509 planned groups, 240 MB total, median 19 KB, p95 349 KB, max 1.22 MB (under the 25 MiB per-file limit).
- **Worker lookup.** The Worker can derive each route's cell from its coordinates plus the location-facts timezone already shipped on main. Country shards need no new bytes.
- **Runtime (Node 26).** Worst shard parse 0.8 ms and ~1.3 MB retained heap. Decode with full validation 3.3 ms; memoize per group as climate context does. Render 0.06 ms. Section ≈9.8 KB raw / 2.4 KB gzip.
- **Wording.** "The highest modeled hourly wet bulb temperature at the ERA5-Land grid point nearest {place} was X °C on {local date}, over the complete period {first} to {last}." The section also:
  - discloses the 0.1° cell centre, its distance from the mapped location, the Romps method and the IANA zone;
  - states the values are "not station observations, official records or all-time records";
  - links DOI 10.24381/cds.e2161bac with the Copernicus modified-information attribution.
- **Cache-safety.** Period and monthly highs are server-rendered. Today's calendar-date line is filled in the browser from inert JSON for the location's IANA zone, so a 24-hour HTML cache never freezes yesterday's date. The client snippet is literal source and is tested by executing it, including the rollover and re-render on tab resume.
- **tzdata.** Shards and manifests record the build's tzdata version. Workers recompute pre-1970 local dates on decode, so staging must confirm that the Worker's tzdata gives the same dates.

## Not supported yet / remaining gates

- **No page integration in this PR.** PR #41's base predates main's location facts (#46) and climate context (#48). Wiring the section into `page-renderer.mjs`, the shard build and `app.js` should follow once PR #41 is rebased onto main. Isolated staging, date-rollover QA and Worker-memory checks come after that.
- **Publication approval for the 10 pilot periods.** Their hourly inputs came from ARCO before chunk pinning (`researchOnly`). Options:
  - (a) Michael accepts that provenance (`acceptsResearchProvenance`, plus the independent verification above); or
  - (b) re-fetch the pilot pinned (1.5 GB) and require the self-check.
- **Licence wording check.** The attribution string follows the Copernicus licence's modified-information form; confirm the current CDS licence text for ERA5-Land before release (moderate confidence).
- **Identity backlog.** 1,367 unmatched and 6 ambiguous routes.
- **Masked review queue.** 7 routes; candidate land cells need full-period data and terrain review.
- **Whole-tile ocean sweep.** About 16.7k HEADs; a metadata sweep, but not small.
- Hourly-chunk retention/discard policy and private backup.
- No claim is made beyond the verified 10 groups / 199 routes. The 130k-route history does not exist yet.

## Reproduce (private inputs; never in Git)

```sh
P=~/.local/share/wetbulb35/historical-wbt/private     # PR #41 research (read-only)
Q=~/.local/share/wetbulb35/historical-wbt/issue57-private
python3 scripts/historical-wetbulb/plan_all_routes.py --routes $P/route-index-main-c8b6.json \
  --identities $P/city-index-c8b6-20260929.json --ranking scripts/tier1-city-manifest.json \
  --mask-survey $P/top50-mask-audit-1950 --research $P/top50-ten-unmasked-periods-20260930 \
  --research $P/top50-ten-unmasked-jobs-20260930 --research $P/top50-pilot-jobs --research $P/top50-samples \
  --plan-out $Q/plan/all-routes-plan.json --summary-out $Q/plan/summary.json
python3 scripts/historical-wetbulb/verify_period_independent.py --periods $P/top50-ten-unmasked-periods-20260930 \
  --jobs $P/top50-ten-unmasked-jobs-20260930 --rank 2 --rank 3 --rank 4 --rank 5 --rank 6 --rank 7 --rank 8 --rank 9 --rank 11 --rank 12
python3 scripts/historical-wetbulb/run_tile_backfill.py --plan $Q/plan/all-routes-plan.json --stage pilot \
  --source archive --archive-jobs $P/top50-ten-unmasked-jobs-20260930 --out $Q/pilot-run-v2 --max-new-chunks 1000 --execute
python3 scripts/historical-wetbulb/verify_period_independent.py --tile-run $Q/pilot-run-v2
node --expose-gc --experimental-strip-types scripts/historical-wetbulb/measure-history-budget.mjs \
  --periods=$Q/pilot-run-v2/groups/archive --plan=$Q/plan/all-routes-plan.json --out=$Q/budget/history-budget.json
# Gated: --source arco --approval APPROVAL.json (scope acquire-era5land-arco, approver, date, plan SHA-256,
# stages, maxChunkFetches, maxBytes) and, for non-pilot stages, a passing self-check.json.
npm run test:historical-wetbulb
```
