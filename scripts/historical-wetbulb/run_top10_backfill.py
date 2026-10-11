#!/usr/bin/env python3
"""Resumable, sequential research backfill: first 10 ranked unmasked Top-50 cities.

Explicit fixed calendar-year range; no city substitutions, station sources,
production assets, parallel provider access or implicit retries. Dry-run is the
default. Per-rank/year jobs retain their own checksummed private checkpoints.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import math
import os
import shutil
import signal
import tempfile
import time
from datetime import date,datetime,timezone
from pathlib import Path

REPO=Path(__file__).resolve().parents[2]

def load(name):
    spec=importlib.util.spec_from_file_location(name.removesuffix('.py'),Path(__file__).with_name(name))
    assert spec and spec.loader
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    return mod

def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for part in iter(lambda:f.read(1<<20),b''):h.update(part)
    return h.hexdigest()

def select_ten(mapped,survey_root):
    rows=mapped.get('rows',[])
    if (mapped.get('schemaVersion')!=1 or mapped.get('researchOnly') is not True
        or mapped.get('actualEra5LandCellMappingVerified') is not True
        or mapped.get('count')!=50 or len(rows)!=50
        or any(r.get('rank')!=i for i,r in enumerate(rows,start=1))):
        raise ValueError('Expected frozen metadata-resolved Top-50 cohort')
    classify=load('survey_mask_batch.py').classify
    valid=[];masked=[]
    for row in rows:
        rank=row['rank'];cell=row.get('actualEra5LandCell')
        if not isinstance(cell,list) or len(cell)!=2 or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in cell):
            raise ValueError('Unresolved source cell')
        path=Path(survey_root)/f'r{rank:02d}'/'manifest.json'
        if not path.is_file():raise ValueError('Incomplete Top-50 mask survey')
        status=classify(json.loads(path.read_text()),','.join(f'{v:.1f}' for v in cell))
        (valid if status=='valid' else masked).append(row)
    if len(valid)!=44 or len(masked)!=6 or [r['rank'] for r in masked]!=[1,10,28,30,39,50]:
        raise ValueError('Source mask inventory changed since approved Top-50 research screen')
    return valid[:10]

def plan_jobs(selected,*,start_year,end_year,today=None):
    today=today or date.today()
    if (len(selected)!=10 or len({r['rank'] for r in selected})!=10
        or any(r.get('rank')!=rank for rank,r in zip((2,3,4,5,6,7,8,9,11,12),selected))
        or not isinstance(start_year,int) or not isinstance(end_year,int)
        or start_year!=1950 or end_year<start_year or end_year>=today.year
        or end_year>2025 or 10*(end_year-start_year+1)>760):
        raise ValueError('Unapproved ranks or calendar-year range')
    return [(r['rank'],year) for r in selected for year in range(start_year,end_year+1)]

def coverage_dates(year,first,last):
    start=date.fromisoformat(first);end=date.fromisoformat(last)
    if (start.year!=year or end!=date(year,12,31)
        or (year==1950 and first not in ('1950-01-02','1950-01-03'))
        or (year!=1950 and first!=f'{year}-01-01')):
        raise ValueError('Local year boundary is incomplete')
    return (end-start).days+1

def write_progress(path,report):
    fd,tmp=tempfile.mkstemp(prefix='.top10-progress-',dir=path.parent)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as f:
            json.dump(report,f,separators=(',',':'),sort_keys=True);f.write('\n')
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--mapped-cohort',required=True,type=Path)
    p.add_argument('--survey-root',required=True,type=Path)
    p.add_argument('--out',required=True,type=Path)
    p.add_argument('--start-year',required=True,type=int)
    p.add_argument('--end-year',required=True,type=int)
    p.add_argument('--max-new-jobs',required=True,type=int)
    p.add_argument('--pause-seconds',type=float,default=2.5)
    p.add_argument('--execute',action='store_true')
    a=p.parse_args()
    cohort_path=a.mapped_cohort.resolve();mapped=json.loads(cohort_path.read_text())
    selected=select_ten(mapped,a.survey_root)
    jobs=plan_jobs(selected,start_year=a.start_year,end_year=a.end_year)
    out=a.out.resolve()
    if (out==REPO or out.is_relative_to(REPO) or not isinstance(a.max_new_jobs,int)
        or not 1<=a.max_new_jobs<=len(jobs) or not math.isfinite(a.pause_seconds)
        or not 1<=a.pause_seconds<=60):
        raise ValueError('Invalid private destination, execution limit or provider pacing')
    print(json.dumps({'dryRun':not a.execute,'ranks':[r['rank'] for r in selected],
        'years':[a.start_year,a.end_year],'plannedJobs':len(jobs),'maxNewJobs':a.max_new_jobs,
        'pauseSeconds':a.pause_seconds}),flush=True)
    if not a.execute:return
    out.mkdir(mode=0o700,parents=True,exist_ok=True)
    runner=load('run_pilot_year.py')
    cohort_sha=digest(cohort_path)
    stopped=[False]
    signal.signal(signal.SIGTERM,lambda _signum,_frame:stopped.__setitem__(0,True))
    with (out/'.run-top10.lock').open('a+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        completed=0;new=0;last=None
        progress={'schemaVersion':1,'researchOnly':True,'cohortSha256':cohort_sha,
                  'ranks':[r['rank'] for r in selected],'years':[a.start_year,a.end_year],
                  'plannedJobs':len(jobs),'completedJobs':0,'newJobsThisRun':0,'status':'running'}
        write_progress(out/'progress.json',progress)
        for rank,year in jobs:
            if stopped[0]:break
            work=out/f'r{rank:02d}-y{year}'
            if not (work/'status.json').exists() and new>=a.max_new_jobs:break
            try:
                if not (work/'status.json').exists():
                    if shutil.disk_usage(out).free<10_000_000_000:raise OSError('Backfill stopped: less than 10 GB free')
                    if new:time.sleep(a.pause_seconds)
                    new+=1
                result=runner.run_one(mapped,cohort_path,rank=rank,year=year,out=out)
                if result.get('status')!='complete' or result.get('researchOnly') is not True:
                    raise ValueError('Expected an available research-only cell, never a substitution')
                summary=json.loads((work/'annual.json').read_text())
                coverage=summary['coverage']
                expected=coverage_dates(year,coverage['firstComplete'],coverage['lastComplete'])
                if (result.get('completeDays')!=expected or coverage['completeDays']!=expected
                    or len(summary['daily'])!=expected or (coverage['partialDays'] and
                    any(coverage['firstComplete']<=x['date']<=coverage['lastComplete'] for x in coverage['partialDays']))):
                    raise ValueError(f'Incomplete local-date coverage for rank={rank} year={year}')
            except Exception as error:
                progress.update(status='failed',failedRank=rank,failedYear=year,
                                errorType=type(error).__name__,newJobsThisRun=new,
                                updatedUTC=datetime.now(timezone.utc).isoformat())
                write_progress(out/'progress.json',progress)
                raise
            completed+=1;last=[rank,year]
            progress.update(completedJobs=completed,newJobsThisRun=new,lastCompleted=last,
                            updatedUTC=datetime.now(timezone.utc).isoformat())
            write_progress(out/'progress.json',progress)
            if year==a.end_year or completed%10==0:
                print(json.dumps({'completed':completed,'planned':len(jobs),'rank':rank,
                                  'year':year,'completeDays':expected}),flush=True)
        progress.update(status='complete' if completed==len(jobs) else 'stopped' if stopped[0] else 'bounded',
                        updatedUTC=datetime.now(timezone.utc).isoformat())
        write_progress(out/'progress.json',progress)
        print(json.dumps({k:progress[k] for k in ('status','completedJobs','plannedJobs','newJobsThisRun','lastCompleted')}),flush=True)
        if stopped[0]:raise SystemExit(143)

if __name__=='__main__':main()
