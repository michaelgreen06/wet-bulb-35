#!/usr/bin/env bash
set -uo pipefail

EXPECTED_VERSION="${1:-}"
ROLLBACK_VERSION="${2:-}"
FULL_SITEMAPS="${3:-false}"
WEATHER="${4:-false}"
DELAY="${MONITOR_CONFIRM_DELAY_SECONDS:-20}"

run_once() {
  node scripts/production-release-monitor.mjs \
    --expected-version="$EXPECTED_VERSION" \
    --rollback-version="$ROLLBACK_VERSION" \
    --full-sitemaps="$FULL_SITEMAPS" \
    --weather="$WEATHER"
}

set +e
first=$(run_once)
first_rc=$?
set -e
if [[ "$first_rc" != "2" && "$first_rc" != "4" ]]; then
  printf '%s\n' "$first"
  exit "$first_rc"
fi

sleep "$DELAY"
set +e
second=$(run_once)
second_rc=$?
set -e
printf '%s\n' "$second"

# Critical release failures and control-plane failures must occur in two
# consecutive attempts before automation acts or pages an operator.
if [[ "$first_rc" = "$second_rc" ]]; then exit "$second_rc"; fi
exit 0
