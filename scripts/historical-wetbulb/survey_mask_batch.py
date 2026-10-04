#!/usr/bin/env python3
"""Sequential one-time Top-50 ERA5-Land land-mask survey in batches of ≤10.

Research only, fixed two-day 1950 period. No public assets, no weather-station
mixing, no automatic coastal substitution. Each selected cell writes an atomic
private source manifest, and reruns verify prior results instead of redownloading.
"""
import argparse
import importlib.util
import json
import math
import time
from pathlib import Path

START,END='1950-02-28','1950-03-01'
REPO=Path(__file__).resolve().parents[2]


def plan_batch(rows,*,from_rank,count):
    if (not isinstance(rows,list) or len(rows)!=50 or not isinstance(from_rank,int) or
        not isinstance(count,int) or from_rank<1 or count<1 or count>10 or from_rank+count-1>50):
        raise ValueError('Survey is limited to ten ranked rows per invocation')
    if any(row.get('rank')!=i for i,row in enumerate(rows,start=1)):
        raise ValueError('Frozen Top-50 rank inventory changed')
    return rows[from_rank-1:from_rank+count-1]


def classify(manifest,cell):
    selection=manifest.get('sourceSelection')
    if (manifest.get('schemaVersion')!=1 or manifest.get('researchOnly') is not True
        or selection!={'start':START,'end':END} or not isinstance(manifest.get('files'),dict)
        or not isinstance(manifest.get('maskedCells'),list)):
        raise ValueError('Untrusted source selection')
    files=manifest['files'];masked=manifest['maskedCells']
    if (set(files)=={cell} and not masked and manifest.get('hours')==48 and
        manifest.get('cells')==1 and files[cell].get('hours')==48):
        return 'valid'
    if (not files and masked==[cell] and manifest.get('hours')==0 and manifest.get('cells')==0):
        return 'masked'
    raise ValueError('Mixed, partial, or unexpected ARCO source cell')


def extractor():
    path=Path(__file__).with_name('extract_arco_tile.py')
    spec=importlib.util.spec_from_file_location('historical_arco_extractor',path)
    assert spec and spec.loader
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.extract_tile


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cohort',required=True,type=Path)
    p.add_argument('--out',required=True,type=Path)
    p.add_argument('--from-rank',required=True,type=int)
    p.add_argument('--count',required=True,type=int)
    p.add_argument('--execute',action='store_true',help='Fetch at most ten two-day cells sequentially')
    opts=p.parse_args()
    mapped=json.loads(opts.cohort.read_text())
    if (mapped.get('schemaVersion')!=1 or mapped.get('researchOnly') is not True
        or mapped.get('actualEra5LandCellMappingVerified') is not True):
        raise ValueError('Frozen ERA5-Land cohort not metadata-verified')
    selected=plan_batch(mapped['rows'],from_rank=opts.from_rank,count=opts.count)
    base=opts.out.resolve()
    if base==REPO or base.is_relative_to(REPO):raise ValueError('Raw provider data must remain outside Git')
    if not opts.execute:
        print(json.dumps({'dryRun':True,'ranks':[row['rank'] for row in selected],
                         'from':START,'to':END,'maxNewRequests':len(selected)}))
        return
    base.mkdir(mode=0o700,parents=True,exist_ok=True)
    extract=extractor()
    statuses=[];new_requests=0
    for row in selected:
        rank=row['rank'];lat,lon=row['requestCoordinate']
        cell=row['actualEra5LandCell']
        if not isinstance(cell,list) or len(cell)!=2 or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in cell):
            raise ValueError('Unresolved ERA5-Land source cell')
        key=','.join(f'{v:.1f}' for v in cell)
        dest=base/f'r{rank:02d}'
        if not dest.exists():
            if new_requests:time.sleep(2)
            extract(latitude=lat,longitude=lon,start=START,end=END,out_dir=dest,only_selected_cell=True)
            new_requests+=1
        manifest=json.loads((dest/'manifest.json').read_text())
        status=classify(manifest,key)
        if status=='valid':
            record=manifest['files'][key]
            path=dest/record['file']
            import hashlib
            if path.stat().st_size!=record['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest()!=record['sha256']:
                raise ValueError('Existing source content checksum mismatch')
        statuses.append({'rank':rank,'status':status,'cell':cell,'sourceSelectionSha256':manifest.get('sourceSha256')})
        print(json.dumps(statuses[-1]),flush=True)
    print(json.dumps({'batch':len(statuses),'valid':sum(r['status']=='valid' for r in statuses),
                      'masked':sum(r['status']=='masked' for r in statuses),'newRequests':new_requests}))

if __name__=='__main__':main()
