#!/usr/bin/env python3
"""Independently recompute a private research period from retained hourly inputs.

Separate from the Node pipeline on purpose: Python zoneinfo per-instant local dates
from a pinned, vendored IANA 2026c main-data tree (tzdata-iana-2026c/, never the
system's backzone build), checked hour-by-hour against the pipeline's ICU offsets per
zone (not Intl adjacency checks), a bisection Romps solver (not Brent) validated
against the heatindex 0.0.2 reference vectors, and its own checksum/identity
joins. Compares calendar-day, monthly and period highs plus coverage, and the same
for the low-v1 companion (minima), recomputed here from the checksummed chunks and
bound to the exact legacy high bytes. No network.
"""
import argparse
import hashlib
import json
import math
import struct
import sys
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

TZ_DIR = Path(__file__).resolve().with_name('tzdata-iana-2026c')
TZ_SOURCE = 'iana-2026c-main/pytz-2026.3.post1'
_TZ_MANIFEST, _ZONES, _PARITY = None, {}, {}


def tz_manifest():
    global _TZ_MANIFEST
    if _TZ_MANIFEST is None:
        manifest = json.loads((TZ_DIR / 'MANIFEST.json').read_text())
        tree = hashlib.sha256(json.dumps(manifest['files'], sort_keys=True).encode()).hexdigest()
        if manifest.get('iana') != '2026c' or tree != manifest.get('treeSha256'):
            raise ValueError('Pinned timezone tree manifest is inconsistent')
        _TZ_MANIFEST = manifest
    return _TZ_MANIFEST


def pinned_zone(name):
    """ZoneInfo from the pinned main-data tree only; each file must match its recorded SHA-256."""
    if name not in _ZONES:
        expected = tz_manifest()['files'].get(name)
        if expected is None:
            raise ValueError(f'{name}: zone absent from the pinned timezone tree')
        raw = (TZ_DIR / 'zoneinfo' / name).read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError(f'{name}: pinned timezone file checksum mismatch')
        import io
        _ZONES[name] = ZoneInfo.from_file(io.BytesIO(raw), key=name)
    return _ZONES[name]


def icu_segments(zones):
    """The pipeline's ICU offset segments for each zone (tz-offsets.mjs), or None without Node."""
    import shutil
    import subprocess
    node = shutil.which('node')
    if not node or not zones:
        return None
    result = subprocess.run([node, str(Path(__file__).with_name('tz-offsets.mjs')), json.dumps(sorted(zones))],
                            capture_output=True, text=True)
    if result.returncode:
        return None
    return json.loads(result.stdout)


def zone_parity(zones):
    """{zone: True} only where pinned offsets equal ICU's at EVERY UTC hour 1949-12-30 → 2026-01-03.

    Matching '2026c' labels are no proof: Ubuntu's system zoneinfo is built with
    backzone and differs before 1970 in 22 of the plan's zones.
    """
    todo = sorted(set(zones) - set(_PARITY))
    data = icu_segments(todo) if todo else {'zones': {}}
    for zone in todo:
        segments = (data or {}).get('zones', {}).get(zone)
        if not segments:
            _PARITY[zone] = False
            continue
        start = datetime.fromisoformat(data['startUTC'].replace('Z', '+00:00'))
        tz = pinned_zone(zone)
        bounds = [s[0] for s in segments[1:]] + [data['hours']]
        ok = True
        for (first, offset), end in zip(segments, bounds):
            for h in range(first, end):
                if int((start + timedelta(hours=h)).astimezone(tz).utcoffset().total_seconds()) != offset:
                    ok = False
                    break
            if not ok:
                break
        _PARITY[zone] = ok
    return {zone: _PARITY[zone] for zone in zones}

T0, P0 = 273.16, 611.65
E0V, E0S = 2.374e6, 0.3337e6
RA, RV = 287.04, 461.0
CVA, CVV, CVL, CVS = 719.0, 1418.0, 4119.0, 1861.0
CPA, CPV = CVA + RA, CVV + RV


def esat_liquid(t):
    if t <= 0:
        return 0.0
    return P0 * (t / T0) ** ((CPV - CVL) / RV) * math.exp((E0V - (CVV - CVL) * T0) / RV * (1 / T0 - 1 / t))


def esat_ice(t):
    if t <= 0:
        return 0.0
    return P0 * (t / T0) ** ((CPV - CVS) / RV) * math.exp((E0V + E0S - (CVV - CVS) * T0) / RV * (1 / T0 - 1 / t))


def qsat_liquid(p, t):
    if t <= 0:
        return 0.0
    es = esat_liquid(t)
    if es > p:
        return es / p
    return 1 / (RV * p / (RA * P0) * (T0 / t) ** ((CPV - CVL) / RV)
                * math.exp(-(E0V - (CVV - CVL) * T0) / RV * (1 / T0 - 1 / t)) - RV / RA + 1)


