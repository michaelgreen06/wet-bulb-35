#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 ENCRYPTED_CMS [OUTPUT_DIRECTORY]" >&2
  exit 2
fi

input=$1
output=${2:-.private/gsc-snapshots/$(date -u +%Y%m%dT%H%M%SZ)}
private_key=${GSC_SNAPSHOT_PRIVATE_KEY:-$HOME/.config/wetbulb35/gsc-snapshot-artifact-private.pem}
certificate=$(cd "$(dirname "$0")" && pwd)/gsc-snapshot-artifact-recipient.pem

[[ -f "$input" ]] || { echo "Encrypted snapshot not found" >&2; exit 1; }
[[ -f "$private_key" ]] || { echo "Private decryption key not found" >&2; exit 1; }
[[ -f "$certificate" ]] || { echo "Recipient certificate not found" >&2; exit 1; }

mkdir -p "$output"
chmod 700 "$output"
temporary=$(mktemp)
trap 'rm -f "$temporary"' EXIT

openssl cms -decrypt -binary -inform DER \
  -in "$input" \
  -recip "$certificate" \
  -inkey "$private_key" \
  -out "$temporary"

entries=$(tar -tzf "$temporary" | LC_ALL=C sort)
expected=$'gsc-snapshot.csv\ngsc-snapshot.sqlite3'
[[ "$entries" == "$expected" ]] || { echo "Unexpected encrypted snapshot contents" >&2; exit 1; }
tar -xzf "$temporary" -C "$output" --no-same-owner --no-same-permissions
chmod 600 "$output/gsc-snapshot.csv" "$output/gsc-snapshot.sqlite3"
printf '%s\n' "$output"
