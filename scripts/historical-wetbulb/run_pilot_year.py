#!/usr/bin/env python3
"""One ranked route × one padded local year of private ARCO research.

Dry-run by default. --execute fetches one geo-chunk/year only; no loops, no
publication, no fallback to a nearby masked cell. Restart validates artifacts
and resumes the missing step without overwriting an existing source.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

REPO=Path(__file__).resolve().parents[2]

def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as handle:
        for part in iter(lambda:handle.read(1<<20),b''):h.update(part)
    return h.hexdigest()

def plan_one(mapped,*,rank,year,today=None):
    today=today or date.today()
    if (not isinstance(year,int) or year<1950 or year>=today.year or not isinstance(rank,int) or rank<1
        or mapped.get('schemaVersion')!=1 or mapped.get('researchOnly') is not True
        or mapped.get('actualEra5LandCellMappingVerified') is not True
        or not isinstance(mapped.get('rows'),list) or len(mapped['rows'])!=mapped.get('count')
        or not isinstance(mapped.get('sourceMetadataSha256'),dict)
        or any(not isinstance(mapped['sourceMetadataSha256'].get(v),str)
               or len(mapped['sourceMetadataSha256'][v])!=64 for v in ('temperature','pressure'))):
        raise ValueError('Invalid bounded pilot year/cohort; only completed calendar years allowed')
    matches=[r for r in mapped['rows'] if r.get('rank')==rank]
    if len(matches)!=1:raise ValueError('Rank not in frozen cohort')
    row=matches[0]
    cell=row.get('actualEra5LandCell')
    if (not isinstance(cell,list) or len(cell)!=2 or not all(isinstance(v,(int,float)) for v in cell)
        or not isinstance(row.get('requestCoordinate'),list) or len(row['requestCoordinate'])!=2
        or row.get('cellDataVerified') is not False or not isinstance(row.get('tile'),list)
        or len(row['tile'])!=2):
        raise ValueError('Cohort cell is unresolved or lacks a source tile')
    try:ZoneInfo(row['timeZone'])
    except (ZoneInfoNotFoundError,KeyError,TypeError):raise ValueError('Invalid IANA timezone') from None
    return {'rank':rank,'year':year,'path':row['path'],'timeZone':row['timeZone'],
        'requestCoordinate':row['requestCoordinate'],'actualEra5LandCell':cell,
        'cellKey':','.join(f'{v:.1f}' for v in cell),'tile':row['tile'],
        'start':f'{year-1}-12-31' if year>1950 else '1950-01-02',
        'end':f'{year+1}-01-02','researchOnly':True}

def load_neighbor(name):
    source=Path(__file__).with_name(name)
    spec=importlib.util.spec_from_file_location(name.removesuffix('.py'),source)
    assert spec is not None and spec.loader is not None
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def verify_upstream_metadata(expected):
    source=load_neighbor('map_arco_cohort.py')
    rc=Path.home()/'.cdsapirc'
    lines=dict(line.split(': ',1) for line in rc.read_text().splitlines() if ': ' in line)
    token=lines.get('key','')
    if not token:raise ValueError('Private CDS token missing')
    for name,url in [('temperature',source.TEMP_URL),('pressure',source.PRESS_URL)]:
        _,actual=source.metadata(url,token)
        if actual!=expected[name]:raise ValueError('ARCO source metadata changed; pilot mapping requires review')

def write_private(path,obj):
    target=Path(path)
    if target.exists():raise ValueError('Refusing to overwrite private pilot checkpoint')
    target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd,tmp=tempfile.mkstemp(prefix='.pilot-checkpoint-',dir=target.parent)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as handle:
            json.dump(obj,handle,separators=(',',':'),sort_keys=True)
            handle.write('\n')
        os.replace(tmp,target)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def inspect_normalized(directory,plan):
    manifest_path=directory/'manifest.json'
    if not manifest_path.is_file():raise ValueError('Normalized source missing manifest')
    manifest=json.loads(manifest_path.read_text())
    if (manifest.get('researchOnly') is not True or manifest.get('sourceType')!='ARCO-unpinned-research'
        or manifest.get('sourceSelection')!={'start':plan['start'],'end':plan['end']}):
        raise ValueError('Private source does not match selected year')
    from datetime import date
    expected=(date.fromisoformat(plan['end'])-date.fromisoformat(plan['start'])).days*24+24
    if plan['cellKey'] in manifest.get('maskedCells',[]):
        if manifest.get('cells')!=0 or manifest.get('hours')!=0:
            raise ValueError('Masked cell falsely contains hourly source values')
        return manifest,False
    files=manifest.get('files',{})
    if set(files)!={plan['cellKey']} or files[plan['cellKey']]['hours']!=expected:
        raise ValueError('Selected cell is missing/partial or a different cell was exported')
    record=files[plan['cellKey']]
    name=record['file']
    if not isinstance(name,str) or not name.startswith('cell-') or '/' in name or '..' in name:
        raise ValueError('Unsafe private normalized source filename')
    path=directory/name
    if path.stat().st_size!=record['bytes'] or record['bytes']>4_000_000 or digest(path)!=record['sha256']:
        raise ValueError('Private normalized source content checksum or size mismatch')
    return manifest,True

def run_one(mapped,cohort_path,*,rank,year,out):
    plan=plan_one(mapped,rank=rank,year=year)
    base=Path(out).resolve()
    if base==REPO or base.is_relative_to(REPO):
        raise ValueError('Private source and checkpoints must remain outside Git')
    work=base/f'r{rank:02d}-y{year}'
    checkpoint=work/'status.json'
    if checkpoint.exists():
        recorded=json.loads(checkpoint.read_text())
        if recorded.get('plan')!=plan or recorded.get('cohortSha256')!=digest(cohort_path):
            raise ValueError('Existing pilot checkpoint differs from pinned cohort/plan')
        normalized_manifest=work/'normalized'/'manifest.json'
        if (not normalized_manifest.is_file()
            or digest(normalized_manifest)!=recorded.get('normalizedManifestSha256')):
            raise ValueError('Existing normalized source checksum mismatch')
        source_manifest,available=inspect_normalized(work/'normalized',plan)
        if recorded.get('sourceSelectionSha256')!=source_manifest.get('sourceSha256'):
            raise ValueError('Existing normalized selection provenance mismatch')
        if recorded.get('status')=='complete':
            if not available:raise ValueError('Completed checkpoint has a masked source')
            summary=work/'annual.json'
            if not summary.is_file() or digest(summary)!=recorded.get('annualSha256'):
                raise ValueError('Existing annual summary checksum mismatch')
        elif recorded.get('status')=='unavailable-masked':
            if available or (work/'annual.json').exists():
                raise ValueError('A masked source has unexpected hourly/annual data')
        else:
            raise ValueError('Unknown private pilot checkpoint status')
        return recorded
    if shutil.disk_usage(base.parent).free<1_000_000_000:
        raise OSError('Insufficient local storage headroom for bounded source job')
    verify_upstream_metadata(mapped['sourceMetadataSha256'])
    work.mkdir(parents=True,exist_ok=True,mode=0o700)
    normalized=work/'normalized'
    if not normalized.exists():
        code=load_neighbor('extract_arco_tile.py')
        code.extract_tile(latitude=plan['requestCoordinate'][0],longitude=plan['requestCoordinate'][1],
            start=plan['start'],end=plan['end'],out_dir=normalized,only_selected_cell=True)
    manifest,available=inspect_normalized(normalized,plan)
    status={'schemaVersion':1,'plan':plan,'cohortSha256':digest(cohort_path),
        'normalizedManifestSha256':digest(normalized/'manifest.json'),
        'sourceSelectionSha256':manifest['sourceSha256'],'researchOnly':True,
        'status':'unavailable-masked' if not available else 'complete'}
    if available:
        annual=work/'annual.json'
        if not annual.exists():
            node=shutil.which('node')
            if not node:raise OSError('Node.js is required for pinned Romps calculation')
            subprocess.run([node,'--experimental-strip-types',str(Path(__file__).with_name('aggregate-year.mjs')),
                '--normalized',str(normalized),'--cell',plan['cellKey'],'--timezone',plan['timeZone'],
                '--year',str(year),'--out',str(annual)],check=True,cwd=REPO,
                stdout=subprocess.DEVNULL)
        summary=json.loads(annual.read_text())
        if (summary.get('researchOnly') is not True or summary.get('localYear')!=year
            or summary.get('timeZone')!=plan['timeZone'] or summary.get('gridCell')!=plan['actualEra5LandCell']
            or summary.get('sourceArchiveSha256')!=manifest['sourceSha256']):
            raise ValueError('Annual result does not match normalized source or route timezone')
        status['annualSha256']=digest(annual)
        status['completeDays']=summary['coverage']['completeDays']
    write_private(checkpoint,status)
    return status

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--mapped-cohort',required=True,type=Path)
    p.add_argument('--rank',required=True,type=int)
    p.add_argument('--year',required=True,type=int)
    p.add_argument('--out',required=True,type=Path)
    p.add_argument('--execute',action='store_true',help='Run ONE bounded tile/year; without this, dry-run only')
    a=p.parse_args()
    mapped=json.loads(a.mapped_cohort.read_text())
    plan=plan_one(mapped,rank=a.rank,year=a.year)
    if not a.execute:
        print(json.dumps({'dryRun':True,**plan},separators=(',',':')))
    else:
        result=run_one(mapped,a.mapped_cohort,rank=a.rank,year=a.year,out=a.out)
        print(json.dumps({'dryRun':False,'rank':a.rank,'year':a.year,'status':result['status'],
                          'completeDays':result.get('completeDays'),'researchOnly':True},separators=(',',':')))

if __name__=='__main__':main()