def bisect(fn, lo, hi, tol=1e-12):
    flo = fn(lo)
    if flo == 0:
        return lo
    for _ in range(200):
        mid = (lo + hi) / 2
        fmid = fn(mid)
        if fmid == 0 or hi - lo < tol:
            return mid
        if (fmid < 0) == (flo < 0):
            lo, flo = mid, fmid
        else:
            hi = mid
    return (lo + hi) / 2


def saturation_temperature(e):
    if e == 0:
        return 0.0
    hi = T0
    while esat_liquid(hi) < e:
        hi *= 1.25
    return bisect(lambda t: esat_liquid(t) - e, 1e-9, hi)


def wet_bulb_from_vapor(p, t, e):
    rv = RA * e / (RV * p - RV * e + RA * e)
    cp = (1 - rv) * CPA + rv * CPV
    lo = saturation_temperature(e)
    hi = min(t, saturation_temperature(p))

    def residual(tw):
        qs = qsat_liquid(p, tw)
        return cp * (tw - t) * (1 - qs) + (qs - rv) * (E0V + (CVV - CVL) * (tw - T0) + RV * tw)
    rlo, rhi = residual(lo), residual(hi)
    if rlo == 0:
        return lo
    if rhi == 0 or rlo * rhi > 0:
        return hi
    return bisect(residual, lo, hi)


def wet_bulb_rh(p, t, rh):
    es = esat_liquid(t) if t > T0 else esat_ice(t)
    return wet_bulb_from_vapor(p, t, rh * es)


def hourly_wet_bulb_c(row):
    t, d, p = row['temperatureK'], row['dewpointK'], row['pressurePa']
    return wet_bulb_from_vapor(p, t, esat_liquid(min(t, d))) - 273.15


# --- Vectorized path (NumPy, opt-in) -------------------------------------------------
# The same bisection algorithm as the scalar reference above, applied element-wise.
# Every verified group re-solves sampled hours with the scalar solver and must agree
# within VECTOR_CHECK_K, so the fast path can never silently replace the reference.
VECTOR_CHECK_K = 1e-9
VECTOR_SAMPLE_HOURS = 512


def _np():
    import numpy  # optional: the private research venv has it; scalar path needs nothing
    return numpy


def esat_liquid_vec(t):
    np = _np()
    safe = np.where(t > 0, t, T0)
    value = P0 * (safe / T0) ** ((CPV - CVL) / RV) * np.exp((E0V - (CVV - CVL) * T0) / RV * (1 / T0 - 1 / safe))
    return np.where(t > 0, value, 0.0)


def qsat_liquid_vec(p, t):
    np = _np()
    safe = np.where(t > 0, t, T0)
    es = esat_liquid_vec(safe)
    denom = (RV * p / (RA * P0) * (T0 / safe) ** ((CPV - CVL) / RV)
             * np.exp(-(E0V - (CVV - CVL) * T0) / RV * (1 / T0 - 1 / safe)) - RV / RA + 1)
    return np.where(t <= 0, 0.0, np.where(es > p, es / p, 1 / denom))


def bisect_vec(fn, lo, hi, tol=1e-12):
    """Element-wise twin of bisect(): same stopping rules, per-element freeze when done."""
    np = _np()
    lo, hi = lo.astype(float).copy(), hi.astype(float).copy()
    flo = fn(lo, np.ones(lo.shape, bool))
    result = np.where(flo == 0, lo, np.nan)
    active = flo != 0
    for _ in range(200):
        if not active.any():
            break
        mid = (lo + hi) / 2
        fmid = fn(mid, active)
        stop = active & ((fmid == 0) | (hi - lo < tol))
        result = np.where(stop, mid, result)
        active &= ~stop
        same = (fmid < 0) == (flo < 0)
        move_lo = active & same
        lo = np.where(move_lo, mid, lo)
        flo = np.where(move_lo, fmid, flo)
        hi = np.where(active & ~same, mid, hi)
    return np.where(active, (lo + hi) / 2, result)


def saturation_temperature_vec(e):
    np = _np()
    hi = np.full(e.shape, T0)
    grow = esat_liquid_vec(hi) < e
    while grow.any():
        hi = np.where(grow, hi * 1.25, hi)
        grow = esat_liquid_vec(hi) < e
    out = bisect_vec(lambda t, _m: esat_liquid_vec(t) - e, np.full(e.shape, 1e-9), hi)
    return np.where(e == 0, 0.0, out)


def wet_bulb_from_vapor_vec(p, t, e):
    np = _np()
    rv = RA * e / (RV * p - RV * e + RA * e)
    cp = (1 - rv) * CPA + rv * CPV
    lo = saturation_temperature_vec(e)
    hi = np.minimum(t, saturation_temperature_vec(p))

    def residual(tw, _m=None):
        qs = qsat_liquid_vec(p, tw)
        return cp * (tw - t) * (1 - qs) + (qs - rv) * (E0V + (CVV - CVL) * (tw - T0) + RV * tw)
    rlo, rhi = residual(lo), residual(hi)
    solved = bisect_vec(residual, lo, hi)
    return np.where(rlo == 0, lo, np.where((rhi == 0) | (rlo * rhi > 0), hi, solved))


