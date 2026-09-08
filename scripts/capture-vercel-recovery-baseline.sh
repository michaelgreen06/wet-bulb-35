#!/usr/bin/env bash
# Read-only Vercel recovery/rollback evidence capture. Never writes to Vercel.
set -euo pipefail
umask 077

SCOPE="${VERCEL_SCOPE:-michaels-projects-899a0e11}"
PROJECT="${VERCEL_PROJECT:-wetbulb2}"
OUT_DIR="${VERCEL_CAPTURE_DIR:-docs/phase1/captures/vercel}"
BACKUP_DIR="${VERCEL_BACKUP_DIR:-$HOME/.hermes/backups/wetbulb35/vercel}"
CLI_VERSION="${VERCEL_CLI_VERSION:-59.11.7}"
if [[ -n "${VERCEL_BIN:-}" ]]; then
  read -r -a VERCEL <<<"$VERCEL_BIN"
else
  VERCEL=(npx --yes "vercel@${CLI_VERSION}")
fi

fail() { printf 'capture failed: %s\n' "$*" >&2; exit 1; }
run() { "${VERCEL[@]}" "$@" --scope "$SCOPE"; }
mkdir -p "$OUT_DIR" "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"

# Authentication and scope evidence; output is sanitized by explicit field allowlists.
run teams ls --json >"$TMP/teams.json"
run project inspect "$PROJECT" >"$TMP/project-inspect.txt"
run list "$PROJECT" --limit 100 --json >"$TMP/deployments-list.json"
run env list production --project "$PROJECT" --json >"$TMP/env-list.json"
run domains list --limit 100 --json >"$TMP/domains.json"

# Determine the currently assigned production deployment from the structured list.
PROD_URL="$(python3 - "$TMP/deployments-list.json" <<'PY'
import json, sys
items=json.load(open(sys.argv[1]))['deployments']
prod=[d for d in items if d.get('target') == 'production']
if not prod: raise SystemExit('no production deployment found')
print(max(prod, key=lambda d:d.get('createdAt', 0))['url'])
PY
)"
run inspect "$PROD_URL" --json >"$TMP/current-production.json"

# Capture every listed deployment through inspect so retained rollback IDs/configs survive.
mkdir -p "$TMP/inspects"
python3 - "$TMP/deployments-list.json" <<'PY' >"$TMP/deployment-urls.txt"
import json, sys
for d in json.load(open(sys.argv[1]))['deployments']:
    print(d['url'])
PY
while IFS= read -r url; do
  safe="${url//[^A-Za-z0-9._-]/_}"
  run inspect "$url" --json >"$TMP/inspects/$safe.json" || printf '{"inspect_error":true}\n' >"$TMP/inspects/$safe.json"
done <"$TMP/deployment-urls.txt"

# Production values are intentionally kept only outside Git. Do not print or source this file.
BACKUP_FILE="$BACKUP_DIR/production-env-$STAMP.env"
run env pull "$BACKUP_FILE" --environment production --project "$PROJECT" --yes >/dev/null
chmod 600 "$BACKUP_FILE"
[[ "$(stat -c '%a' "$BACKUP_FILE")" == "600" ]] || fail 'environment backup permissions are not 0600'

# A harmless HEAD request proves the current production alias is reachable.
HTTP_HEADERS="$TMP/production-headers.txt"
curl --fail --silent --show-error --max-time 30 --head "https://www.wetbulb35.com/" >"$HTTP_HEADERS"

# Usage is account-scoped. Save either non-secret JSON or a bounded capability/error record.
if run usage --group-by project --json >"$TMP/usage.json" 2>"$TMP/usage.err"; then
  USAGE_STATUS="available"
else
  USAGE_STATUS="unavailable"
fi

# Sanitize all committed evidence via explicit allowlists, and calculate the private backup digest.
python3 - "$TMP" "$OUT_DIR" "$BACKUP_FILE" "$SCOPE" "$PROJECT" "$STAMP" "$USAGE_STATUS" <<'PY'
import datetime, hashlib, json, os, pathlib, re, sys
root, out, backup, scope, project, stamp, usage_status = map(str, sys.argv[1:])
out=pathlib.Path(out); out.mkdir(parents=True, exist_ok=True)
def load(name):
    return json.load(open(pathlib.Path(root)/name))
def dump(name, value):
    (out/name).write_text(json.dumps(value, indent=2, sort_keys=True)+'\n')
def iso(ms):
    return datetime.datetime.fromtimestamp(ms/1000, datetime.timezone.utc).isoformat().replace('+00:00','Z') if ms else None
teams=load('teams.json')
dump('scope.json', {'scope_slug':scope,'teams':[{'id':x.get('id'),'slug':x.get('slug'),'name':x.get('name'),'current':x.get('current')} for x in teams.get('teams',[])]})
# CLI has no JSON project-inspect; parse only stable non-secret lines and retain the source text separately.
project_text=(pathlib.Path(root)/'project-inspect.txt').read_text()
project_id=re.search(r'ID\s+([A-Za-z0-9_]+)', project_text)
dump('project.json', {'id':project_id.group(1) if project_id else None,'name':project,'scope_slug':scope,'inspect_text':project_text})
envs=[]
for e in load('env-list.json').get('envs',[]):
    envs.append({'key':e.get('key'),'type':e.get('type'),'target':e.get('target',[]),'configurationId':e.get('configurationId'),'createdAt':iso(e.get('createdAt')),'updatedAt':iso(e.get('updatedAt'))})
