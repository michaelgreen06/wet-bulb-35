# Google Search Console cohort tracker

`scripts/gsc_tracker.py` measures indexing and search behavior with the read-only Search Console scope. It cannot submit sitemaps, request indexing, or modify a Search Console property.

## Cohort

Each run inspects exactly 400 unique canonical URLs:

- all 200 entries in `scripts/tier1-city-manifest.json`;
- the 40 Popular URLs tagged `popular-40`;
- ranks 1–50 tagged `top-50`;
- ranks 1–100 tagged `top-100`;
- ranks 1–200 tagged `top-200`;
- 200 controls outside the Top 200 tagged `control`.

Tags are nested; they do not cause duplicate URL Inspection requests. Controls are selected deterministically by SHA-256 ordering of canonical paths outside the Top 200 and committed as URL-only data in `scripts/gsc-control-manifest.json`.

Verify or intentionally regenerate controls after changing the resolved city inventory:

```sh
node scripts/generate-gsc-controls.mjs --check
node scripts/generate-gsc-controls.mjs
```

## Stored fields

The private SQLite history stores only extracted fields, never raw provider payloads:

- snapshot timestamp, canonical URL, rank, and nested cohort tags;
- URL Inspection verdict and coverage state;
- last crawl time, crawler, fetch, robots, and indexing states;
- Google-selected and user-declared canonicals;
- extracted sitemap and referring-URL lists;
- clicks, impressions, CTR, and position for the Search Analytics window.

The default Search Analytics window is the 28 final-data days ending three days before collection. Search Analytics can return only top rows; a missing page row is unknown, not proof of zero traffic.

## Credential-free validation

This uses only Python's standard library. It does not import a Google client, read credentials, or make a network request:

```sh
python3 scripts/gsc_tracker.py --dry-run
npm run test:gsc-tracker
```

## Private local collection

Install the pinned credentialed dependencies in an isolated environment:

```sh
python3 -m venv .venv-gsc
. .venv-gsc/bin/activate
pip install -r requirements-gsc.txt
python scripts/gsc_tracker.py \
  --database .private/gsc-history.sqlite3 \
  --csv .private/gsc-report.csv
```

Required environment variables:

- `GSC_SERVICE_ACCOUNT_JSON`: complete service-account JSON;
- `GSC_SITE_URL`: exact Search Console property, such as `sc-domain:wetbulb35.com`.

`.private/`, SQLite files, credentials, CSV reports, and API responses are excluded from Git. Do not place them in repository artifacts.

## Quota controls

- no more than 400 unique inspections per run;
- fail-closed daily preflight reserves capacity for all bounded retries;
- actual URL Inspection attempts are transactionally recorded before each request;
- request pacing stays below 600 URL Inspection calls per minute;
- no more than three attempts, only for `429` and transient `5xx` responses;
- Search Analytics is tracked separately from URL Inspection quota.

The API's published property limits remain 2,000 URL inspections/day and 600/minute.

## GitHub Actions

`.github/workflows/gsc-credential-smoke-test.yml` is manual-only. Its `smoke` operation checks that the installed secret has Full User property access and can perform one read-only homepage inspection. It prints only generic success or failure.

Its `encrypted-snapshot` operation performs the 400-URL collection, packages the private SQLite and CSV files, and encrypts the package with the repository's public recipient certificate before upload. Concurrency, same-day dispatch, and rerun guards prevent separate ephemeral runners from bypassing the daily reservation. The matching private decryption key lives outside Git on the Hermes host. The public-repository artifact is ciphertext only, expires after seven days, and cannot be decrypted by GitHub or repository readers. After downloading the artifact, decrypt it locally with:

```sh
scripts/decrypt-gsc-snapshot.sh path/to/gsc-snapshot.cms
```

Do not upload plaintext Search Console files, add plaintext caches or job summaries, or commit the private decryption key. Longitudinal decrypted history stays private and local.
