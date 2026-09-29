/* Combine independently verified single-cell, single-timezone annual summaries. */
const SOURCE = 'ERA5-Land hourly time series';
function validPeak(v) {
  return v && Number.isFinite(v.valueC) && typeof v.utcTime === 'string'
    && Number.isFinite(Date.parse(v.utcTime)) && /^\d{4}-\d{2}-\d{2}$/.test(v.localDate || '');
}
function winner(left,right) { return !left || right.valueC > left.valueC ? right : left; }
function keyOf(v) { return `${v.gridCell[0].toFixed(1)},${v.gridCell[1].toFixed(1)}`; }

/** Reject incomplete year inventory and mixed-model provenance before publishing. */
export function mergeHistoricalYears(summaries,{startYear,endYear}={}) {
  if(!Array.isArray(summaries) || !Number.isInteger(startYear) || !Number.isInteger(endYear)
    || startYear<1950 || endYear<startYear || endYear>2100
    || summaries.length!==endYear-startYear+1) throw new TypeError('Missing or invalid annual summary range.');
  const first=summaries[0];
  if(first?.source!==SOURCE || !first.methodVersion || !first.timeZone
    || !Array.isArray(first.gridCell) || first.gridCell.length!==2 || !first.gridCell.every(Number.isFinite)) {
    throw new TypeError('Invalid historical source metadata.');
  }
  const days=new Map(), months=new Map(), partial=[];
  let periodHigh=null, validHours=0, completeDays=0;
  const years=[];
  for(const summary of [...summaries].sort((a,b)=>a.localYear-b.localYear)) {
    const year=startYear+years.length;
    if(summary?.schemaVersion!==1 || summary.source!==SOURCE || summary.localYear!==year
      || summary.methodVersion!==first.methodVersion || summary.timeZone!==first.timeZone
      || !Array.isArray(summary.gridCell) || summary.gridCell.length!==2
      || !summary.gridCell.every(Number.isFinite) || keyOf(summary)!==keyOf(first)
      || !summary.coverage || !Number.isSafeInteger(summary.coverage.validHours)
      || !Number.isSafeInteger(summary.coverage.completeDays)
      || !Array.isArray(summary.coverage.partialDays)
      || typeof summary.daily!=='object' || typeof summary.monthly!=='object') {
      throw new TypeError('Mixed or invalid annual ERA5-Land summary.');
    }
    years.push(year);
    validHours += summary.coverage.validHours;
    completeDays += summary.coverage.completeDays;
    partial.push(...summary.coverage.partialDays);
    for(const [date,entry] of Object.entries(summary.daily)) {
      if(!/^\d\d-\d\d$/.test(date) || !validPeak(entry) || entry.localDate!==`${year}-${date}`
        || entry.contributingYears?.length!==1 || entry.contributingYears[0]!==year
        || !Number.isSafeInteger(entry.hours) || entry.hours<1 || entry.hours>26) {
        throw new TypeError('Invalid annual calendar-day maximum.');
      }
      const aggregate=days.get(date)??{peak:null,contributingYears:0,hours:0};
      aggregate.peak=winner(aggregate.peak,entry);
      aggregate.contributingYears++;
      aggregate.hours+=entry.hours;
      days.set(date,aggregate);
    }
    for(const [month,entry] of Object.entries(summary.monthly)) {
      if(!/^(0[1-9]|1[0-2])$/.test(month) || !validPeak(entry)
        || !entry.localDate.startsWith(`${year}-${month}-`)
        || !Number.isFinite(entry.meanC) || !Number.isSafeInteger(entry.hours) || entry.hours<1) {
        throw new TypeError('Invalid annual monthly summary.');
      }
      const m=months.get(month)??{peak:null,hours:0,sum:0};
      m.peak=winner(m.peak,entry);
      m.hours+=entry.hours;
      m.sum+=entry.meanC*entry.hours;
      months.set(month,m);
    }
    if(summary.periodHigh){
      if(!validPeak(summary.periodHigh) || !summary.periodHigh.localDate.startsWith(`${year}-`)) {
        throw new TypeError('Invalid annual period maximum.');
      }
      periodHigh=winner(periodHigh,summary.periodHigh);
    }
  }
  const daily=Object.fromEntries([...days].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,{
    valueC:v.peak.valueC,utcTime:v.peak.utcTime,localDate:v.peak.localDate,
    contributingYears:v.contributingYears,hours:v.hours,
  }]));
  const monthly=Object.fromEntries([...months].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,{
    highC:v.peak.valueC,highUTC:v.peak.utcTime,highLocalDate:v.peak.localDate,
    meanC:v.sum/v.hours,hours:v.hours,
  }]));
  return {schemaVersion:1,source:SOURCE,methodVersion:first.methodVersion,timeZone:first.timeZone,
    gridCell:[...first.gridCell],startYear,endYear,daily,monthly,periodHigh,
    researchOnly:summaries.some(summary=>summary.researchOnly===true),
    coverage:{years,validHours,completeDays,partialDays:partial.sort((a,b)=>a.date.localeCompare(b.date))}};
}
