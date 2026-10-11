#!/usr/bin/env python3
"""Single bounded research fetch from Copernicus ERA5-Land; no bulk scheduler.

Use only with a private output directory. A request is limited to one point or at
most four grid cells, one calendar-year of days, and the CDS cost ceiling. If a
job is pending, this exits and prints its id; re-run --resume-job to finish it.
"""
import argparse
import hashlib
import json
import math
import os
import tempfile
import zipfile
from datetime import date
from pathlib import Path

DATASET = 'reanalysis-era5-land-timeseries'
VARIABLES = ['2m_temperature', '2m_dewpoint_temperature', 'surface_pressure']
MAX_DAYS = 367
MAX_BYTES = 25_000_000


def validate_request(*, location=None, area=None, start, end):
    first,last = date.fromisoformat(start),date.fromisoformat(end)
    if first > last or (last-first).days >= MAX_DAYS or first < date(1950,1,2):
        raise ValueError('CDS request must stay inside one year of 1950-or-later hourly data')
    if (location is None) == (area is None):
        raise ValueError('Specify exactly one location or area')
    request = {'variable':VARIABLES[:], 'date':[f'{start}/{end}'],'data_format':'csv'}
    if location is not None:
        if len(location)!=2 or not all(math.isfinite(v) for v in location) or not -90<=location[0]<=90 or not -180<=location[1]<=180:
            raise ValueError('Invalid CDS location')
        request['location']={'latitude':float(location[0]),'longitude':float(location[1])}
    else:
        assert area is not None
        if (len(area)!=4 or not all(isinstance(x,(int,float)) and math.isfinite(x) for x in area)
            or not -90<=area[2]<=area[0]<=90 or not -180<=area[1]<=area[3]<=180
            or area[0]-area[2]>.11 or area[3]-area[1]>.11):
            raise ValueError('CDS area is limited to a 0.1-degree square (at most four cells)')
        request['area']=[float(x) for x in area]
    return request


def download_bounded(client,*,location=None,area=None,start,end,target,resume_job=None):
    request=validate_request(location=location,area=area,start=start,end=end)
    target=Path(target)
    if target.exists():
        raise ValueError('Refusing to overwrite a private source artifact')
    if resume_job:
        remote=client.get_remote(resume_job)
        if remote.collection_id != DATASET or remote.request != request:
            raise ValueError('Resumed job belongs to another dataset or request')
    else:
        cost=client.estimate_costs(DATASET,request)
        if not isinstance(cost,dict) or not isinstance(cost.get('cost'),(float,int)) or not isinstance(cost.get('limit'),(float,int)):
            raise ValueError('Missing CDS cost estimate; refusing submission')
        if cost['cost']>min(500,cost['limit']):
            raise ValueError('CDS request exceeds the bounded cost ceiling')
        remote=client.submit(DATASET,request)
    job_id=remote.request_id
    if remote.status != 'successful':
        if remote.status in ('failed','dismissed'):
            raise RuntimeError(f'CDS research job {job_id} failed')
        return {'jobId':job_id,'status':remote.status}
    result=client.get_results(job_id)
    value=result.json['asset']['value']
    expected=value.get('file:size')
    if not isinstance(expected,int) or expected<1 or expected>MAX_BYTES:
        raise ValueError('CDS result exceeds private bounded download limit')
    target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd,tmp=tempfile.mkstemp(prefix='.cds-',suffix='.zip',dir=target.parent)
    os.close(fd)
    try:
        result.download(tmp)
        downloaded=Path(tmp)
        if downloaded.stat().st_size!=expected or not zipfile.is_zipfile(downloaded):
            raise ValueError('CDS result is incomplete or not a ZIP archive')
        digest=hashlib.sha256(downloaded.read_bytes()).hexdigest()
        downloaded.chmod(0o600)
        os.replace(tmp,target)
        return {'jobId':job_id,'status':'successful','bytes':expected,'sha256':digest}
    finally:
        if os.path.exists(tmp):os.unlink(tmp)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    selected=parser.add_mutually_exclusive_group(required=True)
    selected.add_argument('--point',nargs=2,type=float,metavar=('LAT','LON'))
    selected.add_argument('--area',nargs=4,type=float,metavar=('N','W','S','E'))
    parser.add_argument('--start',required=True)
    parser.add_argument('--end',required=True)
    parser.add_argument('--out',required=True,type=Path)
    parser.add_argument('--resume-job')
    opts=parser.parse_args()
    import cdsapi  # Optional outside a private build virtualenv; no credential passed in argv.
    client=cdsapi.Client(quiet=True).client
    report=download_bounded(client,location=opts.point,area=opts.area,start=opts.start,end=opts.end,
                            target=opts.out,resume_job=opts.resume_job)
    print(json.dumps(report))


if __name__=='__main__':main()
