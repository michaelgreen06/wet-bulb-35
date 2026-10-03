#!/usr/bin/env python3
"""Private candidate report for a masked Top-50 ERA5-Land coastal/island cell.

Never changes the canonical route or picks a substitute climate cell for
publication. Nearby land-cell values require explicit quality review.
"""
import argparse
import json
import math
from pathlib import Path


def distance_km(lat1,lon1,lat2,lon2):
    a,b=math.radians(lat1),math.radians(lat2)
    delta_lon=math.radians(lon2-lon1)
    v=math.sin((b-a)/2)**2+math.cos(a)*math.cos(b)*math.sin(delta_lon/2)**2
    return 12742.0176*math.asin(min(1,math.sqrt(v)))


def candidate_report(city,manifest,*,max_km=15,origin_manifest=None):
    origin=origin_manifest if origin_manifest is not None else manifest
    if (not isinstance(max_km,(float,int)) or not math.isfinite(max_km) or max_km<=0 or max_km>30
        or manifest.get('schemaVersion')!=1 or manifest.get('researchOnly') is not True
        or origin.get('schemaVersion')!=1 or origin.get('researchOnly') is not True
        or manifest.get('sourceSelection')!=origin.get('sourceSelection')
        or not isinstance(manifest.get('files'),dict)
        or not isinstance(city.get('actualEra5LandCell'),list)
        or not isinstance(city.get('requestCoordinate'),list)
        or len(city['requestCoordinate'])!=2 or len(city['actualEra5LandCell'])!=2):
        raise ValueError('Invalid private masked-cell review input')
    target=','.join(f'{x:.1f}' for x in city['actualEra5LandCell'])
    if target not in origin.get('maskedCells',[]):
        raise ValueError('Requested source cell is not explicitly masked')
    selection=manifest.get('sourceSelection',{})
    start,end=selection.get('start',''),selection.get('end','')
    if start==end or not start or not end or start>end:
        raise ValueError('Missing temporal source sample')
    from datetime import date
    expected=(date.fromisoformat(end)-date.fromisoformat(start)).days*24+24
    candidates=[]
    lat,lon=city['requestCoordinate']
    for key,record in manifest['files'].items():
        if not isinstance(record,dict) or record.get('hours')!=expected:
            raise ValueError('Short land-cell sample cannot establish a candidate')
        coords=list(map(float,key.split(',')))
        if len(coords)!=2 or not all(math.isfinite(x) for x in coords):
            raise ValueError('Invalid source cell')
        candidates.append((distance_km(lat,lon,*coords),coords))
    near=sorted(candidates,key=lambda pair:(pair[0],pair[1]))
    nearest=near[0] if near and near[0][0]<=max_km else None
    return {'rank':city.get('rank'),'path':city.get('path'),'status':'review-required' if nearest else 'unavailable',
        'requestedCell':city['actualEra5LandCell'],'nearestValidCell':nearest[1] if nearest else None,
        'distanceKm':round(nearest[0],2) if nearest else None,
        'publishedCell':None,'sampleWindow':selection,'maxCandidateDistanceKm':max_km,
        'evidence':'Nearest valid cell within the inspected 2-day source tile only; adjacent tiles, full-period mask and landmass require review'}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cohort',required=True,type=Path)
    parser.add_argument('--rank',required=True,type=int)
    parser.add_argument('--tile-manifest',required=True,type=Path)
    parser.add_argument('--origin-manifest',type=Path,help='Required when candidate tile differs from the masked origin tile')
    parser.add_argument('--max-km',type=float,default=15)
    opts=parser.parse_args()
    cohort=json.loads(opts.cohort.read_text())
    matches=[row for row in cohort['rows'] if row['rank']==opts.rank]
    if len(matches)!=1 or not cohort.get('researchOnly'):
        parser.error('Missing or unverified research cohort rank')
    origin=json.loads(opts.origin_manifest.read_text()) if opts.origin_manifest else None
    report=candidate_report(matches[0],json.loads(opts.tile_manifest.read_text()),
        max_km=opts.max_km,origin_manifest=origin)
    print(json.dumps(report,separators=(',',':')))

if __name__=='__main__':main()
