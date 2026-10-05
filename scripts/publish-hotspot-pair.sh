#!/usr/bin/env bash
# Publish both immutable objects before changing either current alias. Best-effort
# rollback restores both old aliases after a failed write/read-back; SIGKILL and
# external writers still require independent monitoring/reconciliation.
set -Eeuo pipefail
: "${HOTSPOT_R2_BUCKET:?required}"
mkdir -p .hotspots
objects=(inhabited global-grid)
prefixes=(inhabited-hotspots global-grid-hotspots)
sources=(.hotspots/snapshot.json .hotspots/global-grid-snapshot.json)
current=(.hotspots/current-inhabited.json .hotspots/current-global-grid.json)
publish=("${PUBLISH_INHABITED:-false}" "${PUBLISH_GLOBAL_GRID:-false}")
keys=()
for i in 0 1; do
  keys[i]="${prefixes[i]}/v1/latest.json"
done

get_object() { npx wrangler r2 object get "$HOTSPOT_R2_BUCKET/$1" --file="$2" --remote; }
put_object() { npx wrangler r2 object put "$HOTSPOT_R2_BUCKET/$1" --file="$2" --remote; }

# The prior read and the pre-commit read must agree. A missing object is only
# accepted when the initial read also found it missing (with errors already checked).
for i in 0 1; do
  if [[ -f "${current[i]}" ]]; then
    get_object "${keys[i]}" ".hotspots/before-$i.json"
    cmp "${current[i]}" ".hotspots/before-$i.json"
    digest=$(sha256sum "${current[i]}" | cut -d' ' -f1)
    backup="${prefixes[i]}/v1/snapshots/sha256-$digest.json"
    put_object "$backup" "${current[i]}"
    get_object "$backup" ".hotspots/verify-backup-$i.json"
    cmp "${current[i]}" ".hotspots/verify-backup-$i.json"
  else
    # Do not overwrite a newly-created alias. Non-404 failures also abort.
    if get_object "${keys[i]}" ".hotspots/unexpected-$i.json" >".hotspots/get-$i.log" 2>&1; then
      echo "Unexpected current alias appeared: ${keys[i]}" >&2; exit 1
    fi
    if ! grep -qiE 'does not exist|NoSuchKey|not found|404' ".hotspots/get-$i.log"; then
      cat ".hotspots/get-$i.log" >&2; exit 1
    fi
  fi
done

# Prepare ALL new immutable objects before touching ANY latest alias.
for i in 0 1; do
  if [[ "${publish[i]}" == true ]]; then
    digest=$(sha256sum "${sources[i]}" | cut -d' ' -f1)
    immutable="${prefixes[i]}/v1/snapshots/sha256-$digest.json"
    put_object "$immutable" "${sources[i]}"
    get_object "$immutable" ".hotspots/verify-new-$i.json"
    cmp "${sources[i]}" ".hotspots/verify-new-$i.json"
  fi
done

# Refuse a partial pair or mismatched validity window before publication.
for i in 0 1; do
  if [[ "${publish[i]}" == true ]]; then
    cp "${sources[i]}" ".hotspots/proposed-$i.json"
  else
    cp "${current[i]}" ".hotspots/proposed-$i.json"
  fi
done
node scripts/hotspot-pair-check.mjs .hotspots/proposed-0.json .hotspots/proposed-1.json

committing=false
rollback() {
  status=$?
  if [[ "$status" -eq 0 ]]; then status=1; fi
  trap - ERR INT TERM
  if [[ "$committing" == true ]]; then
    echo "Current-alias update failed; restoring both aliases from verified backups" >&2
    for i in 0 1; do
      if [[ "${publish[i]}" == true ]]; then
        if [[ -f "${current[i]}" ]]; then
          put_object "${keys[i]}" "${current[i]}" && get_object "${keys[i]}" ".hotspots/verify-restore-$i.json" && cmp "${current[i]}" ".hotspots/verify-restore-$i.json" || echo "::error::Rollback failed for ${keys[i]}" >&2
        else
          npx wrangler r2 object delete "$HOTSPOT_R2_BUCKET/${keys[i]}" --remote --force || echo "::error::Rollback delete failed for ${keys[i]}" >&2
        fi
      fi
    done
  fi
  exit "$status"
}
trap rollback ERR INT TERM
committing=true
for i in 0 1; do
  if [[ "${publish[i]}" == true ]]; then
    put_object "${keys[i]}" "${sources[i]}"
    get_object "${keys[i]}" ".hotspots/verify-latest-$i.json"
    cmp "${sources[i]}" ".hotspots/verify-latest-$i.json"
  else
    cp "${current[i]}" ".hotspots/verify-latest-$i.json"
  fi
done
node scripts/hotspot-pair-check.mjs .hotspots/verify-latest-0.json .hotspots/verify-latest-1.json
committing=false
trap - ERR INT TERM
for i in 0 1; do
  if [[ "${publish[i]}" == true ]]; then cp "${sources[i]}" "${current[i]}"; fi
done
