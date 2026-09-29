import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistoricalYears } from '../lib/historical-wetbulb/merge.mjs';
import { createHistoricalShard } from '../lib/historical-wetbulb/assets.mjs';

const common = { schemaVersion:1, source:'ERA5-Land hourly time series', methodVersion:'2026-heatindex-0.0.2', timeZone:'America/Phoenix', gridCell:[33.4,-112.1] };
const high=(valueC,utcTime,localDate)=>({valueC,utcTime,localDate});
function year(localYear, {daily={}, monthly={}, periodHigh=null, partialDays=[]}={}) {
  return {...common,localYear,daily,monthly,periodHigh,coverage:{validHours:8760,completeDays:365,firstComplete:`${localYear}-01-01`,lastComplete:`${localYear}-12-31`,partialDays}};
}
test('merges daily/monthly maxima over years, preserving coverage and weighted monthly mean',()=>{
 const a=year(2020,{daily:{'02-29':{...high(20,'2020-02-29T20:00:00.000Z','2020-02-29'),hours:24,contributingYears:[2020]},'01-01':{...high(10,'2020-01-01T20:00:00.000Z','2020-01-01'),hours:24,contributingYears:[2020]}},monthly:{'01':{...high(10,'2020-01-01T20:00:00.000Z','2020-01-01'),hours:24,meanC:5}},periodHigh:high(20,'2020-02-29T20:00:00.000Z','2020-02-29')});
 const b=year(2021,{daily:{'01-01':{...high(12,'2021-01-01T20:00:00.000Z','2021-01-01'),hours:24,contributingYears:[2021]}},monthly:{'01':{...high(12,'2021-01-01T20:00:00.000Z','2021-01-01'),hours:48,meanC:8}},periodHigh:high(12,'2021-01-01T20:00:00.000Z','2021-01-01')});
 const result=mergeHistoricalYears([a,b],{startYear:2020,endYear:2021});
 assert.equal(result.daily['01-01'].valueC,12);
 assert.equal(result.daily['01-01'].contributingYears,2);
 assert.equal(result.daily['02-29'].contributingYears,1);
 assert.equal(result.monthly['01'].meanC,7);
 assert.equal(result.monthly['01'].highC,12);
 assert.equal(result.periodHigh.valueC,20);
 assert.deepEqual(result.coverage.years,[2020,2021]);
});
test('a complete pair of years retains boundaries and can pass the publication gate',()=>{
 const annual=localYear=>{
  const count=localYear===2020?366:365;
  const daily=Object.fromEntries(Array.from({length:count},(_,i)=>{
   const date=new Date(Date.UTC(localYear,0,i+1)).toISOString().slice(0,10);
   return [date.slice(5),{...high(20,`${date}T12:00:00.000Z`,date),hours:24,contributingYears:[localYear]}];
  }));
  const monthly=Object.fromEntries(Array.from({length:12},(_,i)=>{
   const date=`${localYear}-${String(i+1).padStart(2,'0')}-01`;
   return [date.slice(5,7),{...high(20,`${date}T12:00:00.000Z`,date),hours:24,meanC:15}];
  }));
  return {...year(localYear,{daily,monthly,periodHigh:high(20,`${localYear}-01-01T12:00:00.000Z`,`${localYear}-01-01`)}),
   coverage:{validHours:count*24,completeDays:count,firstComplete:`${localYear}-01-01`,lastComplete:`${localYear}-12-31`,partialDays:[]}};
 };
 const merged=mergeHistoricalYears([annual(2020),annual(2021)],{startYear:2020,endYear:2021});
 assert.equal(merged.coverage.firstComplete,'2020-01-01');
 assert.equal(merged.coverage.lastComplete,'2021-12-31');
 assert.equal(createHistoricalShard([merged]).index.length,1);
 assert.throws(()=>createHistoricalShard([mergeHistoricalYears([annual(2020),{...annual(2021),researchOnly:true}],{startYear:2020,endYear:2021})]),/research/);
});
test('fails closed for a missing year, mixed source cell/method/timezone and duplicate calendar year',()=>{
 const a=year(2020),b=year(2021);
 for(const ys of [[a],[a,a],[a,{...b,timeZone:'UTC'}],[a,{...b,gridCell:[33.5,-112.1]}],[a,{...b,methodVersion:'old'}],[a,{...b,source:'ERA5'}]]) {
  assert.throws(()=>mergeHistoricalYears(ys,{startYear:2020,endYear:2021}));
 }
});