def hourly_wet_bulb_c_vec(t, d, p):
    np = _np()
    with np.errstate(all='ignore'):  # frozen/inactive lanes may overflow; their values are discarded
        return wet_bulb_from_vapor_vec(p, t, esat_liquid_vec(np.minimum(t, d))) - 273.15


def load_tile_cell_arrays(tile_dir, manifest):
    """(UTC hour index, t, d, p) arrays for the manifest's cell from checksummed tile chunks."""
    np = _np()
    cell = manifest['gridCell']
    key = f'{cell[0]:.1f},{cell[1]:.1f}'
    stamps, triples = [], []
    for record in manifest['hourlyChunks']:
        head = json.loads((tile_dir / f"{record['chunk']}.json").read_text())
        raw = (tile_dir / f"{record['chunk']}.bin").read_bytes()
        if hashlib.sha256(raw).hexdigest() != record['sha256'] or head['sha256'] != record['sha256']:
            raise ValueError(f"{record['chunk']}: hourly chunk differs from the period's recorded provenance")
        cells, hours = head['cells'], head['hours']
        values = np.frombuffer(raw, dtype='<f4').reshape(hours, len(cells), 3)[:, cells.index(key), :].astype(float)
        start = int(datetime.fromisoformat(head['startUTC'].replace('Z', '+00:00')).timestamp()) // 3600
        stamps.append(np.arange(start, start + hours, dtype=np.int64))
        triples.append(values)
    stamps, triples = np.concatenate(stamps), np.concatenate(triples)
    if len(np.unique(stamps)) != len(stamps):
        raise ValueError('Duplicate UTC hour across chunks')
    finite = np.isfinite(triples).all(axis=1)
    return stamps[finite], triples[finite, 0], triples[finite, 1], triples[finite, 2]


def vector_wet_bulb_hours(stamps, t, d, p, sample_seed):
    """{UTC datetime: wet bulb °C} for every hour, after a scalar cross-check on sampled hours."""
    import random
    values = hourly_wet_bulb_c_vec(t, d, p)
    rng = random.Random(sample_seed)
    picks = rng.sample(range(len(stamps)), min(VECTOR_SAMPLE_HOURS, len(stamps)))
    for i in picks:
        scalar = hourly_wet_bulb_c({'temperatureK': float(t[i]), 'dewpointK': float(d[i]), 'pressurePa': float(p[i])})
        if not abs(scalar - float(values[i])) <= VECTOR_CHECK_K:
            raise ValueError(f'Vectorized solver disagrees with the scalar reference by {abs(scalar - float(values[i]))} K')
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    return {epoch + timedelta(hours=int(h)): float(v) for h, v in zip(stamps, values)}, len(picks)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def local_day_bounds(day, zone):
    start = datetime(day.year, day.month, day.day, tzinfo=zone).astimezone(timezone.utc)
    nxt = day + timedelta(days=1)
    end = datetime(nxt.year, nxt.month, nxt.day, tzinfo=zone).astimezone(timezone.utc)
    return start, end


