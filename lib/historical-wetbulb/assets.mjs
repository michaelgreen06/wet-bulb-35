/* Compact, versioned static history payloads. No raw or synthetic climate data. */
import crypto from 'node:crypto';

const DAYS=366, RECORD_BYTES=7, ABSENT=-32768;
const SOURCE='ERA5-Land hourly time series';
const dateKeys=Object.freeze(Array.from({length:DAYS},(_,i)=>new Date(Date.UTC(2000,0,i+1)).toISOString().slice(5,10)));
const dateIndex=new Map(dateKeys.map((key,index)=>[key,index]));
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const isPeak=p=>p&&Number.isFinite(p.valueC)&&typeof p.utcTime==='string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(p.utcTime)
  && Number.isFinite(Date.parse(p.utcTime))&&/^\d{4}-\d{2}-\d{2}$/.test(p.localDate||'');
export function historicalGroupKey(gridCell,timeZone){
 if(!Array.isArray(gridCell)||gridCell.length!==2||!gridCell.every(Number.isFinite)
   ||typeof timeZone!=='string'||!/^[A-Za-z0-9_+./-]{1,80}$/.test(timeZone))throw new TypeError('Invalid cell/timezone group');
 return `${gridCell.map(v=>v.toFixed(1)).join(',')}|${timeZone}`;
}
function assertPeak(peak,yearStart,yearEnd,key){
 if(!isPeak(peak)||!Number.isInteger(peak.contributingYears)||peak.contributingYears<1
   ||peak.contributingYears>yearEnd-yearStart+1||peak.localDate.slice(5)!==key
   ||Number(peak.localDate.slice(0,4))<yearStart||Number(peak.localDate.slice(0,4))>yearEnd
   ||Math.round(peak.valueC*10)<=ABSENT||Math.round(peak.valueC*10)>32767
   ||!Number.isSafeInteger(Date.parse(peak.utcTime)/3_600_000))throw new TypeError('Invalid modeled day high');
}
export function packHistoricalGroup(summary){
 if(!summary||summary.schemaVersion!==1||summary.source!==SOURCE||typeof summary.methodVersion!=='string'
   ||!Number.isInteger(summary.startYear)||!Number.isInteger(summary.endYear)
   ||summary.startYear<1950||summary.endYear>2100||summary.endYear<summary.startYear
   ||!summary.coverage||!Array.isArray(summary.coverage.years)
   ||summary.coverage.years.length!==summary.endYear-summary.startYear+1
   ||summary.coverage.years.some((year,i)=>year!==summary.startYear+i)
   ||!summary.daily||typeof summary.daily!=='object'||!summary.monthly||typeof summary.monthly!=='object'){
  throw new TypeError('Invalid modeled history schema or year coverage');
 }
 const key=historicalGroupKey(summary.gridCell,summary.timeZone);
 const bytes=Buffer.alloc(DAYS*RECORD_BYTES);
 for(let i=0;i<DAYS;i++)bytes.writeInt16LE(ABSENT,i*RECORD_BYTES);
 for(const [day,peak] of Object.entries(summary.daily)){
  const index=dateIndex.get(day);
  if(index===undefined)throw new TypeError('Invalid calendar day');
  assertPeak(peak,summary.startYear,summary.endYear,day);
  const offset=index*RECORD_BYTES;
  bytes.writeInt16LE(Math.round(peak.valueC*10),offset);
  bytes.writeInt32LE(Date.parse(peak.utcTime)/3_600_000,offset+2);
  bytes.writeUInt8(peak.contributingYears,offset+6);
 }
 const monthly={};
 for(const [month,value] of Object.entries(summary.monthly)){
  if(!/^(0[1-9]|1[0-2])$/.test(month)||!Number.isFinite(value.highC)||!Number.isFinite(value.meanC)
    ||!Number.isSafeInteger(value.hours)||value.hours<1||typeof value.highUTC!=='string'
    ||!isPeak({valueC:value.highC,utcTime:value.highUTC,localDate:value.highLocalDate})
    ||!value.highLocalDate.startsWith(`${value.highLocalDate.slice(0,4)}-${month}-`)) {
   throw new TypeError('Invalid modeled monthly summary');
  }
  monthly[month]={highC:Number(value.highC.toFixed(1)),meanC:Number(value.meanC.toFixed(1)),
    highUTC:value.highUTC,highLocalDate:value.highLocalDate,hours:value.hours};
 }
 const periodHigh=summary.periodHigh;
 if(periodHigh&&!isPeak(periodHigh))throw new TypeError('Invalid modeled period high');
 const high=periodHigh?{valueC:Number(periodHigh.valueC.toFixed(1)),utcTime:periodHigh.utcTime,
   localDate:periodHigh.localDate}:null;
 const metadata={source:SOURCE,methodVersion:summary.methodVersion,startYear:summary.startYear,
   endYear:summary.endYear,gridCell:summary.gridCell,timeZone:summary.timeZone,
   coverage:summary.coverage};
 return {key,metadata,monthly:Object.fromEntries(Object.entries(monthly).sort(([a],[b])=>a.localeCompare(b))),
   periodHigh:high,data:bytes.toString('base64')};
}
export function unpackHistoricalDay(data,day){
 if(typeof data!=='string'||!dateIndex.has(day))throw new TypeError('Invalid historical payload or calendar date');
 const buffer=Buffer.from(data,'base64');
 if(buffer.length!==DAYS*RECORD_BYTES)throw new TypeError('Invalid historical daily shard length');
 const offset=dateIndex.get(day)*RECORD_BYTES;
 const tenths=buffer.readInt16LE(offset);
 if(tenths===ABSENT)return null;
 const hours=buffer.readInt32LE(offset+2),years=buffer.readUInt8(offset+6);
 if(!years)return null;
 return {valueC:tenths/10,utcTime:new Date(hours*3_600_000).toISOString(),contributingYears:years};
}
const coverageCache=new Map();
function expectedDayCounts(startYear,endYear,first){
 const cacheKey=`${startYear}:${endYear}:${first}`;
 if(coverageCache.has(cacheKey))return coverageCache.get(cacheKey);
 const result=new Map();
 for(const key of dateKeys){
   const month=Number(key.slice(0,2)),day=Number(key.slice(3));let count=0;
   for(let year=startYear;year<=endYear;year++){
     const date=new Date(Date.UTC(year,month-1,day));
     if(date.getUTCMonth()===month-1&&date.getUTCDate()===day&&date.toISOString().slice(0,10)>=first)count++;
   }
   result.set(key,count);
 }
 coverageCache.set(cacheKey,result);
 return result;
}
function assertPublicationCoverage(summary){
 const {coverage,startYear,endYear}=summary;
 const first=coverage.firstComplete,last=coverage.lastComplete;
 if(typeof first!=='string'||typeof last!=='string'
   ||!/^\d{4}-\d{2}-\d{2}$/.test(first)||!/^\d{4}-\d{2}-\d{2}$/.test(last)
   ||last!==`${endYear}-12-31`
   ||(startYear===1950?!['1950-01-02','1950-01-03'].includes(first):first!==`${startYear}-01-01`)){
   throw new TypeError('Historical publication coverage omits a year boundary.');
 }
 const expected=(Date.parse(`${last}T00:00:00Z`)-Date.parse(`${first}T00:00:00Z`))/86_400_000+1;
 if(!Number.isSafeInteger(expected)||coverage.completeDays!==expected
   ||!Number.isSafeInteger(coverage.validHours)||coverage.validHours<coverage.completeDays*23
   ||!Array.isArray(coverage.partialDays)
   ||coverage.partialDays.some(d=>d?.date>=first&&d.date<=last)){
   throw new TypeError('Historical publication coverage contains missing or partial local days.');
 }
 const dayCounts=expectedDayCounts(startYear,endYear,first);
 if(!summary.periodHigh||Object.keys(summary.monthly||{}).length!==12
   ||Object.keys(summary.daily||{}).length!==[...dayCounts.values()].filter(Boolean).length
   ||[...dayCounts].some(([key,count])=>count
     ? summary.daily[key]?.contributingYears!==count
     : Object.hasOwn(summary.daily,key))){
   throw new TypeError('Historical publication coverage lacks a full month/day grid.');
 }
}
export function createHistoricalShard(summaries,{maxBytes=4*1024*1024,allowPartialResearch=false}={}){
 if(!Array.isArray(summaries)||!summaries.length||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new TypeError('Invalid shard parameters');
 if(!allowPartialResearch) summaries.forEach(assertPublicationCoverage);
 const records=summaries.map(packHistoricalGroup).sort((a,b)=>a.key.localeCompare(b.key));
 if(new Set(records.map(r=>r.key)).size!==records.length)throw new TypeError('Duplicate cell/timezone histories');
 const contents=JSON.stringify({version:1,researchOnly:allowPartialResearch,records});
 const bytes=Buffer.byteLength(contents);
 if(bytes>maxBytes)throw new RangeError('Historical asset exceeds reviewed shard byte budget');
 return {contents,bytes,sha256:sha256(contents),index:records.map((r,i)=>[r.key,i])};
}
