#!/usr/bin/env bash
set -euo pipefail
VENV="${WETBULB_GA4_VENV:-/home/laclaw/.local/share/wetbulb35-ga4/venv}"
CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:-/home/laclaw/.config/wetbulb35/secrets/ga4-reader.json}"
mkdir -p -m 700 /home/laclaw/.local/share/wetbulb35-ga4
exec 9>/home/laclaw/.local/share/wetbulb35-ga4/spike-alert.lock
flock -n 9 || exit 0
export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS"
exec "$VENV/bin/python" "$(dirname "$0")/check-ga4-traffic-spike.py" "$@"