def load_year(job_dir, cell_key):
    status = json.loads((job_dir / 'status.json').read_text())
    manifest_path = job_dir / 'normalized' / 'manifest.json'
    if sha(manifest_path) != status['normalizedManifestSha256']:
        raise ValueError(f'{job_dir.name}: normalized manifest checksum mismatch')
    manifest = json.loads(manifest_path.read_text())
    if set(manifest['files']) != {cell_key} or manifest.get('sourceSha256') != status['sourceSelectionSha256']:
        raise ValueError(f'{job_dir.name}: source cell/provenance join mismatch')
    record = manifest['files'][cell_key]
    raw = (job_dir / 'normalized' / record['file']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != record['sha256']:
        raise ValueError(f'{job_dir.name}: hourly input checksum mismatch')
    rows = [json.loads(line) for line in raw.decode().splitlines()]
    if len(rows) != record['hours']:
        raise ValueError(f'{job_dir.name}: hourly row count mismatch')
    return status, rows


def local_day_stamps(day, zone):
    """Every whole UTC hour whose instant falls on local calendar date `day`.

    Assigned by instant, exactly as the pipeline buckets hours, never by assuming a
    local date is one contiguous UTC span between two midnights: when a fallback
    happens just after midnight (Newfoundland ended DST at 00:01, 1987–2010) the date
    recurs after a one-minute sliver, so with a :30 offset the hour after the sliver
    belongs to the previous date although it lies between that date's midnights.
    The midnight bounds only pad the search window (a local date lasts ≤ 25 h and
    starts within an hour of its nominal midnight).
    """
    start, end = local_day_bounds(day, zone)
    at = start.replace(minute=0, second=0) - timedelta(hours=2)
    stop = end + timedelta(hours=2)
    stamps = []
    while at < stop:
        if at.astimezone(zone).date() == day:
            stamps.append(at)
        at += timedelta(hours=1)
    return stamps


def days_from_hours(hours, zone, year):
    """Complete local dates of local `year` from {UTC datetime: wet bulb °C}.

    Each day is (high, high UTC, hours, low, low UTC); ties go to the earliest hour.
    """
    days, partial, odd = {}, [], []
    day = date(year, 1, 1)
    while day.year == year:
        stamps = local_day_stamps(day, zone)
        expected = len(stamps)
        present = [s for s in stamps if s in hours]
        if expected and len(present) == expected:
            best = max(present, key=lambda s: (hours[s], -s.timestamp()))
            worst = min(present, key=lambda s: (hours[s], s.timestamp()))
            days[day.isoformat()] = (hours[best], best.strftime('%Y-%m-%dT%H:00:00.000Z'), expected,
                                     hours[worst], worst.strftime('%Y-%m-%dT%H:00:00.000Z'))
            if expected != 24:
                odd.append((day.isoformat(), expected))
        elif present:
            partial.append(day.isoformat())
        day += timedelta(days=1)
    return days, partial, odd


def wet_bulb_hours(rows, cell):
    hours = {}
    for row in rows:
        if row['gridCell'] != cell:
            raise ValueError('Hourly row crosses source cells')
        stamp = datetime.fromisoformat(row['timeUTC'].replace('Z', '+00:00'))
        if stamp in hours or stamp.minute or stamp.second:
            raise ValueError('Duplicate or non-hourly UTC timestamp')
        hours[stamp] = hourly_wet_bulb_c(row)
    return hours


def reduce_year(args):
    """Return complete local-date highs for one local year from its padded UTC window."""
    job_dir, cell, zone_name, year = args
    cell_key = f'{cell[0]:.1f},{cell[1]:.1f}'
    status, rows = load_year(Path(job_dir), cell_key)
    plan = status['plan']
    if plan['year'] != year or plan['timeZone'] != zone_name or plan['actualEra5LandCell'] != cell:
        raise ValueError(f'{Path(job_dir).name}: plan identity mismatch')
    return (year, *days_from_hours(wet_bulb_hours(rows, cell), pinned_zone(zone_name), year))


def reduce_rows_year(args):
    rows, cell, zone_name, year = args
    return (year, *days_from_hours(wet_bulb_hours(rows, cell), pinned_zone(zone_name), year))


def skipped_dates(zone_name, first, last):
    """Plain-calendar dates the zone never had (every real local date lasts ≥ 23 h)."""
    zone, seen = pinned_zone(zone_name), set()
    at = datetime.fromisoformat(first).replace(tzinfo=timezone.utc) - timedelta(hours=15)
    stop = datetime.fromisoformat(last).replace(tzinfo=timezone.utc) + timedelta(hours=39)
    while at <= stop:
        seen.add(at.astimezone(zone).date().isoformat())
        at += timedelta(hours=6)
    out, day = [], date.fromisoformat(first)
    while day <= date.fromisoformat(last):
        if day.isoformat() not in seen:
            out.append(day.isoformat())
        day += timedelta(days=1)
    return out


def python_tzdata_version():
    """IANA release of the pinned tree the verifier actually uses (not the system's)."""
    return tz_manifest()['iana']


def parallel_map(fn, jobs, workers):
    if workers <= 1:
        return [fn(job) for job in jobs]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(fn, jobs))


# Where each extremum lives in a day tuple and in the pipeline's period JSON.
EXTREMA = {
    'high': {'value': 0, 'time': 1, 'month': ('highC', 'highUTC', 'highLocalDate'), 'period': 'periodHigh', 'sign': 1},
    'low': {'value': 3, 'time': 4, 'month': ('lowC', 'lowUTC', 'lowLocalDate'), 'period': 'periodLow', 'sign': -1},
}


