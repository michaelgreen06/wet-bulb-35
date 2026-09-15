#!/usr/bin/env bash
set -uo pipefail

EXPECTED_VERSION="${1:-}"
ROLLBACK_VERSION="${2:-}"
if [[ ! "$EXPECTED_VERSION" =~ ^[0-9a-f-]{36}$ || ! "$ROLLBACK_VERSION" =~ ^[0-9a-f-]{36}$ ]]; then
  echo '{"status":"invalid_rollback_arguments"}' >&2
  exit 2
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo '{"status":"missing_cloudflare_credentials"}' >&2
  exit 2
fi

# Stale-monitor guard: never let a monitor for an older release roll back a
# newer active deployment.
ACTIVE_VERSION=$(node --input-type=module - <<'NODE'
import { readControlPlane } from './scripts/production-release-monitor.mjs';
const state = await readControlPlane({ token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
process.stdout.write(state.activeVersion || '');
NODE
)
if [[ "$ACTIVE_VERSION" != "$EXPECTED_VERSION" ]]; then
  printf '{"status":"rollback_refused_superseded","expected":"%s","active":"%s"}\n' "$EXPECTED_VERSION" "$ACTIVE_VERSION" >&2
  exit 3
fi

ROLLBACK_RC=0
npx --yes wrangler@4.129.1 rollback "$ROLLBACK_VERSION" \
  --name wetbulb35-weather-production \
  --message "Automated rollback after production release monitor failure" \
  --yes || ROLLBACK_RC=$?

# Version rollback does not repair routing triggers. This action can create only
# the exact approved route when it is absent and refuses to replace another
# script's route.
ROUTE_RC=0
node scripts/restore-production-worker-route.mjs --apply=true || ROUTE_RC=$?

VERIFY_RC=0
node scripts/production-release-monitor.mjs \
  --expected-version="$ROLLBACK_VERSION" \
  --recovery=true \
  --weather=false || VERIFY_RC=$?

if (( ROLLBACK_RC != 0 || ROUTE_RC != 0 || VERIFY_RC != 0 )); then
  printf '{"status":"rollback_recovery_failed","rollbackRc":%d,"routeRc":%d,"verifyRc":%d}\n' "$ROLLBACK_RC" "$ROUTE_RC" "$VERIFY_RC" >&2
  exit 1
fi
printf '{"status":"rolled_back_and_verified","version":"%s"}\n' "$ROLLBACK_VERSION"
