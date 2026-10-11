#!/usr/bin/env node
/** Audit and merge one research-only cell's complete annual backfill. No provider calls. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mergeHistoricalYears } from '../../lib/historical-wetbulb/merge.mjs';
import { createHistoricalShard } from '../../lib/historical-wetbulb/assets.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const DAY=/^\d{4}-\d{2}-\d{2}$/;
function sameCell(a,b){return Array.isArray(a)&&Array.isArray(b)&&a.length===2&&b.length===2&&a.every((v,i)=>v===b[i]);}

export function loadVerifiedAnnuals({cohortFile,jobsRoot,rank,startYear,endYear}){
 const cohortRaw=fs.readFileSync(cohortFile);const cohort=JSON.parse(cohortRaw);
 const rows=cohort.rows.filter(x=>x.rank===rank);
 if(rows.length!==1||!Number.isInteger(rank)||rank<1||!Number.isInteger(startYear)||!Number.isInteger(endYear)
   ||startYear<1950||endYear<startYear||endYear>2025)throw new TypeError('Unapproved rank or year range');
 const city=rows[0],summaries=[],annualDigests=[];
 for(let year=startYear;year<=endYear;year++){
  const folder=path.join(jobsRoot,`r${String(rank).padStart(2,'0')}-y${year}`);
  const checkpoint=read(path.join(folder,'status.json'));
  const annualPath=path.join(folder,'annual.json');const annualBytes=fs.readFileSync(annualPath);
  if(checkpoint.status!=='complete'||checkpoint.researchOnly!==true
    ||checkpoint.cohortSha256!==sha(cohortRaw)||checkpoint.annualSha256!==sha(annualBytes)
    ||checkpoint.plan.rank!==rank||checkpoint.plan.year!==year||checkpoint.plan.path!==city.path
    ||checkpoint.plan.timeZone!==city.timeZone||!sameCell(checkpoint.plan.actualEra5LandCell,city.actualEra5LandCell)){
   throw new Error(`Private annual checkpoint checksum or identity mismatch for year ${year}`);
  }
  const summary=JSON.parse(annualBytes);
  if(summary.localYear!==year||summary.researchOnly!==true||summary.timeZone!==city.timeZone
    ||!sameCell(summary.gridCell,city.actualEra5LandCell)
    ||summary.sourceArchiveSha256!==checkpoint.sourceSelectionSha256){
   throw new Error(`Private annual data disagrees with checkpoint for year ${year}`);
  }
  summaries.push(summary);annualDigests.push({year,sha256:sha(annualBytes)});
 }
 return {city,summaries,annualDigests,cohortSha256:sha(cohortRaw)};
}

export function validateCompletePeriod(summary,startYear,endYear){
 const c=summary?.coverage;const first=c?.firstComplete,last=c?.lastComplete;
 if(summary?.schemaVersion!==1||summary.researchOnly!==true||summary.startYear!==startYear
   ||summary.endYear!==endYear||!Array.isArray(c?.years)||c.years.length!==endYear-startYear+1
   ||c.years.some((y,i)=>y!==startYear+i)||!DAY.test(first||'')||!DAY.test(last||'')
   ||last!==`${endYear}-12-31`
   ||(startYear===1950?!['1950-01-02','1950-01-03'].includes(first):first!==`${startYear}-01-01`)){
  throw new TypeError('Research range omits a calendar boundary');
 }
 const expected=(Date.parse(`${last}T00:00:00Z`)-Date.parse(`${first}T00:00:00Z`))/86_400_000+1;
 if(!Number.isSafeInteger(expected)||c.completeDays!==expected
   ||!Array.isArray(c.partialDays)||c.partialDays.some(x=>x?.date>=first&&x.date<=last)
   ||!summary.periodHigh||Object.keys(summary.monthly||{}).length!==12
   ||Object.keys(summary.daily||{}).length!==366){
  throw new TypeError('Research range has missing local dates, months or calendar-day keys');
 }
 return expected;
}

function args(argv){
 const flags=new Map();
 for(let i=0;i<argv.length;i++){
  if(argv[i]==='--execute'){if(flags.has('--execute'))throw Error('duplicate --execute');flags.set('--execute',true);continue;}
  if(!argv[i]?.startsWith('--')||flags.has(argv[i])||argv[i+1]===undefined)throw Error('Expected unique --key value arguments');
  flags.set(argv[i],argv[++i]);
 }
 for(const key of ['--mapped-cohort','--jobs','--rank','--start-year','--end-year','--out'])if(!flags.get(key))throw Error(`Missing ${key}`);
 return flags;
}
function main(){
 const a=args(process.argv.slice(2));const cohortFile=path.resolve(a.get('--mapped-cohort'));
 const jobsRoot=path.resolve(a.get('--jobs')),out=path.resolve(a.get('--out'));
 if(out===ROOT||out.startsWith(ROOT+path.sep))throw Error('Research assets must remain private');
 const rank=Number(a.get('--rank')),startYear=Number(a.get('--start-year')),endYear=Number(a.get('--end-year'));
 const target=path.join(out,`r${String(rank).padStart(2,'0')}-y${startYear}-${endYear}`);
 console.log(JSON.stringify({dryRun:!a.get('--execute'),rank,startYear,endYear,target}));
 if(!a.get('--execute'))return;
 if(fs.existsSync(target))throw Error('Refusing to overwrite a private research period');
 const {city,summaries,annualDigests,cohortSha256}=loadVerifiedAnnuals({cohortFile,jobsRoot,rank,startYear,endYear});
 const summary=mergeHistoricalYears(summaries,{startYear,endYear});
 const completeDays=validateCompletePeriod(summary,startYear,endYear);
 const shard=createHistoricalShard([summary],{allowPartialResearch:true,maxBytes:4*1024*1024});
 fs.mkdirSync(out,{recursive:true,mode:0o700});
 const stage=fs.mkdtempSync(path.join(out,'.historical-research-'));
 try{
  fs.chmodSync(stage,0o700);
  const period=Buffer.from(JSON.stringify({path:city.path,geoNamesId:city.geoNamesId,...summary})+'\n');
  const researchAsset=Buffer.from(shard.contents+'\n');
  fs.writeFileSync(path.join(stage,'period.json'),period,{mode:0o600,flag:'wx'});
  fs.writeFileSync(path.join(stage,'research-shard.json'),researchAsset,{mode:0o600,flag:'wx'});
  const manifest={schemaVersion:1,researchOnly:true,rank,path:city.path,geoNamesId:city.geoNamesId,
     timeZone:city.timeZone,gridCell:city.actualEra5LandCell,cohortSha256,startYear,endYear,
     completeDays,annualDigests,periodSha256:sha(period),researchShardSha256:sha(researchAsset),
     researchAssetBytes:researchAsset.length,periodHigh:summary.periodHigh};
  fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify(manifest)+'\n',{mode:0o600,flag:'wx'});
  fs.renameSync(stage,target);
  console.log(JSON.stringify({rank,status:'research-only',completeDays,calendarDays:Object.keys(summary.daily).length,
       researchAssetBytes:researchAsset.length,periodHigh:summary.periodHigh}));
 }finally{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url)))main();