def compare_period(period, results, years, zone_name, extremum='high'):
    spec = EXTREMA[extremum]
    all_days, partial, odd = {}, [], []
    for _, days, p, o in results:
        all_days.update(days)
        partial += p
        odd += o
    by_key, months = defaultdict(list), defaultdict(list)
    key_hours, month_hours = defaultdict(int), defaultdict(int)
    for iso, value in all_days.items():
        item = (value[spec['value']], value[spec['time']], iso)
        by_key[iso[5:]].append(item)
        months[iso[5:7]].append(item)
        key_hours[iso[5:]] += value[2]
        month_hours[iso[5:7]] += value[2]
    sign = spec['sign']
    # Highest (or lowest) value; equal values go to the earliest hour.
    pick = lambda items: max(items, key=lambda v: (sign * v[0], -datetime.fromisoformat(v[1][:-5]).timestamp()))
    mismatches, ties = [], 0

    def compare(label, mine, theirs_value, theirs_time, theirs_date):
        nonlocal ties
        if abs(mine[0] - theirs_value) > 1e-6:
            mismatches.append({'key': label, 'independent': mine, 'pipeline': [theirs_value, theirs_time]})
        elif mine[1] != theirs_time or mine[2] != theirs_date:
            ties += 1  # equal within 1e-6 °C at two hours: solver-precision tie, value agrees
    for key, items in by_key.items():
        entry = period['daily'].get(key)
        if entry is None or entry['contributingYears'] != len(items):
            mismatches.append({'key': key, 'contributingYears': [len(items), entry and entry['contributingYears']]})
            continue
        compare(key, pick(items), entry['valueC'], entry['utcTime'], entry['localDate'])
    value_f, time_f, date_f = spec['month']
    for month, items in months.items():
        entry = period['monthly'].get(month)
        if entry is None:
            mismatches.append({'key': f'month-{month}', 'missing': True})
            continue
        compare(f'month-{month}', pick(items), entry[value_f], entry[time_f], entry[date_f])
    if set(period['monthly']) != set(months):
        mismatches.append({'key': 'months', 'independent': sorted(months), 'pipeline': sorted(period['monthly'])})
    top = pick([v for items in by_key.values() for v in items])
    extreme = period[spec['period']]
    compare('period', top, extreme['valueC'], extreme['utcTime'], extreme['localDate'])
    coverage = period['coverage']
    complete = sorted(all_days)
    skipped = skipped_dates(zone_name, coverage['firstComplete'], coverage['lastComplete'])
    span = (date.fromisoformat(coverage['lastComplete']) - date.fromisoformat(coverage['firstComplete'])).days + 1
    checks = {
        'calendarKeys': len(by_key) == len(period['daily']),
        'completeDays': len(all_days) == coverage['completeDays'],
        # A wholly missing local date (no hours at all) must still be caught:
        'spanFullyCovered': len(all_days) == span - len(skipped),
        'firstComplete': complete[0] == coverage['firstComplete'],
        # Local-day lengths (DST 23/25 h, offset changes) must agree, not just day counts:
        'dailyHours': all(period['daily'].get(k, {}).get('hours') == h for k, h in key_hours.items()),
        'monthlyHours': all(period['monthly'].get(m, {}).get('hours') == h for m, h in month_hours.items()),
        'lastComplete': complete[-1] == coverage['lastComplete'],
        'noInteriorPartial': all(d < coverage['firstComplete'] or d > coverage['lastComplete'] for d in partial),
        'leapDays': len(by_key.get('02-29', [])) == sum(1 for y in years if y % 4 == 0 and (y % 100 or y % 400 == 0)
                                                         and coverage['firstComplete'] <= f'{y}-02-29' <= coverage['lastComplete']
                                                         and f'{y}-02-29' not in skipped),
    }
    return {'completeDays': len(all_days), 'first': complete[0], 'last': complete[-1], 'skippedDates': skipped,
            'nonTwentyFourHourDays': len(odd), 'shortDays': sum(1 for _, h in odd if h == 23),
            'longDays': sum(1 for _, h in odd if h == 25), 'leapDayYears': len(by_key.get('02-29', [])),
            'valueMismatches': mismatches, 'equalValueTimeTies': ties, 'checks': checks,
            'ok': not mismatches and all(checks.values())}


def verify(period_dir, jobs_root, rank, workers):
    manifest = json.loads((period_dir / 'manifest.json').read_text())
    period_raw = (period_dir / 'period.json').read_bytes()
    if hashlib.sha256(period_raw).hexdigest() != manifest['periodSha256']:
        raise ValueError('Period checksum mismatch')
    period = json.loads(period_raw)
    cell, zone_name = manifest['gridCell'], manifest['timeZone']
    if period['gridCell'] != cell or period['timeZone'] != zone_name or period['path'] != manifest['path']:
        raise ValueError('Period identity join mismatch')
    years = list(range(manifest['startYear'], manifest['endYear'] + 1))
    digests = {d['year']: d['sha256'] for d in manifest['annualDigests']}
    jobs = []
    for year in years:
        job = jobs_root / f'r{rank:02d}-y{year}'
        if sha(job / 'annual.json') != digests[year]:
            raise ValueError(f'Annual digest mismatch for {year}')
        jobs.append((str(job), cell, zone_name, year))
    results = parallel_map(reduce_year, jobs, workers)
    return {'rank': rank, 'path': manifest['path'], 'timeZone': zone_name, 'gridCell': cell,
            **compare_period(period, results, years, zone_name)}


def load_tile_cell_rows(tile_dir, manifest):
    """Rows for the manifest's cell from checksummed tile chunks (float32 [hour][cell][t,d,p])."""
    cell = manifest['gridCell']
    key = f'{cell[0]:.1f},{cell[1]:.1f}'
    rows = []
    for record in manifest['hourlyChunks']:
        head = json.loads((tile_dir / f"{record['chunk']}.json").read_text())
        raw = (tile_dir / f"{record['chunk']}.bin").read_bytes()
        if hashlib.sha256(raw).hexdigest() != record['sha256'] or head['sha256'] != record['sha256']:
            raise ValueError(f"{record['chunk']}: hourly chunk differs from the period's recorded provenance")
        cells, hours = head['cells'], head['hours']
        values = struct.unpack(f'<{len(raw) // 4}f', raw)
        c = cells.index(key)
        start = datetime.fromisoformat(head['startUTC'].replace('Z', '+00:00'))
        for h in range(hours):
            t, d, p = values[(h * len(cells) + c) * 3:(h * len(cells) + c) * 3 + 3]
            if not all(math.isfinite(v) for v in (t, d, p)):
                continue
            rows.append({'timeUTC': (start + timedelta(hours=h)).strftime('%Y-%m-%dT%H:00:00.000Z'),
                         'temperatureK': t, 'dewpointK': d, 'pressurePa': p, 'gridCell': cell})
    return rows


