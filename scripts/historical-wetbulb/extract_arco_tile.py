#!/usr/bin/env python3
"""Bounded research-only ARCO ERA5-Land geo-chunk extraction (≤4×8 cells × one year).

No global scan, no public publication, no credentials on argv. Normalized output
is private and flagged researchOnly: source Zarr chunks are not yet pinned.
"""
import argparse
import hashlib
import json
import math
import os
import re
import shutil
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path

TEMPERATURE_URL = 'https://arco.datastores.ecmwf.int/cadl-arco-geo-007/arco/reanalysis_era5_land/sfc-2m-temperature/geoChunked.zarr'
PRESSURE_URL = 'https://arco.datastores.ecmwf.int/cadl-arco-geo-009/arco/reanalysis_era5_land/sfc-pressure-precipitation/geoChunked.zarr'
DATASET = 'reanalysis-era5-land-timeseries'
UTC_HOUR = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$')


def align_tile_hours(times, cells, temperature, dewpoint, pressure, *, pressure_times=None):
    if not times or len(times)>8784 or len(cells)<1 or len(cells)>32 or len(set(cells))!=len(cells):
        raise ValueError('ARCO time/cell bounds or identity invalid')
    if pressure_times is not None and list(times)!=list(pressure_times):
        raise ValueError('ARCO pressure UTC axis differs from temperature/dew point')
    if not all(len(array)==len(times) for array in (temperature,dewpoint,pressure)):
        raise ValueError('ARCO fields have inconsistent UTC rows')
    rows={f'{lat:.1f},{lon:.1f}':[] for lat,lon in cells}
    previous=None
    for i,stamp in enumerate(times):
        if not isinstance(stamp,str) or not UTC_HOUR.fullmatch(stamp):
            raise ValueError('ARCO timestamp is not a whole UTC hour')
        second=datetime.fromisoformat(stamp.replace('Z','+00:00')).timestamp()
        if previous is not None and second!=previous+3600:
            raise ValueError('ARCO UTC hours are missing, duplicated or unsorted')
        previous=second
        if any(len(array[i])!=len(cells) for array in (temperature,dewpoint,pressure)):
            raise ValueError('ARCO geographic axes differ')
        for j,(lat,lon) in enumerate(cells):
            values=(temperature[i][j],dewpoint[i][j],pressure[i][j])
            def valid(v):return isinstance(v,(float,int)) and math.isfinite(v)
            if not all(map(valid,values)):
                # A cell unavailable for the entire requested period is explicit
                # no-data; only a partial time series blocks the whole tile.
                rows[f'{lat:.1f},{lon:.1f}'].append(None)
                continue
            t,d,p=values
            if not (150<=t<=350 and 150<=d<=350 and 10000<=p<=110000):
                raise ValueError('ARCO ERA5-Land thermodynamic range invalid')
            rows[f'{lat:.1f},{lon:.1f}'].append({'timeUTC':stamp,'temperatureK':float(t),
                'dewpointK':float(d),'pressurePa':float(p),'gridCell':[lat,lon]})
    masked=[]
    for key,records in list(rows.items()):
        if all(row is None for row in records):
            masked.append(key);del rows[key]
        elif any(row is None for row in records):
            raise ValueError('ARCO cell has partial hourly coverage')
    return rows,sorted(masked)


