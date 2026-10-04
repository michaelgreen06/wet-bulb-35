#!/usr/bin/env bash
# Private operator-host wrapper for the admin dashboard collectors (issue #53).
set -euo pipefail
VENV="${WETBULB_ADMIN_VENV:-/home/laclaw/.local/share/wetbulb35-ga4/venv}"
export GOOGLE_APPLICATION_CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:-/home/laclaw/.config/wetbulb35/secrets/ga4-reader.json}"
mkdir -p -m 700 /home/laclaw/.local/share/wetbulb35-admin
exec 9>/home/laclaw/.local/share/wetbulb35-admin/collector.lock
flock -n 9 || exit 0
exec "$VENV/bin/python" "$(dirname "$0")/collect-admin-status.py" "$@"
