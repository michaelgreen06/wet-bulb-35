#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--approved-existing-route-deploy" ]]; then
  echo "Refusing production deploy without --approved-existing-route-deploy" >&2
  exit 2
fi

EXPECTED_SHA="${EXPECTED_RELEASE_SHA:-}"
if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "EXPECTED_RELEASE_SHA must be the approved 40-character commit" >&2
  exit 2
fi
if [[ "$(git rev-parse HEAD)" != "$EXPECTED_SHA" ]]; then
  echo "HEAD does not match EXPECTED_RELEASE_SHA" >&2
  exit 2
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Worktree must be clean" >&2
  exit 2
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" || -z "${NEXT_PUBLIC_GOOGLE_PLACES_API_KEY:-}" ]]; then
  echo "Required deployment credentials are not present" >&2
  exit 2
fi

node --input-type=module - <<'NODE'
import fs from 'node:fs';
import { validateProductionConfig } from './scripts/validate-production-release-config.mjs';
validateProductionConfig(fs.readFileSync('wrangler.weather-production-route.toml', 'utf8'));
NODE

npm run test:tier1-cities
npm run test:hono-page-renderer
npm run test:weather-edge
npm run build:hono-renderer-assets
node - <<'NODE'
const fs = require('fs');
const runtime = fs.readFileSync('worker-assets/assets/app.js', 'utf8');
if (!runtime.includes('maps.googleapis.com/maps/api/js')) throw new Error('Google Places runtime is absent');
NODE

# This is intentionally the route-bearing config. Do not replace it with
# wrangler.weather-production.toml: that config is route-free.
./node_modules/.bin/wrangler deploy --config wrangler.weather-production-route.toml