dump('environment-metadata.json', {'value_policy':'Values are excluded from Git; a mode-0600 production-only recovery copy is external.','variables':envs})
domains=[{'name':d.get('name'),'registrar':d.get('registrar'),'nameservers':d.get('nameservers'),'createdAt':iso(d.get('createdAt'))} for d in load('domains.json').get('domains',[]) if 'wetbulb' in d.get('name','')]
dump('domains.json', {'domains':domains,'dns_boundary':'Third Party / external nameservers; Cloudflare DNS is out of scope.'})
rawlist=load('deployments-list.json').get('deployments',[])
inspects={p.stem:json.load(open(p)) for p in (pathlib.Path(root)/'inspects').glob('*.json')}
inv=[]
for d in rawlist:
    key=re.sub(r'[^A-Za-z0-9._-]','_',d['url'])
    x=inspects.get(key,{})
    meta=d.get('meta') or {}
    inv.append({'id':x.get('id'),'url':d.get('url'),'state':d.get('state'),'target':d.get('target'),'createdAt':iso(d.get('createdAt')),'readyAt':iso(d.get('ready')),'source':{'sha':meta.get('githubCommitSha'),'ref':meta.get('githubCommitRef'),'repository':meta.get('githubCommitRepo'),'pr':meta.get('githubPrId')},'aliases':x.get('aliases',[]),'inspect_error':bool(x.get('inspect_error'))})
dump('deployment-inventory.json', {'count':len(inv),'retention_note':'Inventory reflects deployments returned by the CLI at capture time; it is not a retention-policy guarantee.','deployments':inv})
cur=load('current-production.json')
builds=[]
for b in cur.get('builds') or []:
    outputs=[]
    for o in b.get('output') or []:
        lam=o.get('lambda') or {}
        outputs.append({'path':o.get('path'),'type':o.get('type'),'size':o.get('size'),'runtime':lam.get('runtime'),'memorySize':lam.get('memorySize'),'timeout':lam.get('timeout'),'deployedTo':lam.get('deployedTo')})
    builds.append({'id':b.get('id'),'entrypoint':b.get('entrypoint'),'use':b.get('use'),'createdIn':b.get('createdIn'),'config':b.get('config'),'outputs':outputs})
meta=cur.get('meta') or {}
# Deployment inspect omits Git metadata in some CLI versions; use the matching list record.
listed_current=next((d for d in rawlist if d.get('url') == cur.get('url')), {})
listed_meta=listed_current.get('meta') or {}
source_meta={**listed_meta, **meta}
production={'id':cur.get('id'),'url':cur.get('url'),'readyState':cur.get('readyState'),'target':cur.get('target'),'createdAt':iso(cur.get('createdAt')),'aliases':cur.get('aliases',[]),'source':{'sha':source_meta.get('githubCommitSha'),'ref':source_meta.get('githubCommitRef'),'repository':source_meta.get('githubCommitRepo')},'builds':builds}
dump('current-production.json', production)
headers=(pathlib.Path(root)/'production-headers.txt').read_text().splitlines()
safe_headers=[h for h in headers if h.lower().startswith(('http/','date:','content-type:','cache-control:','x-vercel-','server:'))]
dump('production-reachability.json', {'url':'https://www.wetbulb35.com/','head_status':safe_headers[0] if safe_headers else None,'headers':safe_headers})
usage={'status':usage_status,'capture':'vercel usage --group-by project --json'}
if usage_status=='available':
    try: usage['data']=load('usage.json')
    except Exception: usage['status']='unparseable'
else:
    usage['detail']=(pathlib.Path(root)/'usage.err').read_text()[:500]
usage['analytics_note']='The CLI version has no analytics subcommand; Vercel Web Analytics and Observability request/function metrics may require dashboard/product entitlement.'
dump('observability-usage.json',usage)
raw_backup=open(backup,'rb').read(); h=hashlib.sha256(raw_backup).hexdigest(); st=os.stat(backup)
# Vercel intentionally writes [SENSITIVE] when an existing sensitive value cannot be read.
# This makes recovery coverage explicit rather than falsely calling a placeholder a backup.
sensitive_placeholders=raw_backup.count(b'[SENSITIVE]')
manifest={'schema_version':1,'captured_at_utc':stamp,'read_only':True,'scope_slug':scope,'project':project,'current_production':{'id':production['id'],'url':production['url'],'source_sha':production['source']['sha']},'files':['scope.json','project.json','domains.json','environment-metadata.json','current-production.json','deployment-inventory.json','production-reachability.json','observability-usage.json'],'private_production_environment_backup':{'path':backup,'sha256':h,'bytes':st.st_size,'mode':oct(st.st_mode & 0o777),'values_committed':False,'sensitive_placeholder_count':sensitive_placeholders,'complete':sensitive_placeholders == 0,'gap':'Vercel CLI does not reveal existing sensitive values; recover those from their original secret source.' if sensitive_placeholders else None}}
dump('recovery-manifest.json',manifest)
PY

printf 'Captured sanitized Vercel recovery evidence in %s\n' "$OUT_DIR"
printf 'Protected production environment backup: %s\n' "$BACKUP_FILE"
printf 'No Vercel mutation was performed.\n'
