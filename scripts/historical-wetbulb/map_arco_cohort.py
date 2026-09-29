#!/usr/bin/env python3
"""Resolve a frozen Top-50 route cohort to actual ERA5-Land grid cells/tiles.

Reads only authenticated Zarr metadata and coordinate axes; no climate-field
chunks. Output is private, metadata-resolved only and NOT publishable history.
"""
import argparse
import hashlib
import json
import math
import os
import tempfile
import urllib.request
from pathlib import Path

TEMP_URL='https://arco.datastores.ecmwf.int/cadl-arco-geo-007/arco/reanalysis_era5_land/sfc-2m-temperature/geoChunked.zarr'
PRESS_URL='https://arco.datastores.ecmwf.int/cadl-arco-geo-009/arco/reanalysis_era5_land/sfc-pressure-precipitation/geoChunked.zarr'


def nearest(values,target):
    i=min(range(len(values)),key=lambda k:abs(values[k]-target))
    if abs(values[i]-target)>.051:
        raise ValueError('Source cell differs from requested location by more than half grid spacing')
    return i


def map_cohort(cohort,temp_lat,temp_lon,press_lat,press_lon,*,chunk_lat,chunk_lon):
    if (not isinstance(cohort,dict) or cohort.get('schemaVersion')!=1 or not isinstance(cohort.get('rows'),list)
        or len(cohort['rows'])!=cohort.get('count') or cohort['count']<1
        or not all(isinstance(x,int) and x>0 for x in (chunk_lat,chunk_lon))):
        raise ValueError('Invalid frozen cohort or ARCO chunk shape')
    if len(temp_lat)==0 or len(temp_lon)==0 or list(temp_lat)!=list(press_lat) or list(temp_lon)!=list(press_lon):
        raise ValueError('Temperature/dewpoint and pressure grid axes differ')
    rows=[]
    tiles=set()
    cells=set()
    combos=set()
    for pos,record in enumerate(cohort['rows'],start=1):
        if (record.get('rank')!=pos or record.get('actualEra5LandCell') is not None
            or not isinstance(record.get('requestCoordinate'),list) or len(record['requestCoordinate'])!=2):
            raise ValueError('Cohort identity is reordered or was already resolved')
        lat,lon=record['requestCoordinate']
        if not all(isinstance(x,(int,float)) and math.isfinite(x) for x in (lat,lon)):
            raise ValueError('Invalid source coordinate')
        ilat=nearest(temp_lat,lat)
        ilon=nearest(temp_lon,lon)
        cell=[round(float(temp_lat[ilat]),1),round(float(temp_lon[ilon]),1)]
        tile=[ilat//chunk_lat,ilon//chunk_lon]
        if not -90<=cell[0]<=90 or not -180<=cell[1]<=180:
            raise ValueError('Invalid resolved ERA5-Land cell')
        tiles.add(tuple(tile));cells.add(tuple(cell));combos.add((tuple(cell),record['timeZone']))
        rows.append({**record,'actualEra5LandCell':cell,'tile':tile,'sourceGridIndex':[ilat,ilon],
                     'cellDataVerified':False})
    return {**cohort,'rows':rows,'researchOnly':True,'actualEra5LandCellMappingVerified':True,
            'cellDataVerified':False,'tileCount':len(tiles),'cellCount':len(cells),
            'cellTimezoneCount':len(combos),'tileShape':[chunk_lat,chunk_lon]}


def metadata(url,token):
    if url not in (TEMP_URL,PRESS_URL) or not token:
        raise ValueError('Untrusted ARCO metadata origin or missing private token')
    class NoRedirects(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,req,fp,code,msg,headers,newurl):
            raise ValueError('Authenticated ARCO metadata must not redirect')
    req=urllib.request.Request(url+'/.zmetadata',headers={'Authorization':'Bearer '+token})
    opener=urllib.request.build_opener(NoRedirects)
    with opener.open(req,timeout=45) as reply:
        raw=reply.read(250_001)
    if len(raw)>250_000:
        raise ValueError('ARCO metadata exceeds safety bound')
    return json.loads(raw)['metadata'],hashlib.sha256(raw).hexdigest()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cohort',required=True,type=Path)
    p.add_argument('--out',required=True,type=Path)
    a=p.parse_args()
    if a.out.exists():p.error('Refusing to overwrite mapped cohort')
    cohort_raw=a.cohort.read_bytes()
    cohort=json.loads(cohort_raw)
    lines=dict(line.split(': ',1) for line in (Path.home()/'.cdsapirc').read_text().splitlines() if ': ' in line)
    token=lines.get('key','')
    if not token:raise ValueError('Private CDS token missing')
    temp_meta,temp_hash=metadata(TEMP_URL,token)
    press_meta,press_hash=metadata(PRESS_URL,token)
    t_shape=temp_meta['t2m/.zarray']['chunks'];d_shape=temp_meta['d2m/.zarray']['chunks'];p_shape=press_meta['sp/.zarray']['chunks']
    if t_shape!=d_shape or t_shape!=p_shape or len(t_shape)!=3 or t_shape[1]*t_shape[2]>32:
        raise ValueError('ARCO temperature/dewpoint/pressure tile chunk shapes differ')
    import xarray as xr
    import numpy as np
    storage={'headers':{'Authorization':'Bearer '+token}}
    temp=xr.open_zarr(TEMP_URL,consolidated=True,storage_options=storage)
    press=xr.open_zarr(PRESS_URL,consolidated=True,storage_options=storage)
    mapped=map_cohort(cohort,temp.latitude.values,temp.longitude.values,
                      press.latitude.values,press.longitude.values,chunk_lat=t_shape[1],chunk_lon=t_shape[2])
    mapped['sourceMetadataSha256']={'temperature':temp_hash,'pressure':press_hash}
    mapped['cohortSha256']=hashlib.sha256(cohort_raw).hexdigest()
    a.out.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    fd,temp_path=tempfile.mkstemp(prefix='.cohort-',dir=a.out.parent)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as handle:
            json.dump(mapped,handle,separators=(',',':'))
            handle.write('\n')
        os.replace(temp_path,a.out)
    finally:
        if os.path.exists(temp_path):os.unlink(temp_path)
    print(json.dumps({'rankedRoutes':mapped['count'],'actualCells':mapped['cellCount'],
                      'cellTimezones':mapped['cellTimezoneCount'],'tiles':mapped['tileCount'],
                      'cellDataVerified':False}))

if __name__=='__main__':main()
