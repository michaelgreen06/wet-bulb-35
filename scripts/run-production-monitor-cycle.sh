#!/usr/bin/env bash
set -euo pipefail
node --input-type=module - "${1:-}" "${2:-}" "${3:-false}" "${4:-false}" <<'NODE'
import { confirmedChecks } from './scripts/production-monitor-control.mjs';
const [expectedVersion, rollbackVersion, full, weather] = process.argv.slice(2);
const result = await confirmedChecks({ expectedVersion, rollbackVersion,
  fullSitemaps: full === 'true', weatherBudget: weather === 'true' ? 4 : 0,
  token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
console.log(JSON.stringify(result));
process.exitCode = result.rollbackEligible ? 2 : result.status === 'superseded' ? 3
  : result.status === 'recovery_failure' ? 5 : ['control_unavailable', 'unconfirmed_failure'].includes(result.status) ? 4 : 0;
NODE