def load_high_group(group_dir):
    manifest = json.loads((group_dir / 'manifest.json').read_text())
    period_raw = (group_dir / 'period.json').read_bytes()
    if hashlib.sha256(period_raw).hexdigest() != manifest['periodSha256']:
        raise ValueError('Period checksum mismatch')
    period = json.loads(period_raw)
    cell, zone_name = manifest['gridCell'], manifest['timeZone']
    if (period['gridCell'] != cell or period['timeZone'] != zone_name
            or manifest['groupKey'] != f'{cell[0]:.1f},{cell[1]:.1f}|{zone_name}' or period['groupKey'] != manifest['groupKey']):
        raise ValueError('Period identity join mismatch')
    for record in manifest['annualDigests']:
        if sha(group_dir / f"y{record['year']}.json") != record['sha256']:
            raise ValueError(f"Annual digest mismatch for {record['year']}")
    return manifest, period


LOW_SCHEMA = 'low-v1'
COVERAGE_KEYS = ('years', 'validHours', 'completeDays', 'firstComplete', 'lastComplete', 'partialDays')


def load_low_group(group_dir, manifest, high_period, expected_low_sha=None):
    """low-v1 companion, joined to the exact legacy high bytes and the same hourly chunks."""
    folder = group_dir / LOW_SCHEMA
    low_manifest = json.loads((folder / 'manifest.json').read_text())
    raw = (folder / 'period.json').read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != low_manifest['lowPeriodSha256'] or (expected_low_sha is not None and digest != expected_low_sha):
        raise ValueError('Low period checksum mismatch')
    low = json.loads(raw)
    joins = {
        'extremum': low_manifest.get('extremum') == 'low' == low.get('extremum'),
        'schema': low_manifest.get('lowSchema') == LOW_SCHEMA == low.get('lowSchema'),
        'identity': all(low_manifest.get(k) == manifest[k] and low.get(k, low_manifest.get(k)) == manifest[k]
                        for k in ('groupKey', 'gridCell', 'timeZone')),
        'highPeriodBytes': low_manifest.get('highPeriodSha256') == manifest['periodSha256'] == sha(group_dir / 'period.json'),
        'highManifestBytes': low_manifest.get('highManifestSha256') == sha(group_dir / 'manifest.json'),
        'sameHourlyChunks': low_manifest.get('hourlyChunks') == manifest['hourlyChunks'],
        'span': all(low_manifest.get(k) == manifest[k] for k in ('startYear', 'endYear', 'first', 'last', 'completeDays')),
        'provenance': low_manifest.get('sourcePinned') == manifest['sourcePinned'] and low.get('methodVersion') == high_period['methodVersion'],
        'notPublishable': low_manifest.get('publicationApproved') is False,
        'coverage': all(low['coverage'].get(k) == high_period['coverage'].get(k) for k in COVERAGE_KEYS),
    }
    if not all(joins.values()):
        raise ValueError(f"Low companion join mismatch: {sorted(k for k, v in joins.items() if not v)}")
    return low_manifest, low


def tile_group_results(manifest, tile_dir, workers, vectorized):
    """Independent per-year local-date extrema from the chunks the manifest names."""
    cell, zone_name = manifest['gridCell'], manifest['timeZone']
    years = list(range(manifest['startYear'], manifest['endYear'] + 1))
    sampled = 0
    if vectorized:
        # Every local date of `year` lies inside its padded UTC window, so one dict of all
        # hours answers exactly the lookups the per-year windows would.
        hours, sampled = vector_wet_bulb_hours(*load_tile_cell_arrays(Path(tile_dir), manifest), manifest['periodSha256'])
        zone = pinned_zone(zone_name)
        return [(year, *days_from_hours(hours, zone, year)) for year in years], years, sampled
    rows = load_tile_cell_rows(Path(tile_dir), manifest)
    jobs = []
    for year in years:
        lo = f'{year - 1}-12-31T00:00:00.000Z'
        hi = f'{year + 1}-01-02T23:00:00.000Z'
        jobs.append(([r for r in rows if lo <= r['timeUTC'] <= hi], cell, zone_name, year))
    return parallel_map(reduce_rows_year, jobs, workers), years, sampled


def verify_tile_group(group_dir, tile_dir, workers, vectorized=False):
    """Independent check of a tile-pipeline high period (reduce-tile-chunks.mjs output)."""
    return verify_tile_group_extrema(group_dir, tile_dir, workers, vectorized, ('high',))[0]


