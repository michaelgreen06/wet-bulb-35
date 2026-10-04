import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateHistoricalWetBulb } from '../lib/historical-wetbulb/aggregate.mjs';
import { calculateRompsLiquidSaturationVaporPressurePa, calculateRompsWetBulbFromVaporPressureKelvin } from '../lib/forecast/romps.ts';

const cell = [33.4, -112.1];
function rows(start, end, { temperatureK = 303.15, dewpointK = 293.15, pressurePa = 97000, gridCell = cell } = {}) {
  const result = [];
  for (let ms = Date.parse(start); ms <= Date.parse(end); ms += 3_600_000) {
    result.push({ timeUTC: new Date(ms).toISOString(), temperatureK, dewpointK, pressurePa, gridCell });
  }
  return result;
}
function expectedWetBulb(row) {
  return calculateRompsWetBulbFromVaporPressureKelvin({
    airTemperatureK: row.temperatureK,
    vaporPressurePa: calculateRompsLiquidSaturationVaporPressurePa(row.dewpointK),
    pressurePa: row.pressurePa,
  }) - 273.15;
}

test('joins real-hour thermodynamics before assigning local date and rejects UTC-window edge days', () => {
  const sample = rows('1950-02-28T00:00:00Z', '1950-03-01T23:00:00Z');
  sample.find(row => row.timeUTC === '1950-02-28T22:00:00.000Z').temperatureK += 3;
  const result = aggregateHistoricalWetBulb(sample, { timeZone: 'America/Phoenix' });
  assert.equal(result.coverage.validHours, 48);
  assert.deepEqual(result.coverage.partialDays, [
    { date: '1950-02-27', observedHours: 7 },
    { date: '1950-03-01', observedHours: 17 },
  ]);
  assert.equal(result.coverage.completeDays, 1);
  assert.deepEqual(result.daily['02-28'].contributingYears, [1950]);
  assert.equal(result.daily['02-28'].utcTime, '1950-02-28T22:00:00.000Z');
  assert.ok(Math.abs(result.daily['02-28'].valueC - expectedWetBulb(sample.find(row => row.timeUTC === '1950-02-28T22:00:00.000Z'))) < 1e-8);
  assert.deepEqual(Object.keys(result.monthly), ['02']);
  assert.equal(result.monthly['02'].hours, 24);
  assert.equal(result.periodHigh.utcTime, result.daily['02-28'].utcTime);
});

test('uses local IANA calendar days with 23- and 25-hour DST dates and separate leap day', () => {
  const spring = aggregateHistoricalWetBulb(rows('2020-03-07T00:00:00Z', '2020-03-10T23:00:00Z'), { timeZone: 'America/New_York' });
  assert.equal(spring.daily['03-08'].hours, 23);
  assert.ok(spring.daily['03-08'].contributingYears.includes(2020));
  const fall = aggregateHistoricalWetBulb(rows('2020-10-31T00:00:00Z', '2020-11-03T23:00:00Z'), { timeZone: 'America/New_York' });
  assert.equal(fall.daily['11-01'].hours, 25);
  const leap = aggregateHistoricalWetBulb(rows('2020-02-28T00:00:00Z', '2020-03-02T23:00:00Z'), { timeZone: 'UTC' });
  assert.equal(leap.daily['02-29'].hours, 24);
  assert.notEqual(leap.daily['02-29'], leap.daily['02-28']);
});

test('selects the highest eligible hour across years and excludes incomplete days from monthly values', () => {
  const first = rows('2020-01-01T00:00:00Z', '2020-01-01T23:00:00Z');
  const second = rows('2021-01-01T00:00:00Z', '2021-01-01T23:00:00Z', {temperatureK: 308.15});
  const gap = rows('2020-01-03T00:00:00Z', '2020-01-03T23:00:00Z').filter(row => row.timeUTC !== '2020-01-03T12:00:00.000Z');
  const result = aggregateHistoricalWetBulb([...first, ...gap, ...second], {timeZone:'UTC'});
  assert.equal(result.daily['01-01'].valueC, result.periodHigh.valueC);
  assert.deepEqual(result.daily['01-01'].contributingYears, [2020, 2021]);
  assert.equal(result.coverage.completeDays, 2);
  assert.deepEqual(result.coverage.partialDays, [{date:'2020-01-03',observedHours:23}]);
  assert.equal(result.monthly['01'].hours, 48);
});

test('pads UTC extraction but emits only the selected local year', () => {
  const padded = rows('2020-12-30T00:00:00Z','2021-01-03T23:00:00Z');
  const result = aggregateHistoricalWetBulb(padded,{timeZone:'America/Phoenix',localYear:2021});
  assert.equal(result.coverage.completeDays,2);
  assert.ok(result.daily['01-01']);
  assert.ok(!result.daily['12-31']);
  assert.ok(result.daily['01-01'].contributingYears.every(year=>year===2021));
});

test('rejects non-hourly, duplicate, unsorted, mismatched-cell and malformed source values', () => {
  const one = rows('2020-01-01T00:00:00Z', '2020-01-01T02:00:00Z');
  const invalid = [
    [...one, one[2]],
    [one[1],one[0]],
    [{...one[0],gridCell:[33.5,-112.1]}],
    [{...one[0],pressurePa:null}],
    [{...one[0],timeUTC:'2020-01-01T00:30:00.000Z'}],
  ];
  for (const sample of invalid) {
    assert.throws(() => aggregateHistoricalWetBulb(sample, {timeZone:'America/Phoenix', gridCell:cell}));
  }
  assert.throws(() => aggregateHistoricalWetBulb(one,{timeZone:'Not/A_Zone'}));
});