def extract_tile(*,latitude,longitude,start,end,out_dir):
    first,last=date.fromisoformat(start),date.fromisoformat(end)
    if first<date(1950,1,2) or first>last or (last-first).days>=367:
        raise ValueError('ARCO research request exceeds a year or predates January 2, 1950')
    if not math.isfinite(latitude) or not math.isfinite(longitude) or not -90<=latitude<=90 or not -180<=longitude<=180:
        raise ValueError('Invalid requested ARCO grid point')
    out_dir=Path(out_dir)
    if out_dir.exists():raise ValueError('Refusing to overwrite existing private output')
    out_dir.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    lines=dict(line.split(': ',1) for line in (Path.home()/'.cdsapirc').read_text().splitlines() if ': ' in line)
    token=lines.get('key','')
    if not token:raise ValueError('Private CDS API token missing')
    import numpy as np  # Optional research environment only
    import xarray as xr
    storage={'headers':{'Authorization':'Bearer '+token}}
    temp=xr.open_zarr(TEMPERATURE_URL,consolidated=True,storage_options=storage)
    press=xr.open_zarr(PRESSURE_URL,consolidated=True,storage_options=storage)
    li=int(np.argmin(np.abs(temp.latitude.values-latitude)))
    lj=int(np.argmin(np.abs(temp.longitude.values-longitude)))
    if abs(float(temp.latitude.values[li])-latitude)>.051 or abs(float(temp.longitude.values[lj])-longitude)>.051:
        raise ValueError('Requested coordinate differs from nearest 0.1-degree grid cell')
    ilat=slice((li//4)*4,min((li//4)*4+4,len(temp.latitude)))
    ilon=slice((lj//8)*8,min((lj//8)*8+8,len(temp.longitude)))
    select={'latitude':ilat,'longitude':ilon}
    t=temp.isel(**select).sel(time=slice(start,end))[['t2m','d2m']].compute()
    p=press.isel(**select).sel(time=slice(start,end))[['sp']].compute()
    if not np.array_equal(t.latitude.values,p.latitude.values) or not np.array_equal(t.longitude.values,p.longitude.values):
        raise ValueError('ARCO field-group grid identity mismatch')
    times=[np.datetime_as_string(x,unit='s')+'.000Z' for x in t.time.values]
    other=[np.datetime_as_string(x,unit='s')+'.000Z' for x in p.time.values]
    cells=[(round(float(lat),1),round(float(lon),1)) for lat in t.latitude.values for lon in t.longitude.values]
    def field(a):return [[None if not math.isfinite(float(x)) else float(x) for x in row]
                         for row in a.values.reshape(len(times),-1)]
    rows,masked=align_tile_hours(times,cells,field(t.t2m),field(t.d2m),field(p.sp),pressure_times=other)
    stage=Path(tempfile.mkdtemp(prefix='.arco-normalize-',dir=out_dir.parent))
    try:
        manifest={'schemaVersion':1,'dataset':DATASET,'sourceType':'ARCO-unpinned-research',
                  'researchOnly':True,'hours':sum(len(x) for x in rows.values()),
                  'cells':len(rows),'maskedCells':masked,'sourceSelection':{'start':start,'end':end},'files':{}}
        digest=hashlib.sha256()
        for key,records in sorted(rows.items()):
            filename='cell-'+hashlib.sha256(key.encode()).hexdigest()[:20]+'.ndjson'
            content=''.join(json.dumps(row,separators=(',',':'))+'\n' for row in records).encode()
            digest.update(key.encode()+b'\0'+content)
            (stage/filename).write_bytes(content)
            manifest['files'][key]={'file':filename,'sha256':hashlib.sha256(content).hexdigest(),
                                    'bytes':len(content),'hours':len(records)}
        manifest['sourceSha256']=digest.hexdigest()  # hash of decoded selection, not pinned upstream chunks
        (stage/'manifest.json').write_text(json.dumps(manifest,separators=(',',':'),sort_keys=True)+'\n')
        os.chmod(stage,0o700)
        for item in stage.iterdir():item.chmod(0o600)
        os.replace(stage,out_dir)
        return {'cells':len(rows),'maskedCells':len(masked),'hours':manifest['hours'],
                'researchOnly':True,'selectionSha256':manifest['sourceSha256']}
    except Exception:
        shutil.rmtree(stage,ignore_errors=True)
        raise


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--latitude',type=float,required=True)
    parser.add_argument('--longitude',type=float,required=True)
    parser.add_argument('--start',required=True)
    parser.add_argument('--end',required=True)
    parser.add_argument('--out',type=Path,required=True)
    a=parser.parse_args()
    print(json.dumps(extract_tile(latitude=a.latitude,longitude=a.longitude,start=a.start,end=a.end,out_dir=a.out)))

if __name__=='__main__':main()