def verify_tile_group_extrema(group_dir, tile_dir, workers, vectorized=False, extrema=('high', 'low'), expected_low_sha=None,
                              parity=None):
    """High and/or low verdict rows for one group from ONE independent hourly recomputation.

    `parity`: precomputed zone_parity() result for this group's zone (computed here if None).
    """
    group_dir = Path(group_dir)
    manifest, period = load_high_group(group_dir)
    low_manifest = low = None
    if 'low' in extrema:
        low_manifest, low = load_low_group(group_dir, manifest, period, expected_low_sha)
    results, years, sampled = tile_group_results(manifest, tile_dir, workers, vectorized)
    zone_name = manifest['timeZone']
    if parity is None:
        parity = zone_parity([zone_name])[zone_name]
    tz = {'python': python_tzdata_version(), 'pipeline': manifest.get('tzdata'), 'source': TZ_SOURCE, 'icuParity': parity}
    # Same release label AND the same hourly offsets as the pipeline's ICU for this zone.
    tz_ok = tz['python'] is not None and tz['python'] == tz['pipeline'] and parity is True
    solver = {'mode': 'vectorized', 'scalarCrossChecks': sampled} if vectorized else {'mode': 'scalar'}
    rows = []
    if 'high' in extrema:
        result = compare_period(period, results, years, zone_name)
        result['ok'] = result['ok'] and tz_ok
        # The digest binds this verdict to the exact period bytes, so later accounting can
        # never credit a verification to a period that was rebuilt or replaced since.
        rows.append({'groupKey': manifest['groupKey'], 'periodSha256': manifest['periodSha256'], 'tzdata': tz,
                     'tzSource': TZ_SOURCE, 'solver': solver, 'tzdataMatches': tz_ok, **result})
    if 'low' in extrema:
        result = compare_period(low, results, years, zone_name, 'low')
        tz_low = tz_ok and low_manifest.get('tzdata') == manifest.get('tzdata')
        result['ok'] = result['ok'] and tz_low
        # No `periodSha256` key: high-only readers can never mistake a low verdict for a high one.
        rows.append({'extremum': 'low', 'lowSchema': LOW_SCHEMA, 'groupKey': manifest['groupKey'],
                     'lowPeriodSha256': low_manifest['lowPeriodSha256'], 'highPeriodSha256': manifest['periodSha256'],
                     'tzdata': tz, 'tzSource': TZ_SOURCE, 'solver': solver, 'tzdataMatches': tz_low, **result})
    return rows


def failed_low_row(group_key, low_sha, reason):
    return {'extremum': 'low', 'lowSchema': LOW_SCHEMA, 'groupKey': group_key, 'lowPeriodSha256': low_sha,
            'ok': False, 'error': str(reason)[:500]}


def previously_verified(paths, extremum='high'):
    """(groupKey, digest) pairs that already passed in earlier verifier output.

    High rows are keyed by periodSha256 (legacy shape); low rows by lowPeriodSha256.
    Only verdicts made with the pinned timezone tree count: earlier output used the
    system's backzone build, which differs from the pipeline in 22 plan zones.
    """
    field = 'periodSha256' if extremum == 'high' else 'lowPeriodSha256'
    done = set()
    for path in paths:
        for line in Path(path).read_text().splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue  # a half-written line from a live run; skipping it can only re-verify
            if row.get('extremum', 'high') != extremum:
                continue
            if row.get('ok') is True and row.get('groupKey') and row.get(field) and row.get('tzSource') == TZ_SOURCE:
                done.add((row['groupKey'], row[field]))
    return done


