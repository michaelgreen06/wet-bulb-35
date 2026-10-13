# Historical modeled wet bulb highs and lows: all-locations stage (issue #57, stage 2)

**Status, 2026-10-11: private acquisition and verification only. Nothing is published, merged or deployed. Supported (published) routes: 0 of 130,686.** Builds on the [stage 1 rollout](historical-wetbulb-issue57-rollout.md); method, source, wording and gates are unchanged.

## What this stage adds

- **Evidence-based route accounting** (`account_routes.py`). It gives every route exactly one status from what was actually acquired and verified, not from the plan alone. A route counts as `verified-candidate-unpublished` only when all of these hold:
  - its tile is sealed;
  - its period is complete and content-pinned;
  - the independent verifier passed for that period's **exact SHA-256**.
  
  Legacy verifier output without a digest, or a verdict for other bytes, never counts. A failed verdict outranks a pass.
- **Digest-bound, incremental verification.** `verify_period_independent.py --tile-run` now records each period's `periodSha256`. It also folds a tzdata mismatch into `ok`, skips tiles that are not yet sealed, and can skip groups that already passed for the same digest (`--skip-verified`).
- **The decoder dependency is checked before the ledger charges the first request.** A missing `numcodecs` now stops the run with nothing charged; previously the run failed after charging 16.7 KB of metadata.
- **HEAD probe by stage** (`probe_chunk_sizes.py --stage`) to measure a stage's exact tiles before approving it.

## Lows: the `low-v1` companion (2026-10-13)

Michael approved adding lows on 2026-10-13. Each complete local calendar date now also gets its **lowest modeled hourly wet bulb**, plus monthly and stated-period lows with UTC and local winner timestamps. Lows use the same pinned Romps method, ERA5-Land cell, timezone and validated hourly temperature, dew point and surface pressure as the highs. Nothing is mixed in from stations or other models, and nothing is labeled an official record.

**Legacy highs are immutable.** Every `y*.json`, `period.json`, `manifest.json` and tile `status.json` keeps its exact bytes. Lows are a versioned companion, never a silent rewrite:

| File | Contents |
|---|---|
| `groups/<id>/low-v1/period.json` | daily (`MM-DD`), monthly (`lowC`, `lowUTC`, `lowLocalDate`) and `periodLow`, plus the same coverage as the high |
| `groups/<id>/low-v1/manifest.json` | `lowPeriodSha256`; `highPeriodSha256` and `highManifestSha256` of the exact legacy bytes; the same `hourlyChunks`; annual low digests; `publicationApproved: false` |
| `tiles/arco/<tile>/low-status.json` | low digests per group, bound to the SHA-256 of the sealed `status.json` and of every high file in the tile |

Annual lows stay in memory, bound by digest, so they add ≈84 KB per group instead of another ≈4 MB of annual files.

**One pass.** `aggregateHistoricalWetBulbExtrema` solves each hour once and returns `{high, low}`. `high` is byte-identical to the previous aggregator, pinned by golden digests from `09bfbf8` in `tests/historical-wetbulb-lows.test.mjs`. New tiles write highs and lows from the same reduction.

**Offline backfill.** `backfill_lows.py` adds lows to tiles sealed before lows existed, from their retained checksummed chunks. It makes no provider call. It holds the output folder's run lock. For each tile, the re-reduction must:

- reproduce every high file byte-for-byte (write-once);
- reproduce the sealed status fields exactly;
- leave the hash of every high file and of `status.json` unchanged before and after.

Any difference stops the backfill with nothing written for that tile.

**Semantics.**

- **Ties:** the earliest hour wins, then the earliest day, then the earliest year, the same rule as for highs.
- **Negative values:** valid lows. The per-hour bounds are the same as for highs (inputs 150–350 K, `d ≤ t + 1 K`, 10–110 kPa, wet bulb −120…90 °C); any violation makes the whole cell unavailable.
- **Coverage:** a low must have the same coverage as its high. That covers DST 23/25-hour days, leap days, dateline-skipped dates (Apia 2011-12-30) and UTC+14/−12 year boundaries; a mismatch fails that group closed.
- **Reproducibility:** monthly and period lows must be reproducible from the calendar-date lows.

