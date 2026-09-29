import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistoricalYears } from '../lib/historical-wetbulb/merge.mjs';

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
test('fails closed for a missing year, mixed source cell/method/timezone and duplicate calendar year',()=>{
 const a=year(2020),b=year(2021);
 for(const ys of [[a],[a,a],[a,{...b,timeZone:'UTC'}],[a,{...b,gridCell:[33.5,-112.1]}],[a,{...b,methodVersion:'old'}],[a,{...b,source:'ERA5'}]]) {
  assert.throws(()=>mergeHistoricalYears(ys,{startYear:2020,endYear:2021}));
 }
});
