#!/usr/bin/env node
/**
 * UTC-offset segments per IANA zone as the pipeline's ICU (Intl) sees them, for the
 * independent verifier's timezone-definition parity check. Output:
 * {"icu": "...", "tz": "...", "startUTC": "...", "hours": N, "zones": {zone: [[hourIndex, offsetSeconds], ...]}}
 * Sampled every 3 h; each change is refined to its exact UTC hour. A sub-3-hour
 * round trip would be missed here and then caught as a mismatch by the hourly
 * Python comparison (fail closed). No network.
 */
const START = Date.UTC(1949, 11, 30), END = Date.UTC(2026, 0, 3), HOUR = 3_600_000;

function offsetAt(format, ms) {
  const name = format.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName').value;
  if (name === 'GMT') return 0;
  const m = /^GMT([+-])(\d\d):(\d\d)(?::(\d\d))?$/.exec(name);
  if (!m) throw new Error(`Unparseable ICU offset ${name}`);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0));
}

export function zoneSegments(zone) {
  const format = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
  const segments = [[0, offsetAt(format, START)]];
  let previous = segments[0][1];
  for (let ms = START + 3 * HOUR; ms < END; ms += 3 * HOUR) {
    const value = offsetAt(format, ms);
    if (value === previous) continue;
    let at = ms - 2 * HOUR;
    while (offsetAt(format, at) === previous) at += HOUR;
    segments.push([(at - START) / HOUR, offsetAt(format, at)]);
    previous = offsetAt(format, at);
    if (previous !== value) segments.push([(ms - START) / HOUR, (previous = value)]);
  }
  return segments;
}

const zones = JSON.parse(process.argv[2] ?? '[]');
console.log(JSON.stringify({ icu: process.versions.icu, tz: process.versions.tz ?? null, startUTC: new Date(START).toISOString(),
  hours: (END - START) / HOUR, zones: Object.fromEntries(zones.map((zone) => [zone, zoneSegments(zone)])) }));
