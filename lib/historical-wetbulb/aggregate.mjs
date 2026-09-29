/* Offline ERA5-Land hourly reduction. No network calls or Worker-side calculations. */
import {
  ROMPS_METHOD_VERSION,
  calculateRompsLiquidSaturationVaporPressurePa,
  calculateRompsWetBulbFromVaporPressureKelvin,
} from '../forecast/romps.ts';

const HOUR_MS = 3_600_000;
const UTC_HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:\.000)?Z$/;

function localDateFormatter(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, year:'numeric',month:'2-digit',day:'2-digit' });
  } catch {
    throw new TypeError('A valid IANA time zone is required.');
  }
}
function dayAt(formatter, ms) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(({type,value})=>[type,value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function assertCell(cell) {
  if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isFinite)
    || Math.abs(cell[0]) > 90 || Math.abs(cell[1]) > 180) {
    throw new TypeError('ERA5-Land cell coordinates are invalid.');
  }
}
function validatedRow(row, cell) {
  if (!row || typeof row !== 'object' || typeof row.timeUTC !== 'string' || !UTC_HOUR.test(row.timeUTC)) {
    throw new TypeError('ERA5-Land UTC hour is invalid.');
  }
  const ms = Date.parse(row.timeUTC);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== row.timeUTC.replace('Z', '.000Z').replace('.000.000Z','.000Z')) {
    throw new TypeError('ERA5-Land UTC timestamp is invalid.');
  }
  assertCell(row.gridCell);
  if (row.gridCell.some((value,index)=>Math.abs(value-cell[index])>1e-5)) {
    throw new TypeError('ERA5-Land input crosses grid cells.');
  }
  const {temperatureK:t,dewpointK:d,pressurePa:p}=row;
  if (![t,d,p].every(Number.isFinite) || t < 150 || t > 350 || d < 150 || d > 350
    || d > t + 1 || p < 10_000 || p > 110_000) {
    throw new TypeError('ERA5-Land hourly thermodynamic inputs are invalid.');
  }
  return {ms,t,d,p};
}
function daySummary(rows, formatter) {
  const day = dayAt(formatter, rows[0].ms);
  const first = rows[0].ms;
  const last = rows.at(-1).ms;
  const consecutive = rows.every((row,index)=>index===0 || row.ms===rows[index-1].ms+HOUR_MS);
  const complete = consecutive && dayAt(formatter,first-HOUR_MS)!==day
    && dayAt(formatter,last+HOUR_MS)!==day;
  return {day,complete};
}
function maxOf(previous,candidate) {
  return !previous || candidate.valueC > previous.valueC ? candidate : previous;
}

/**
 * Deterministically reduce already-normalized, UTC-sorted hourly rows for one
 * source cell and one IANA timezone. Returns aggregate evidence for complete
 * local dates only; caller must separately enforce the advertised period and
 * minimum year/hour coverage before publishing.
 */
export function aggregateHistoricalWetBulb(rows,{timeZone,gridCell,localYear}={}) {
  if(localYear !== undefined && (!Number.isInteger(localYear) || localYear < 1950 || localYear > 2100)) {
    throw new TypeError('Invalid local year.');
  }
  if (!Array.isArray(rows) || !rows.length) throw new TypeError('Nonempty hourly rows are required.');
  const formatter=localDateFormatter(timeZone);
  const sourceCell=gridCell ?? rows[0].gridCell;
  assertCell(sourceCell);
  let priorMs=-Infinity;
  const dayBuckets=new Map();
  for(const row of rows) {
    const {ms,t,d,p}=validatedRow(row,sourceCell);
    if(ms<=priorMs) throw new TypeError('ERA5-Land timestamps must be strictly increasing and unique.');
    priorMs=ms;
    const valueC=calculateRompsWetBulbFromVaporPressureKelvin({
      airTemperatureK:t,pressurePa:p,
      vaporPressurePa:calculateRompsLiquidSaturationVaporPressurePa(Math.min(t,d)),
    })-273.15;
    if(!Number.isFinite(valueC) || valueC<-120 || valueC>90) throw new TypeError('Invalid modeled wet bulb.');
    const day=dayAt(formatter,ms);
    if(!dayBuckets.has(day)) dayBuckets.set(day,[]);
    dayBuckets.get(day).push({ms,valueC,utcTime:new Date(ms).toISOString()});
  }
  const days=new Map(),months=new Map(),partialDays=[];
  let periodHigh=null,completeDays=0,firstComplete=null,lastComplete=null;
  for(const [date,values] of dayBuckets){
    if(localYear !== undefined && Number(date.slice(0,4)) !== localYear) continue;
    const {complete}=daySummary(values,formatter);
    if(!complete){partialDays.push({date,observedHours:values.length});continue;}
    completeDays++;
    firstComplete ??= date;
    lastComplete=date;
    const mmdd=date.slice(5), month=date.slice(5,7), year=Number(date.slice(0,4));
    const dailyHigh=values.reduce((top,row)=>maxOf(top,{valueC:row.valueC,utcTime:row.utcTime,localDate:date}),null);
    const prev=days.get(mmdd)??{contributingYears:[],hours:0,high:null};
    prev.high=maxOf(prev.high,dailyHigh);
    prev.contributingYears.push(year);
    prev.hours+=values.length;
    days.set(mmdd,prev);
    const m=months.get(month)??{hours:0,sum:0,high:null};
    m.hours+=values.length;
    m.sum+=values.reduce((sum,row)=>sum+row.valueC,0);
    m.high=maxOf(m.high,dailyHigh);
    months.set(month,m);
    periodHigh=maxOf(periodHigh,dailyHigh);
  }
  const daily=Object.fromEntries([...days].sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,{
    ...v.high,hours:v.hours,contributingYears:[...new Set(v.contributingYears)].sort((a,b)=>a-b),
  }]));
  const monthly=Object.fromEntries([...months].sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,{
    ...v.high,hours:v.hours,meanC:v.sum/v.hours,
  }]));
  return {
    schemaVersion:1,source:'ERA5-Land hourly time series',methodVersion:ROMPS_METHOD_VERSION,
    timeZone,gridCell:[...sourceCell],daily,monthly,periodHigh,
    coverage:{validHours:rows.length,completeDays,firstComplete,lastComplete,partialDays},
  };
}
