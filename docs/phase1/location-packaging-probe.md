# Phase 1 location-packaging probe

## Verdict

**Recommend static-asset shards.** The compact country-shard candidate is 6,070,583 bytes raw (1,940,052 gzip) plus a 10,564-byte route manifest. That is small enough for the stated 25 MiB asset limit and uses 225 runtime files, far below the 100,000 asset cap. Static assets avoid placing the entire metadata set in the Worker bundle. This is a packaging recommendation only, not a Worker bundle-size, cold-start, or deployment benchmark.

## Method

`python3 scripts/probe-location-packaging.py --source scripts/resolved_cities.json --runs 5` uses only the Python standard library.

The probe incrementally decodes the top-level source JSON array in 64 KiB chunks. It writes raw field-preserving country shards, compact country shards, a minified-source candidate, and a route manifest under a `TemporaryDirectory`; all are deleted before the process returns. It emits one bounded JSON object: aggregate metrics, largest shard, hashes, timing summaries, and file-count projections rather than a record per country.

JSON serialization is deterministic (`ensure_ascii=False`, compact separators, stable source order); gzip uses level 9 and `mtime=0`. Directory hashes include sorted filename and content hashes. The test suite uses small temporary input and checks incremental parsing, no persisted artifacts, schema choices, deterministic compact hash, and reproducible gzip output.

## Schema comparison

| Candidate | Per-row representation | Retained fields | Dropped fields |
| --- | --- | --- | --- |
| Raw country shard | JSON object | `name`, `resolvedCountryName`, `resolvedAdmin1Code`, `latitude`, `longitude` | none |
| Compact country shard | `[name, admin1, latitude, longitude]` inside `{ "v": 1, "r": [...] }` | `name`, `resolvedAdmin1Code`, `latitude`, `longitude` | `resolvedCountryName`, derived from the manifest selected by the country route |

The manifest records the original country name and shard filename; route lookup applies the current renderer's `toSlug` to that country name, so the probe does not reimplement `slugify` semantics. The current route/rendering code reads those five source fields: city name, country, admin-1 code, latitude, and longitude. In the compact representation country remains available as manifest context. **Uncertain requirement:** a future renderer that needs per-row country duplication, source-object keys, or fields not present in the current source schema would require a schema review.

## Observed results

Probe run: 5 parse runs, local Linux process; source SHA-256 `d2b4f82c613f6c8318f8087a47099833341be535c896b62003fc13f414e6c1d9`.

| Item | Raw bytes | Gzip bytes | Files |
| --- | ---: | ---: | ---: |
| Source | 19,923,105 | 2,176,444 | 1 |
| Minified source candidate | 17,048,056 | 2,162,935 | 1 |
| Raw field-preserving country shards | 17,048,279 | 2,177,892 | 224 |
| Compact country shards | 6,070,583 | 1,940,052 | 224 |
| Route manifest | 10,564 | 2,230 | 1 |

- Rows: **130,684**; countries: **224**; country/state pairs: **3,525**.
- Largest compact shard: `united-states.json`, **16,498 rows**, **741,332 raw bytes**, **234,873 gzip bytes**.
- Largest raw field-preserving shard: `united-states.json`, **16,498 rows**, **2,209,642 raw bytes**, **263,390 gzip bytes**.
- Compact-shard plus manifest total: **6,081,147 raw bytes** and **1,942,282 gzip bytes**.
- Source incremental parse: **1,526.367–1,964.996 ms**, median **1,551.319 ms**. Largest compact-shard `json.load` parse: **9.353–12.132 ms**, median **10.199 ms**.
- Memory observed at reporting: current RSS **35,401,728 bytes**; process-lifetime peak RSS **36,761,600 bytes** (`getrusage(...).ru_maxrss`, Linux KiB semantics).
- Deterministic hashes: raw shards `dcc47a9ea13350538102ef89380706d2a340745726bdff184185500d4b3d713e`; compact shards `15b0d1d55c6f76f6c3889823fc7de737c9533a8cd73244b7e99cddf6d5ff0f34`; manifest `0c086836935be25e46dc6fb49da3c24bb4ebb5604fe9fd45613194b4d63c696f`.
- Projected committed/runtime files: current source **1**; either shard strategy plus manifest **225**; generated probe files persisted **0**.

## Limitations

- Timings are local Python parser timings, not JavaScript, Worker isolate, bundle, network, or cold-start measurements.
- Peak RSS is process-lifetime Linux `ru_maxrss`; current RSS is sampled from `/proc/self/status`, so neither isolates a single parsing operation.
- Gzip totals are the sum of independently compressed files; delivery compression, cache behavior, and asset-binding access were not tested.
- The probe validates packaging shape, not a real Worker bundle or runtime integration. It makes no claim about a Worker bundle or cold-start.
- The recommendation assumes static assets can be read by the proposed dynamic renderer; integration should confirm the platform binding/path behavior before implementation.

## Reproduce

```sh
python3 -m unittest tests/test_probe_location_packaging.py
python3 scripts/probe-location-packaging.py --source scripts/resolved_cities.json --runs 5
```
