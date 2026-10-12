# Historical modeled wet bulb highs: all-locations stage (issue #57, stage 2)

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
- **QA lag.** Independent vectorized QA of job *k* runs while job *k*+1 fetches. Job *k*+2 never starts unless QA *k* passed and route accounting succeeded.

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
python3 scripts/historical-wetbulb/account_routes.py --plan $Q/plan/all-routes-plan.json --tile-run $Q/pilot-pinned-20261011 \
  --verified $Q/verification/verify-run1-20261011.ndjson --verified $Q/verification/verify-run2.ndjson \
  --routes-out $Q/accounting/routes.json --summary-out docs/phase2/historical-wetbulb-route-accounting.v1.json
```