**Independent verification.** `verify_period_independent.py --extrema both` recomputes the minima in Python from the checksummed chunks, using zoneinfo local days and the bisection solver. Before checking any low, the solver must match 500 new cold heatindex 0.0.2 vectors (190–262 K, `romps-reference-vectors-cold.v1.json`). These were generated from the same pinned commit `ebe4a83`; that local build regenerates the existing fixture byte-for-byte.

Each low verdict is keyed by `lowPeriodSha256` and carries `highPeriodSha256`, so high-only readers ignore it. A sealed tile without lows is a failing row.

**Accounting.** High statuses and counts are computed exactly as before. Routes with a sealed high also get a `lowStatus`, one of:

- `low-verified-candidate-unpublished`
- `low-acquired-unverified`
- `low-unavailable-verification-failed`
- `low-unavailable-incomplete-period`
- `low-pending-backfill`

**Not publishable.** The renderer, page records and storage do not yet carry lows. Publishing them needs its own approval and renderer and storage validation.

## Measured, not estimated (2026-10-11)

| Measure | Value | Source |
|---|---:|---|
| Pilot pinned fetch | 240 chunk sets, 1,425,546,877 B, 51 min, no throttle/errors | pilot ledger, chunk mtimes |
| Pilot bytes vs estimate | −3.3% | ledger vs 2026-10-04 probe |
| Top-50 HEAD probe | 297 HEADs, 33/33 tiles, 0 absent objects; mean set 6.45 MB | `budget/chunk-size-probe-top50-2026-10-11.json` |
| Top-50 projected bytes | 4.25–4.37 GB | probe × pilot sample/full ratio (1.026) |
| Fetch time per tile | 130–155 s (20 sets, 2.5 s pacing) | chunk mtimes |
| Romps reduction | ≈10 s per cell-period (0.14 s per cell-year) | tile status vs last chunk |
| Independent verifier | ≈1 min per group (2 workers) | verifier run |
| Raw hourly chunk storage | ≈8.6 MB per cell (gzip −24% only) | pilot tiles |
| Derived per group | 4.05 MB (77 annual + period files); gzip ≈ 0.62 MB; period + manifest ≈ 78 KB | pilot groups |
| Free disk before Top-50 | 97 GB of 233 GB (one disk) | `df` |

