#!/usr/bin/env node
/** Freeze a ranked historical research cohort from existing canonical city routes. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const placePath=row=>`/wetbulb-temperature/${row.countrySlug}/${row.stateSlug}/${row.outputCitySlug}/`;

export function buildHistoricalCohort({inventory,route,identities,ranking,count=50}){
 if(!Number.isSafeInteger(count)||count<1||!Array.isArray(inventory)||!Array.isArray(route?.rows)
   ||!Array.isArray(identities?.rows)||identities.schemaVersion!==1
   ||!Array.isArray(ranking?.cities)||!/^([0-9a-f]{64})$/.test(identities.sourceSha256)
   ||route.rows.length!==inventory.length||identities.rows.length!==inventory.length
   ||identities.inventoryRows!==inventory.length) throw new TypeError('Invalid frozen city sources');
 const routes=new Map(), geonameIDs=new Set();
 for(const row of route.rows){
   if(!Number.isSafeInteger(row.sourceIndex)||row.sourceIndex<0||row.sourceIndex>=inventory.length
     ||routes.has(row.sourceIndex))throw new TypeError('Ambiguous route inventory index');
   const original=inventory[row.sourceIndex];
   if(original.name!==row.name||original.latitude!==row.latitude||original.longitude!==row.longitude)
     throw new TypeError('Canonical path source changed');
   routes.set(row.sourceIndex,placePath(row));
 }
 if(routes.size!==inventory.length)throw new TypeError('Incomplete route identity index');
 const byPath=new Map();
 for(let i=0;i<inventory.length;i++){
   const identity=identities.rows[i],path=routes.get(i);
   if(!identity||identity.path!==path||byPath.has(path))throw new TypeError('GeoNames identity does not match canonical route');
   byPath.set(path,{identity,city:inventory[i]});
 }
 const sorted=[...ranking.cities].sort((a,b)=>a.rank-b.rank);
 if(sorted.length<count)throw new TypeError('Requested cohort exceeds ranked manifest');
 for(let i=0;i<sorted.length;i++){
   if(sorted[i]?.rank!==i+1||typeof sorted[i].path!=='string')throw new TypeError('Nonconsecutive ranked path inventory');
 }
 const paths=new Set();
 const rows=sorted.slice(0,count).map(({rank,path:canonicalPath})=>{
   if(paths.has(canonicalPath))throw new TypeError('Duplicate ranked canonical path');
   paths.add(canonicalPath);
   const resolved=byPath.get(canonicalPath);
   if(!resolved)throw new TypeError(`Ranked route absent from canonical inventory: ${canonicalPath}`);
   const {identity,city}=resolved;
   if(!['exact','alternate'].includes(identity.status)||!Number.isSafeInteger(identity.id)
     ||identity.id<1||geonameIDs.has(identity.id)||typeof identity.timeZone!=='string'){
     throw new TypeError(`Unreviewed GeoNames identity for ${canonicalPath}`);
   }
   try{new Intl.DateTimeFormat('en-US',{timeZone:identity.timeZone});}
   catch{throw new TypeError(`Unrecognized IANA timezone for ${canonicalPath}`);}
   geonameIDs.add(identity.id);
   return {rank,path:canonicalPath,geoNamesId:identity.id,timeZone:identity.timeZone,
     requestCoordinate:[city.latitude,city.longitude],actualEra5LandCell:null};
 });
 return {schemaVersion:1,cohort:'ranked-historical',count,geoNamesSourceSha256:identities.sourceSha256,
   actualEra5LandCellMappingVerified:false,rows};
}
function main(){
 const args=new Map(process.argv.slice(2).map(x=>x.split('=',2)));
 for(const option of ['--inventory','--routes','--identities','--ranking','--out']){
   if(!args.get(option))throw new TypeError(`Missing ${option}=path`);
 }
 const raw=new Map([...args].filter(([key])=>!['--count','--out'].includes(key))
   .map(([key,value])=>[key,fs.readFileSync(value)]));
 const read=key=>JSON.parse(raw.get(key));
 const count=args.has('--count')?Number(args.get('--count')):50;
 const result=buildHistoricalCohort({inventory:read('--inventory'),route:read('--routes'),
   identities:read('--identities'),ranking:read('--ranking'),count});
 result.inputSha256=Object.fromEntries(['--inventory','--routes','--identities','--ranking']
   .map(key=>[key.slice(2),sha256(raw.get(key))]));
 const out=path.resolve(args.get('--out'));
 if(fs.existsSync(out))throw new Error('Refusing to overwrite private frozen cohort');
 fs.mkdirSync(path.dirname(out),{recursive:true,mode:0o700});
 const temporary=`${out}.tmp-${process.pid}`;
 try{
   fs.writeFileSync(temporary,JSON.stringify(result)+'\n',{mode:0o600,flag:'wx'});
   fs.renameSync(temporary,out);
 }finally{try{fs.unlinkSync(temporary);}catch{}}
 console.log(JSON.stringify({count:result.count,sourceSha256:result.geoNamesSourceSha256,
   timeZones:new Set(result.rows.map(r=>r.timeZone)).size}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
