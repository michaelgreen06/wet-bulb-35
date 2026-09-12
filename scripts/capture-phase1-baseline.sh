#!/usr/bin/env bash
# Capture the fixed Phase 1.1 production route allowlist without JavaScript.
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

capture_dir="docs/phase1/captures"
base_url="https://www.wetbulb35.com"
user_agent="wetbulb35-phase1-baseline-capture/1.0 (+https://www.wetbulb35.com/)"

# Do not add routes here without an explicit Phase 1 scope change. In particular,
# /api/weather and child sitemap URLs are intentionally excluded.
paths=(
  "/"
  "/wetbulb-temperature"
  "/wetbulb-temperature/united-states"
  "/wetbulb-temperature/united-states/texas"
  "/wetbulb-temperature/united-states/alabama/birmingham"
  "/about"
  "/not-a-real-page-9b1e3d"
  "/robots.txt"
  "/sitemap.xml"
)

rm -rf "$capture_dir"
mkdir -p "$capture_dir"

records_file=$(mktemp)
trap 'rm -f "$records_file"' EXIT

for route in "${paths[@]}"; do
  name=$(printf '%s' "$route" | sed -e 's#^/$#home#' -e 's#^/##' -e 's#/#--#g' -e 's#\.txt$##' -e 's#\.xml$##')
  requested_url="${base_url}${route}"
  headers_file="$capture_dir/${name}.headers.txt"
  body_file="$capture_dir/${name}.body"
  metadata_file=$(mktemp)
  captured_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  curl --silent --show-error --location --max-redirs 5 --connect-timeout 10 --max-time 30 \
    --user-agent "$user_agent" --header 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1' \
    --dump-header "$headers_file" --output "$body_file" \
    --write-out '%{url_effective}\n%{http_code}\n' "$requested_url" >"$metadata_file"

  final_url=$(sed -n '1p' "$metadata_file")
  final_status=$(sed -n '2p' "$metadata_file")
  sha256=$(sha256sum "$body_file" | cut -d ' ' -f 1)
  bytes=$(wc -c <"$body_file" | tr -d '[:space:]')

  python3 - "$records_file" "$captured_at" "$requested_url" "$final_url" "$final_status" "$headers_file" "$body_file" "$sha256" "$bytes" <<'PY'
import json
import pathlib
import re
import sys

(out, captured_at, requested_url, final_url, final_status, headers_file, body_file, sha256, bytes_) = sys.argv[1:]
text = pathlib.Path(headers_file).read_text(encoding="iso-8859-1")
blocks = [block for block in re.split(r"\r?\n\r?\n", text) if block.strip()]
redirect_chain = []
for block in blocks:
    lines = block.splitlines()
    status_line = next((line for line in lines if line.startswith("HTTP/")), None)
    if not status_line:
        continue
    status = int(status_line.split()[1])
    location = next((line.split(":", 1)[1].strip() for line in lines if line.lower().startswith("location:")), None)
    redirect_chain.append({"status": status, "location": location})
record = {
    "captured_at_utc": captured_at,
    "requested_url": requested_url,
    "final_url": final_url,
    "final_status": int(final_status),
    "redirect_chain": redirect_chain,
    "headers_file": str(pathlib.Path(headers_file).name),
    "body_file": str(pathlib.Path(body_file).name),
    "content_sha256": sha256,
    "content_bytes": int(bytes_),
}
with open(out, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, sort_keys=True) + "\n")
PY
  rm -f "$metadata_file"
done

python3 - "$records_file" "$capture_dir/manifest.json" <<'PY'
import json
import sys

records = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
expected_routes = [
    "/", "/wetbulb-temperature", "/wetbulb-temperature/united-states",
    "/wetbulb-temperature/united-states/texas",
    "/wetbulb-temperature/united-states/alabama/birmingham", "/about",
    "/not-a-real-page-9b1e3d", "/robots.txt", "/sitemap.xml",
]
assert [record["requested_url"].removeprefix("https://www.wetbulb35.com") for record in records] == expected_routes
assert all("/api/weather" not in record["requested_url"] for record in records)
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump({
        "method": "curl without JavaScript; fixed allowlist; redirects followed; child sitemaps excluded",
        "records": records,
    }, handle, indent=2)
    handle.write("\n")
PY
