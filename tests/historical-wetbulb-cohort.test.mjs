import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoricalCohort } from '../scripts/historical-wetbulb/build-cohort.mjs';
const inventory=[
 {name:'Alpha',latitude:10,longitude:20,resolvedCountryName:'A'},
 {name:'Beta',latitude:30,longitude:40,resolvedCountryName:'B'},
 {name:'Gamma',latitude:-5,longitude:50,resolvedCountryName:'C'},
];
const route={rows:inventory.map((v,i)=>({sourceIndex:i,name:v.name,latitude:v.latitude,longitude:v.longitude,
 countrySlug:v.resolvedCountryName.toLowerCase(),stateSlug:'state',outputCitySlug:v.name.toLowerCase()}))};
const path=i=>`/wetbulb-temperature/${route.rows[i].countrySlug}/state/${route.rows[i].outputCitySlug}/`;
const identities={schemaVersion:1,sourceSha256:'a'.repeat(64),inventoryRows:3,rows:inventory.map((_,i)=>({path:path(i),id:100+i,
 timeZone:'Etc/UTC',status:'exact'}))};
const ranking={schemaVersion:1,cities:[{rank:1,path:path(1)},{rank:2,path:path(0)},{rank:3,path:path(2)}]};
test('freeze canonical rank/path and stable GeoNames/timezone without rerouting',()=>{
 const pilot=buildHistoricalCohort({inventory,route,identities,ranking,count:2});
 assert.equal(pilot.count,2);
 assert.deepEqual(pilot.rows.map(r=>r.path),[path(1),path(0)]);
 assert.deepEqual(pilot.rows.map(r=>r.geoNamesId),[101,100]);
 assert.deepEqual(pilot.rows.map(r=>r.requestCoordinate),[[30,40],[10,20]]);
 assert.equal(pilot.rows[0].timeZone,'Etc/UTC');
 assert.equal(pilot.rows[0].actualEra5LandCell,null);
 assert.equal(pilot.geoNamesSourceSha256,'a'.repeat(64));
});
test('fail closed on bad source ordering, ambiguous identity, duplicate ID, route drift, missing cohort route',()=>{
 const run=(changes={})=>buildHistoricalCohort({inventory,route,identities,ranking,count:2,...changes});
 const changedRows=(fn)=>({...identities,rows:identities.rows.map((r,i)=>fn({...r},i))});
 assert.throws(()=>run({identities:changedRows((r,i)=>i===0?{...r,status:'ambiguous'}:r)}));
 assert.throws(()=>run({identities:changedRows((r,i)=>i===0?{...r,id:101}:r)}));
 assert.throws(()=>run({route:{rows:route.rows.map((r,i)=>i===1?{...r,outputCitySlug:'changed'}:r)}}));
 assert.throws(()=>run({ranking:{...ranking,cities:[{rank:1,path:'/missing/'},{rank:2,path:path(0)}]}}));
 assert.throws(()=>run({ranking:{...ranking,cities:[{rank:2,path:path(1)},{rank:3,path:path(0)}]}}));
 assert.throws(()=>run({ranking:{...ranking,cities:[{rank:1,path:path(1)},{rank:2,path:path(1)}]}}));
});