def reference_vectors(path):
    data = json.loads(Path(path).read_text())
    worst = max(abs(wet_bulb_rh(v['pressurePa'], v['airTemperatureK'], v['relativeHumidity']) - v['wetBulbK'])
                for v in data['vectors'])
    return len(data['vectors']), worst


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--periods', type=Path, help='PR #41 period folders (rNN-y1950-2025)')
    p.add_argument('--jobs', type=Path, help='PR #41 per-year job folders')
    p.add_argument('--rank', type=int, action='append', default=[])
    p.add_argument('--tile-run', type=Path, help='run_tile_backfill.py --out folder; verifies every period')
    p.add_argument('--source', default='archive')
    p.add_argument('--vectors', type=Path, default=Path(__file__).resolve().parents[2] / 'tests/fixtures/romps-reference-vectors.v1.json')
    p.add_argument('--workers', type=int, default=3)
    p.add_argument('--skip-verified', type=Path, action='append', default=[],
                   help='Earlier --tile-run output; groups that passed with the same period digest are not recomputed')
    p.add_argument('--vectorized', action='store_true',
                   help='NumPy element-wise bisection, cross-checked against the scalar solver on sampled hours')
    p.add_argument('--cold-vectors', type=Path,
                   default=Path(__file__).resolve().parents[2] / 'tests/fixtures/romps-reference-vectors-cold.v1.json',
                   help='190–262 K heatindex 0.0.2 vectors; required before any low is verified')
    p.add_argument('--extrema', choices=('high', 'low', 'both'), default='both',
                   help='--tile-run: which extrema to verify; with lows, a sealed tile lacking them fails')
    a = p.parse_args()
    count, worst = reference_vectors(a.vectors)
    if worst > 1e-6:
        raise SystemExit(f'Independent Romps solver disagrees with heatindex vectors by {worst} K')
    header = {'referenceVectors': count, 'maxAbsErrorK': worst}
    if a.tile_run and a.extrema != 'high':
        cold, cold_worst = reference_vectors(a.cold_vectors)
        if cold_worst > 1e-6:
            raise SystemExit(f'Independent Romps solver disagrees with cold heatindex vectors by {cold_worst} K')
        header.update(coldReferenceVectors=cold, coldMaxAbsErrorK=cold_worst)
    print(json.dumps(header), flush=True)
    failed = False
    for rank in a.rank:
        result = verify(a.periods / f'r{rank:02d}-y1950-2025', a.jobs, rank, a.workers)
        failed |= not result['ok']
        print(json.dumps(result), flush=True)
    if a.tile_run:
        want_low = a.extrema in ('low', 'both')
        tiles, low_tiles = {}, {}
        for status_path in sorted((a.tile_run / 'tiles' / a.source).glob('t*/status.json')):
            for period in json.loads(status_path.read_text())['periods']:
                tiles[period['groupKey']] = status_path.parent
            if not want_low:
                continue
            low_path = status_path.with_name('low-status.json')
            if not low_path.exists():
                # Fail closed: a sealed tile without lows is a coverage gap, never a silent skip.
                failed = True
                print(json.dumps({'extremum': 'low', 'tile': status_path.parent.name, 'ok': False,
                                  'error': 'sealed tile has no low-status.json (low coverage absent)'}), flush=True)
                continue
            low_status = json.loads(low_path.read_text())
            listed = ([e['groupKey'] for e in low_status.get('lowPeriods', [])]
                      + [e['groupKey'] for e in low_status.get('failedLowGroups', [])])
            sealed = {e['groupKey'] for e in json.loads(status_path.read_text())['periods']}
            if len(listed) != len(set(listed)) or set(listed) != sealed:
                failed = True
                print(json.dumps({'extremum': 'low', 'tile': status_path.parent.name, 'ok': False,
                                  'error': 'low-status.json groups differ from the sealed periods (low coverage absent)'}),
                      flush=True)
                continue
            if low_status.get('highStatusSha256') != sha(status_path) or low_status.get('lowSchema') != LOW_SCHEMA:
                failed = True
                print(json.dumps({'extremum': 'low', 'tile': status_path.parent.name, 'ok': False,
                                  'error': 'low-status.json is not bound to this sealed status.json'}), flush=True)
                continue
            for entry in low_status['failedLowGroups']:
                failed = True
                print(json.dumps(failed_low_row(entry['groupKey'], None, f"pipeline low failed: {entry['reason']}")), flush=True)
            for entry in low_status['lowPeriods']:
                low_tiles[entry['groupKey']] = (status_path.parent, entry['lowPeriodSha256'])
        done = previously_verified(a.skip_verified) if a.extrema in ('high', 'both') else None
        done_low = previously_verified(a.skip_verified, 'low') if want_low else None
        pending = []
        for manifest_path in sorted((a.tile_run / 'groups' / a.source).glob('*/manifest.json')):
            manifest = json.loads(manifest_path.read_text())
            key = manifest['groupKey']
            if key not in tiles:
                continue  # its tile has not been sealed yet; verify after the tile completes
            extrema = []
            if done is not None and (key, manifest['periodSha256']) not in done:
                extrema.append('high')
            if want_low and key in low_tiles and (key, low_tiles[key][1]) not in done_low:
                extrema.append('low')
            if extrema:
                pending.append((manifest_path.parent, tiles[key], tuple(extrema), low_tiles.get(key, (None, None))[1]))
        zones = sorted({key.split('|', 1)[1] for key in tiles})
        parity = zone_parity(zones)
        print(json.dumps({'tzSource': TZ_SOURCE, 'tzTreeSha256': tz_manifest()['treeSha256'], 'zones': len(zones),
                          'icuParityFailures': sorted(z for z, ok in parity.items() if not ok)}), flush=True)
        zone_of = lambda group: json.loads((group / 'manifest.json').read_text())['timeZone']
        if a.vectorized and a.workers > 1:
            # One group per process; each group is single-threaded NumPy.
            from concurrent.futures import as_completed
            with ProcessPoolExecutor(max_workers=a.workers) as pool:
                futures = [pool.submit(verify_tile_group_extrema, group, tile, 1, True, extrema, low_sha, parity[zone_of(group)])
                           for group, tile, extrema, low_sha in pending]
                for future in as_completed(futures):
                    for result in future.result():
                        failed |= not result['ok']
                        print(json.dumps(result), flush=True)
        else:
            for group, tile, extrema, low_sha in pending:
                for result in verify_tile_group_extrema(group, tile, a.workers, a.vectorized, extrema, low_sha,
                                                        parity[zone_of(group)]):
                    failed |= not result['ok']
                    print(json.dumps(result), flush=True)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
