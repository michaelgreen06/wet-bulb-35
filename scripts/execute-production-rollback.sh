#!/usr/bin/env bash
set -euo pipefail
node --input-type=module - "${1:-}" "${2:-}" <<'NODE'
import { recoverRelease, newMonitorState } from './scripts/production-monitor-control.mjs';
const [expectedVersion, rollbackVersion] = process.argv.slice(2);
newMonitorState({ expectedVersion, rollbackVersion, releaseSha: '0'.repeat(40) });
const result = await recoverRelease({ expectedVersion, rollbackVersion,
  token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
console.log(JSON.stringify(result));
process.exitCode = result.status === 'recovered' ? 0 : result.status === 'superseded' ? 3 : 5;
NODE
