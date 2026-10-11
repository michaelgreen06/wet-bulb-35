#!/usr/bin/env node
/** Offline annual ERA5-Land reduction. Requires a private normalized CDS archive. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { aggregateHistoricalWetBulb } from '../../lib/historical-wetbulb/aggregate.mjs';

function args(argv) {
  const options = new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!argv[i]?.startsWith('--') || argv[i+1]===undefined || options.has(argv[i])) {
      throw new TypeError('Arguments must be unique --key value pairs.');
    }
    options.set(argv[i],argv[i+1]);
  }
  for(const key of ['--normalized','--cell','--timezone','--year','--out']) {
    if(!options.get(key)) throw new TypeError(`Missing ${key}`);
  }
  return options;
}
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function atomicPrivateWrite(file,text) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  if(fs.existsSync(file)) throw new Error('Refusing to overwrite an existing annual summary.');
  const temp=`${file}.tmp-${process.pid}`;
  try { fs.writeFileSync(temp,text,{mode:0o600,flag:'wx'});fs.renameSync(temp,file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
export function buildAnnualSummary({normalized,cell,timeZone,localYear}) {
  const manifest=JSON.parse(fs.readFileSync(path.join(normalized,'manifest.json'),'utf8'));
  if(manifest.schemaVersion!==1 || manifest.dataset!=='reanalysis-era5-land-timeseries'
    || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256)
    || !Object.hasOwn(manifest.files,cell)) throw new TypeError('Invalid private CDS manifest or source cell.');
  const record=manifest.files[cell];
  if(!/^cell-[a-f0-9]{20}\.ndjson$/.test(record.file)) throw new TypeError('Unsafe private source filename.');
  const raw=fs.readFileSync(path.join(normalized,record.file));
  if(sha256(raw)!==record.sha256) throw new Error('Normalized source checksum mismatch.');
  const rows=raw.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  if(rows.length!==record.hours) throw new Error('Normalized source row count mismatch.');
  const result=aggregateHistoricalWetBulb(rows,{timeZone,localYear});
  if(result.gridCell.map(x=>x.toFixed(1)).join(',')!==cell) throw new Error('Source grid cell mismatch.');
  return { ...result, localYear, researchOnly:manifest.researchOnly===true,
    sourceArchiveSha256:manifest.sourceSha256, normalizedCellSha256:record.sha256 };
}
if(process.argv[1] && path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)) {
  const o=args(process.argv.slice(2));
  const result=buildAnnualSummary({normalized:o.get('--normalized'),cell:o.get('--cell'),
    timeZone:o.get('--timezone'),localYear:Number(o.get('--year'))});
  atomicPrivateWrite(o.get('--out'),JSON.stringify(result)+'\n');
  console.log(JSON.stringify({localYear:result.localYear,cell:o.get('--cell'),
    completeDays:result.coverage.completeDays,partialDays:result.coverage.partialDays.length,
    sourceArchiveSha256:result.sourceArchiveSha256}));
}
