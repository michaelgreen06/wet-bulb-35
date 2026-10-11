import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packHistoricalGroup, unpackHistoricalDay, createHistoricalShard } from '../lib/historical-wetbulb/assets.mjs';

const high = { schemaVersion:1,source:'ERA5-Land hourly time series',methodVersion:'2026-heatindex-0.0.2',
  timeZone:'America/Phoenix',gridCell:[33.4,-112.1],startYear:1950,endYear:1950,
  coverage:{years:[1950],validHours:8736,completeDays:363,partialDays:[{date:'1950-01-01',observedHours:7},{date:'1950-12-31',observedHours:17}]},
  daily:{'07-18':{valueC:24.2597,utcTime:'1950-07-18T22:00:00.000Z',localDate:'1950-07-18',contributingYears:1,hours:24}},
  monthly:{'07':{highC:24.2597,highUTC:'1950-07-18T22:00:00.000Z',highLocalDate:'1950-07-18',meanC:19.83,hours:744}},
  periodHigh:{valueC:24.2597,utcTime:'1950-07-18T22:00:00.000Z',localDate:'1950-07-18'} };

test('fixed-width history preserves modeled value, winning UTC time and missing day without inventing data',()=>{
  const packed=packHistoricalGroup(high);
  assert.equal(Buffer.from(packed.data,'base64').length,366*7);
  assert.deepEqual(unpackHistoricalDay(packed.data,'07-18'),{valueC:24.3,utcTime:'1950-07-18T22:00:00.000Z',contributingYears:1});
  assert.equal(unpackHistoricalDay(packed.data,'02-29'),null);
  assert.equal(packed.monthly['07'].highC,24.3);
  assert.equal(packed.periodHigh.valueC,24.3);
  assert.equal(packed.metadata.source,'ERA5-Land hourly time series');
});
test('production packaging rejects incomplete calendar coverage; research fixtures remain flagged',()=>{
  assert.throws(()=>createHistoricalShard([high],{maxBytes:20000}),/coverage/);
  const sample=createHistoricalShard([high],{maxBytes:20000,allowPartialResearch:true});
  assert.equal(JSON.parse(sample.contents).researchOnly,true);
});
test('shard has content digest, bounded size and stable cell/timezone index, rejects duplicates',()=>{
  const entries=[high,{...high,timeZone:'America/New_York'}];
  const one=createHistoricalShard(entries,{maxBytes:20000,allowPartialResearch:true});
  const two=createHistoricalShard(entries,{maxBytes:20000,allowPartialResearch:true});
  assert.deepEqual(one, two);
  assert.equal(one.index.length,2);
  assert.notEqual(one.index[0][0],one.index[1][0]);
  assert.match(one.sha256,/^[a-f0-9]{64}$/);
  assert.throws(()=>createHistoricalShard([high,high],{maxBytes:20000,allowPartialResearch:true}));
  assert.throws(()=>createHistoricalShard(entries,{maxBytes:1,allowPartialResearch:true}));
});
test('complete synthetic year passes publication gate; any interior gap is refused',()=>{
  const days=Array.from({length:365},(_,i)=>new Date(Date.UTC(2021,0,i+1)).toISOString().slice(0,10));
  const monthly=Object.fromEntries(Array.from({length:12},(_,i)=>{
    const month=String(i+1).padStart(2,'0');const firstDay=`2021-${month}-01`;
    return [month,{highC:20,highUTC:firstDay+'T12:00:00.000Z',highLocalDate:firstDay,meanC:15,hours:24}];
  }));
  const complete={...high,startYear:2021,endYear:2021,
    coverage:{years:[2021],validHours:8760,completeDays:365,firstComplete:'2021-01-01',lastComplete:'2021-12-31',partialDays:[]},
    daily:Object.fromEntries(days.map(day=>[day.slice(5),{valueC:20,utcTime:day+'T12:00:00.000Z',localDate:day,contributingYears:1,hours:24}])),
    monthly,periodHigh:{valueC:20,utcTime:'2021-01-01T12:00:00.000Z',localDate:'2021-01-01'}};
  const shard=createHistoricalShard([complete],{maxBytes:20000});
  assert.equal(JSON.parse(shard.contents).researchOnly,false);
  assert.throws(()=>createHistoricalShard([{...complete,coverage:{...complete.coverage,completeDays:364}}],{maxBytes:20000}),/coverage/);
  assert.throws(()=>createHistoricalShard([{...complete,coverage:{...complete.coverage,partialDays:[{date:'2021-06-01',observedHours:23}]}}],{maxBytes:20000}),/coverage/);
  const missingDay={...complete,daily:{...complete.daily}};delete missingDay.daily['06-01'];
  assert.throws(()=>createHistoricalShard([missingDay],{maxBytes:20000}),/coverage/);
  assert.throws(()=>createHistoricalShard([{...complete,monthly:{}}],{maxBytes:20000}),/coverage/);
  assert.throws(()=>createHistoricalShard([{...complete,researchOnly:true}],{maxBytes:20000}),/research/);
});
test('bad date, nonhour timestamp, missing source and period mismatch fail closed',()=>{
 for(const item of [
  {...high,source:'ERA5'},
  {...high,daily:{'13-01':high.daily['07-18']}},
  {...high,daily:{'07-18':{...high.daily['07-18'],utcTime:'1950-07-18T22:30:00.000Z'}}},
  {...high,daily:{'07-18':{...high.daily['07-18'],contributingYears:4}}},
  {...high,startYear:1951},
 ]) assert.throws(()=>packHistoricalGroup(item));
});