ECMWF does not publish ARCO rate limits. It throttles on recent download volume, with undisclosed thresholds ([ECMWF ARCO docs](https://confluence.ecmwf.int/display/CKB/Analysis+Ready+Cloud+Optimised+(ARCO)+Data)). Fair use is therefore enforced empirically:

- one sequential worker with 2.5 s pacing;
- any non-404 HTTP error stops the run;
- the per-approval ledger caps attempts and bytes.

Access uses the existing CDS token and is free of charge; no billing account is involved.

## Acquisition ledger

| Approval | Scope | Cap | Used | Outcome |
|---|---|---|---|---|
| `pilot-staging-20261011` (Michael Green, 2026-10-11) | pilot | 240 sets / 1.50 GB | 240 / 1.426 GB | 12/12 tiles sealed |
| `top50-20261011` (Michael Green, 2026-10-11 `/goal`: pilot + Top 50 ≤ 5.6 GB) | top50 | 660 sets / 4.174 GB (5.6 GB − pilot) | _see results_ | 29 of 33 tiles run; 4 deferred |
| `campaign-20261011-job-NNN` (Michael Green, 2026-10-11 overnight authorization) | top50, then varied-regions | ≤ 10 GB each; 40 GB campaign ceiling | `campaign-20261011/state.json` | sequential, unattended |

The probe showed the full Top 50 does not fit the 5.6 GB ceiling. The run was bounded to the 29 tiles that fit with a 5% margin. The other four tiles (`t301-320`, `t303-376`, `t311-394`, `t314-399`) need about 0.5 GB more approval.

## Unattended campaign (from 2026-10-12T03:28Z)

**Authority.** Michael authorized sequential source-transfer jobs of at most 10,000,000,000 bytes each, including the four deferred Top-50 tiles (`approvals/michael-overnight-20261011.md`, SHA-256 `33100a62…`). He confirmed the persistent launch directly.

**Runner.** `campaign_supervisor.py` runs as the `systemd --user` transient unit `wetbulb-history-campaign` (linger on, so it survives logout but not a reboot). The plan is Top 50, then varied-regions. The `remaining` stage is refused until the storage decision below is made.

**Gates before every job.** Each check below fails closed:

- **Frozen inputs.** Plan, authority and pipeline-code SHA-256s must match `campaign-20261011/frozen.json`. Any code edit stops the campaign.
- **One writer.** The output folder's run lock must be free.
- **Approval and ledger.** Each job gets its own approval file and ledger (≤ 10 GB). Chunk sets are budgeted at the worst probed size, 8.5 MB.
- **Campaign ceiling.** 40 GB in total.
- **Disk.** Projected disk use must leave ≥ 40 GB free; the runner rechecks before every tile.
- **QA lag.** Independent vectorized QA of job *k* (highs and lows) runs while job *k*+1 fetches. Job *k*+2 never starts unless:
  - QA *k* passed;
  - every tile sealed when QA *k* started has a passing high **and** low verdict for its exact digests (coverage gate, `qa-coverage-gap`);
  - route accounting succeeded.

  A transient retry settles the previous QA and starts QA for the failed job's sealed tiles before fetching again.
- **Lows present.** A sealed tile without `low-status.json` stops the campaign (`low-coverage-absent`). On every (re)start the supervisor first backfills lows offline, then runs a blocking catch-up QA and the coverage gate.

**Stop conditions.** The campaign stops on any of these:

- HTTP 429 or 5xx;
- HTTP 401, 402 or 403 (auth or billing);
- a checksum, self-check or layout integrity error;
- a reduce failure or QA failure;
- a disk-floor or ceiling breach;
- code drift;
- a `STOP` file in the campaign folder.

Transient network errors get two retries, 15 minutes apart. Raw chunks are never deleted.

**Readback.**

```sh
~/.local/share/wetbulb35/historical-wbt/venv/bin/python scripts/historical-wetbulb/campaign_supervisor.py --status
systemctl --user status wetbulb-history-campaign; tail ~/.local/share/wetbulb35/historical-wbt/issue57-private/campaign-20261011/supervisor.log
touch ~/.local/share/wetbulb35/historical-wbt/issue57-private/campaign-20261011/STOP   # graceful stop between jobs
```

## Results

_Filled from `account_routes.py` after the Top-50 run and verification complete._

## Storage, retention and backup plan (decision needed before scaling)

These are full-scale projections from the measured unit sizes, for 76,509 groups in 16,656 tiles.

| Artifact | Full scale | Fits 97 GB? | Proposed retention |
|---|---:|---|---|
| Raw hourly chunks (`.bin`) | ≈650 GB | No | Transient. Delete a tile's `.bin` only after (1) the tile is sealed, (2) every group in it passed digest-bound independent verification, and (3) Tier A is backed up off-host. Re-fetchable by pinned object SHA-256. |
| Annual files `y*.json` | ≈310 GB raw / ≈48 GB gzip | Only gzipped | Gzip losslessly after verification, or drop them (they can be rebuilt from re-fetched chunks). |
| Tier A: approvals, ledgers, plan, self-check, tile status, chunk manifests (upstream object digests), period + manifest, verifier output, accounting | ≈8 GB | Yes | Keep permanently, with an **off-host backup** |
| Page shards | ≈240 MB | Yes | Built from Tier A |

Evidence that re-fetching reproduces inputs:

- **10 cells, full period.** The pilot self-check matched freshly pinned ARCO values exactly against PR #41's 2026-09-30 fetch, across 10 cells for the full 1950-01-02 → 2026-01-01 span.
- **Stable objects.** The historical objects report Last-Modified dates in February–May 2025.

Byte-level re-fetch equality (same SHA-256 twice) has not been tested. It would cost about 6–8 MB per chunk set under its own small approval.

**There is no backup today.** The host has one disk, with no external mount and no restic/borg/rclone. Pilot and Top 50 can be rebuilt entirely from the pinned upstream objects and the committed code, which is why their capped acquisition went ahead. Scaling beyond them needs Michael to choose the following:

1. **Off-host backup target for Tier A** (≈8 GB at full scale). Options: an existing Google Drive, a new R2 bucket (paid service/config change), or an external disk.
2. **Approval of the raw-chunk deletion rule** above. Without it, each cell uses about 12.6 MB (raw plus derived). Above the runner's 10 GB free-disk floor that leaves room for about 6.8k more cells:
   - varied-regions (3,588 cells, ≈45 GB) fits;
   - the remaining 72k cells do not.
3. **Acquisition approvals:**
   - the 4 deferred Top-50 tiles (≈0.5 GB);
   - varied-regions (201 tiles, ≈24.7 GB estimated; re-probe before approving).

## Proposed Google Drive backup, restore and retention design (for approval; nothing set up)

Michael chose Google Drive as the off-host target. Nothing below is installed or uploaded, and nothing is deleted, until Michael approves it.

**Measured now (232 groups).** Tier A is ≈55 MB:

- 78 KB per group (period + manifest);
- 0.7 MB of tile manifests;
- 36 MB of plan, ledgers, approvals and QA.

Annual files are 0.92 GB and raw hourly data is 2.04 GB. At full scale Tier A is ≈6.5 GB.

1. **Tool and scope.** Use rclone with a Google Drive remote in `drive.file` scope, so it sees only the files it created. The OAuth token stays in `~/.config/rclone` (mode 0600), never in Git. Back up into one private, unshared folder `wetbulb35-issue57-backup/`. No encryption layer: the data is public-model derived. The CDS token and `~/.cdsapirc` are excluded by an explicit allowlist.
2. **What is backed up.**

   | Tier | Contents | Upload rule |
   |---|---|---|
   | A, immutable | sealed `period.json`, `manifest.json`, tile `status.json`, `chunk-*.json` (upstream object SHA-256s), approvals | `objects/<relative path>`, `rclone copy --immutable --checksum`; never overwritten |
   | A, mutable | ledgers, `state.json`, `frozen.json`, QA `*.ndjson`, accounting, plan, `self-check.json` | `snapshots/<UTC>/`; each snapshot is a complete copy |
   | B | annual `y*.json` | Not backed up at full scale (≈48 GB gzipped exceeds Drive's free 15 GB). They are rebuildable from re-fetched raw data, and their digests sit in Tier A manifests. |
   | Raw `.bin` | — | Never uploaded. Restore path is a pinned re-fetch from ARCO. |

3. **When it runs.** A separate `systemd --user` timer runs every 6 h, plus once after each QA-passed job. It only reads the acquisition tree and never edits frozen code. Sealed files are write-once and mutable JSON is replaced atomically, so copying while the writer runs is safe.
4. **Verification.** Each snapshot writes `backup-manifest-<UTC>.json`, with the SHA-256 and size of every file, and uploads it last. `rclone check --checksum` (Drive keeps MD5) must report 0 differences, or the snapshot is marked failed.
5. **Restore drill.** This is required before any deletion, and is repeated weekly and before every deletion batch:
   1. Download the latest snapshot plus `objects/` into an empty private folder.
   2. Check every SHA-256 against the manifest.
   3. Re-run `account_routes.py` on the restored tree; the summary must be byte-identical.
   4. Rebuild page records from the restored `period.json` files with the publication encoder.
6. **Raw re-fetch drill.** This is also required before any deletion. Under its own approval of ≤ 50 MB, re-fetch 3 sampled chunk sets from different tiles and eras. Each upstream object's SHA-256 must equal the recorded digest, and the decoded values must equal the retained `.bin` exactly.
7. **Raw retention rule.** A tile's `.bin` files become deletable only when **all** of these hold:
   - the tile is sealed with no `failed.json`;
   - every group in it has a passing digest-bound verdict, or an explicit unavailable reason;
   - a backup snapshot containing the tile's Tier A files passed `rclone check`;
   - a restore drill and a raw re-fetch drill each passed within the last 7 days;
   - no writer holds the run lock.

   Deletion runs as a separate dry-run-by-default script. It writes a fsynced deletion ledger (tile, file, size, SHA-256) before each unlink.

   Pilot and Top-50 raw data (≈3 GB) are kept permanently as the local self-check and reference corpus.

**Disk under this rule.** Rolling raw usage per job is ≈2–3 GB. Tier A ≈6.5 GB and annual files stay local until the remaining stage. At that point annual files are dropped after verification (they are rebuildable and their digests are kept). This stays above the 40 GB floor.

**Open items for Michael:**

- The Drive account's free quota (unknown). Tier A at ≈6.5 GB fits the free 15 GB only if the account has room; a Google One plan would be a paid change.
- Approval of rules 1–7.
- One interactive `rclone config` OAuth login, done by Michael.

## Fixed: supervisor restart and transient-retry QA gaps

Both gaps below are fixed:

- **Restart catch-up QA** (`09bfbf8`). On restart, a blocking catch-up QA sweep runs before any fetch.
- **Transient-retry QA lag** (2026-10-13). On 2026-10-12, job-003 started after job-002's transient failure with QA job-001 still unsettled. A retry now settles the previous QA and starts QA for the failed job before fetching again; covered by a regression test.

Re-freezes use `campaign_supervisor.py --refreeze REASON`. It requires `STOP` and a stopped supervisor, requires the frozen code to be committed, and archives the previous `frozen.json` with its SHA-256. The original description of the restart gap follows.

### Original description (found by Hermes review)

`run()` marks a running QA as `interrupted` but never replays it. After a restart, the next job's QA covers the gap, but that next job and the one after it start before the interrupted QA's groups pass. That breaks the "job *k*+2 waits for QA *k*" gate. The same happens if the supervisor dies between a job ending and its QA starting.

Coverage is never lost: unverified groups are always re-verified later, and accounting credits only digest-bound passes. Only the ordering gate is broken. The live campaign is unaffected unless the supervisor restarts.

**Fix.** Prepared privately, not applied: `campaign-20261011/pending-fixes/qa-restart-catchup.patch`, SHA-256 `f77d57a8…`. It adds one blocking catch-up QA sweep and accounting before any post-restart fetch, plus a regression test. The test fails on the live code and passes with the patch.

**Applying it.** Editing the frozen supervisor stops the campaign, so apply it only at a controlled boundary:

1. `touch campaign-20261011/STOP`. The supervisor finishes the current job and its QA, then stops.
2. Apply the patch, run the tests and commit.
3. Archive `frozen.json` as `frozen-<UTC>.json`, which re-freezes the code deliberately.
4. Relaunch the same `systemd-run` command. The new catch-up sweep runs first.

Until then, any manual restart must first run a blocking `verify_period_independent.py --vectorized --skip-verified …` sweep.

## Runtime budget at full scale (measured rates; moderate confidence)

- **Fetch:** 16,656 tiles × ~150 s ≈ **694 h** (29 days), one paced worker.
- **Reduce:** 76k cells × 10 s ≈ 211 h. Today it runs serially after each tile's fetch; running reduction alongside the next fetch would hide it behind the fetch time.
- **Independent verification:** ≈1 min per group across 2 workers ≈ 76k min (**~53 days**). This is the critical path. The independent pure-Python bisection solver must be vectorized (e.g. NumPy, self-checked against the scalar reference on sampled hours) or given more cores before regional scale.
- **Page budget (stage 1, unchanged):** 3,166 shards, 240 MB, worst parse 0.8 ms.

All-location completion is weeks of wall time even after the decisions above. It must not be claimed from partial stages.

## Reproduce

```sh
Q=~/.local/share/wetbulb35/historical-wbt/issue57-private
V=~/.local/share/wetbulb35/historical-wbt/venv/bin/python   # has numcodecs
python3 scripts/historical-wetbulb/probe_chunk_sizes.py --plan $Q/plan/all-routes-plan.json --stage top50 \
  --per-stage 33 --chunks 0,10,19 --out $Q/budget/chunk-size-probe-top50-2026-10-11.json
$V scripts/historical-wetbulb/run_tile_backfill.py --plan $Q/plan/all-routes-plan.json --stage top50 --source arco \
  --approval $Q/approvals/top50-20261011.json --out $Q/pilot-pinned-20261011 --max-new-chunks 580 --execute
python3 scripts/historical-wetbulb/verify_period_independent.py --tile-run $Q/pilot-pinned-20261011 --source arco \
  --skip-verified $Q/verification/verify-run1-20261011.ndjson > $Q/verification/verify-run2.ndjson
$V scripts/historical-wetbulb/backfill_lows.py --out $Q/pilot-pinned-20261011 --workers 3   # offline lows
$V scripts/historical-wetbulb/verify_period_independent.py --tile-run $Q/pilot-pinned-20261011 --source arco \
  --extrema both --vectorized --workers 3 --skip-verified … > $Q/verification/verify-lows-backfill.ndjson
python3 scripts/historical-wetbulb/account_routes.py --plan $Q/plan/all-routes-plan.json --tile-run $Q/pilot-pinned-20261011 \
  --verified $Q/verification/verify-run1-20261011.ndjson --verified $Q/verification/verify-run2.ndjson \
  --routes-out $Q/accounting/routes.json --summary-out docs/phase2/historical-wetbulb-route-accounting.v1.json
```
