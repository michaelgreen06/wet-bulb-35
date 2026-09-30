#!/usr/bin/env python3
"""Offline same-country/same-landmass review of a masked ERA5-Land cell.

Uses pinned Natural Earth 1:10m public-domain polygons. A positive result is a
candidate for manual review, NOT a published city-grid override. Any missing
polygon, island mismatch, border crossing, or distance >15 km rejects it.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import math
import os
import tempfile
import zipfile
from pathlib import Path

ADMIN_SHA256='ce1ac7036499a0edd641fbc093cd209a98f96a49d2eca8480aaacad35138a7f6'
LAND_SHA256='e547d749445eaa0964aba76738090ec88f5e63c4585122170f98c67a7ea922dc'


def distance_km(lat1,lon1,lat2,lon2):
    a,b=math.radians(lat1),math.radians(lat2)
    v=math.sin((b-a)/2)**2+math.cos(a)*math.cos(b)*math.sin(math.radians(lon2-lon1)/2)**2
    return 12742.0176*math.asin(min(1,math.sqrt(v)))


def component_for(features,lon,lat,contains):
    matches=[]
    for label,identifier,geometry in features:
        if contains(geometry,lon,lat):matches.append((label,identifier,geometry))
    return matches[0] if len(matches)==1 else None


def review_landmass(city,report,admin_features,land_features,*,contains,connects,max_km=15):
    if (not isinstance(max_km,(int,float)) or not 0<max_km<=15
        or report.get('rank')!=city.get('rank') or report.get('path')!=city.get('path')
        or report.get('status')!='review-required' or report.get('publishedCell') is not None
        or report.get('requestedCell')!=city.get('actualEra5LandCell')
        or not isinstance(report.get('nearestValidCell'),list)
        or len(report['nearestValidCell'])!=2):
        raise ValueError('Invalid or already published coastal cell proposal')
    source=city.get('requestCoordinate');candidate=report['nearestValidCell']
    if not isinstance(source,list) or len(source)!=2 or not all(math.isfinite(v) for v in source+candidate):
        raise ValueError('Invalid city/candidate coordinates')
    distance=distance_km(*source,*candidate)
    if (not math.isfinite(distance) or not isinstance(report.get('distanceKm'),(int,float))
        or abs(distance-report['distanceKm'])>.25):
        raise ValueError('Candidate distance does not match source coordinate')
    original_admin=component_for(admin_features,source[1],source[0],contains)
    candidate_admin=component_for(admin_features,candidate[1],candidate[0],contains)
    original_land=component_for(land_features,source[1],source[0],contains)
    candidate_land=component_for(land_features,candidate[1],candidate[0],contains)
    same_country=(original_admin is not None and candidate_admin is not None
        and original_admin[:2]==candidate_admin[:2])
    same_land=(original_land is not None and candidate_land is not None
        and original_land[:2]==candidate_land[:2])
    start=(source[1],source[0]);end=(candidate[1],candidate[0])
    direct_land_path=False
    if same_country and same_land and original_admin is not None and original_land is not None:
        direct_land_path=(connects(original_admin[2],start,end)
            and connects(original_land[2],start,end))
    allowed=distance<=max_km and direct_land_path
    return {'rank':city['rank'],'path':city['path'],'status':'eligible-for-manual-review' if allowed else 'rejected',
        'requestedCell':city['actualEra5LandCell'],'candidateCell':candidate,'distanceKm':round(distance,2),
        'country':original_admin[0] if allowed else None,'countryComponent':original_admin[1] if allowed else None,
        'landComponent':original_land[1] if allowed else None,'publishedCell':None,
        'maxDistanceKm':max_km,'landmassRule':'same pinned 10m country AND land polygon components; straight line stays inside both'}


def sha256(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1<<20),b''):h.update(block)
    return h.hexdigest()


def features_for(archive,base,*,admin,points):
    import shapefile
    from shapely.geometry import shape
    with zipfile.ZipFile(archive) as z:
        expected=[base+ext for ext in ('.shp','.shx','.dbf')]
        if not all(x in z.namelist() for x in expected):raise ValueError('Pinned Natural Earth archive schema changed')
        reader=shapefile.Reader(shp=io.BytesIO(z.read(expected[0])),
            shx=io.BytesIO(z.read(expected[1])),dbf=io.BytesIO(z.read(expected[2])))
        selected=[]
        for i,record in enumerate(reader.iterShapeRecords()):
            bbox=record.shape.bbox
            if not any(bbox[0]<=lon<=bbox[2] and bbox[1]<=lat<=bbox[3] for lon,lat in points):continue
            geo=shape(record.shape.__geo_interface__)
            if geo.geom_type not in ('Polygon','MultiPolygon') or not geo.is_valid:
                raise ValueError('Pinned land geometry is malformed')
            parts=list(geo.geoms) if geo.geom_type=='MultiPolygon' else [geo]
            values=record.record.as_dict() if admin else {}
            for j,polygon in enumerate(parts):
                selected.append((values.get('ADMIN','land'),f'{values.get("ADM0_A3","land")}:{i}:{j}',polygon))
        return selected


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for key in ('cohort','tile-manifest','admin-zip','land-zip','out'):
        p.add_argument('--'+key,required=True,type=Path)
    p.add_argument('--origin-manifest',type=Path,help='Mask proof when the candidate is in another tile')
    p.add_argument('--rank',required=True,type=int)
    a=p.parse_args()
    if a.out.exists():p.error('Refusing to overwrite private landmass review')
    if sha256(a.admin_zip)!=ADMIN_SHA256 or sha256(a.land_zip)!=LAND_SHA256:
        raise ValueError('Natural Earth source archive checksum differs from pinned public release')
    mapped=json.loads(a.cohort.read_text());matches=[x for x in mapped['rows'] if x['rank']==a.rank]
    if not mapped.get('researchOnly') or len(matches)!=1:raise ValueError('Invalid mapped private cohort rank')
    city=matches[0]
    spec=importlib.util.spec_from_file_location('masked',Path(__file__).with_name('review_masked_cells.py'))
    assert spec and spec.loader
    masked=importlib.util.module_from_spec(spec);spec.loader.exec_module(masked)
    origin=json.loads(a.origin_manifest.read_text()) if a.origin_manifest else None
    report=masked.candidate_report(city,json.loads(a.tile_manifest.read_text()),origin_manifest=origin)
    if report['status']!='review-required':raise ValueError('No nearby sampled candidate for landmass review')
    candidate=report['nearestValidCell'];start=city['requestCoordinate']
    points=[(start[1],start[0]),(candidate[1],candidate[0])]
    admin=features_for(a.admin_zip,'ne_10m_admin_0_countries',admin=True,points=points)
    land=features_for(a.land_zip,'ne_10m_land',admin=False,points=points)
    from shapely.geometry import Point,LineString
    result=review_landmass(city,report,admin,land,
        contains=lambda g,x,y:g.covers(Point(x,y)),
        connects=lambda g,start,end:g.covers(LineString([start,end])))
    result.update(adminSourceSha256=ADMIN_SHA256,landSourceSha256=LAND_SHA256,
                  cohortSha256=sha256(a.cohort),tileManifestSha256=sha256(a.tile_manifest),
                  originManifestSha256=sha256(a.origin_manifest) if a.origin_manifest else sha256(a.tile_manifest),
                  researchOnly=True)
    a.out.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd,tmp=tempfile.mkstemp(prefix='.landmass-review-',dir=a.out.parent)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as f:json.dump(result,f,separators=(',',':'));f.write('\n')
        os.replace(tmp,a.out)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)
    print(json.dumps({k:result[k] for k in ('rank','status','candidateCell','distanceKm','country','landComponent','publishedCell')}))

if __name__=='__main__':main()
