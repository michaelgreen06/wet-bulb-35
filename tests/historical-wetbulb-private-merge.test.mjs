import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateCompletePeriod, loadVerifiedAnnuals } from '../scripts/historical-wetbulb/merge-private-years.mjs';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');

test('research period requires all complete local dates and 366 calendar-day keys',()=>{
 const ok={schemaVersion:1,source:'ERA5-Land hourly time series',researchOnly:true,
  startYear:1950,endYear:1952,daily:Object.fromEntries(Array.from({length:366},(_,i)=>[new Date(Date.UTC(2000,0,i+1)).toISOString().slice(5,10),{}])),
  monthly:Object.fromEntries(Array.from({length:12},(_,i)=>[String(i+1).padStart(2,'0'),{}])),
  periodHigh:{valueC:28},coverage:{years:[1950,1951,1952],firstComplete:'1950-01-03',lastComplete:'1952-12-31',
   completeDays:1094,partialDays:[{date:'1950-01-02'}]}};
 assert.doesNotThrow(()=>validateCompletePeriod(ok,1950,1952));
 assert.throws(()=>validateCompletePeriod({...ok,coverage:{...ok.coverage,completeDays:1093}},1950,1952));
 assert.throws(()=>validateCompletePeriod({...ok,coverage:{...ok.coverage,partialDays:[{date:'1950-06-01'}]}},1950,1952));
 assert.throws(()=>validateCompletePeriod({...ok,daily:{}},1950,1952));
 assert.throws(()=>validateCompletePeriod({...ok,researchOnly:false},1950,1952));
});

test('private annual loader validates checkpoint cohort, plan and bytes',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wb35-private-merge-test-'));
 try {
  const cohortRaw=JSON.stringify({rows:[{rank:2,path:'/city/',timeZone:'Asia/Jakarta',actualEra5LandCell:[-6.2,106.8]}]});
  const cohortFile=path.join(tmp,'cohort.json');fs.writeFileSync(cohortFile,cohortRaw);
  const work=path.join(tmp,'r02-y1950');fs.mkdirSync(work);
  const annual={schemaVersion:1,localYear:1950,source:'ERA5-Land hourly time series',researchOnly:true,
      timeZone:'Asia/Jakarta',gridCell:[-6.2,106.8],sourceArchiveSha256:'a'.repeat(64)};
  const bytes=JSON.stringify(annual);fs.writeFileSync(path.join(work,'annual.json'),bytes);
  const checkpoint={status:'complete',researchOnly:true,cohortSha256:sha(cohortRaw),annualSha256:sha(bytes),
      sourceSelectionSha256:'a'.repeat(64),plan:{rank:2,year:1950,path:'/city/',timeZone:'Asia/Jakarta',actualEra5LandCell:[-6.2,106.8]}};
  fs.writeFileSync(path.join(work,'status.json'),JSON.stringify(checkpoint));
  const loaded=loadVerifiedAnnuals({cohortFile,jobsRoot:tmp,rank:2,startYear:1950,endYear:1950});
  assert.equal(loaded.summaries.length,1);
  fs.writeFileSync(path.join(work,'annual.json'),bytes+' ');
  assert.throws(()=>loadVerifiedAnnuals({cohortFile,jobsRoot:tmp,rank:2,startYear:1950,endYear:1950}),/checksum/);
 } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});
