#!/usr/bin/env python3
"""Independently recompute a private research period from retained hourly inputs.

Separate from the Node pipeline on purpose: Python zoneinfo local-day bounds
(not Intl adjacency checks), a bisection Romps solver (not Brent) validated
against the heatindex 0.0.2 reference vectors, and its own checksum/identity
joins. Compares calendar-day, monthly and period highs plus coverage. No network.
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


def days_from_hours(hours, zone, year):
    """Complete local-date highs for local `year` from {UTC datetime: wet bulb °C}."""
    days, partial, odd = {}, [], []
    day = date(year, 1, 1)
    while day.year == year:
        start, end = local_day_bounds(day, zone)
        # Every whole UTC hour whose instant falls in [local midnight, next local
        # midnight); with :30/:45 offsets the first sample is after midnight.
        first = start.replace(minute=0, second=0) + (timedelta(hours=1) if start.minute or start.second else timedelta())
        stamps = []
        while first < end:
            stamps.append(first)
            first += timedelta(hours=1)
        expected = len(stamps)
        present = [s for s in stamps if s in hours]
        if expected and len(present) == expected:
            best = max(present, key=lambda s: (hours[s], -s.timestamp()))
            days[day.isoformat()] = (hours[best], best.strftime('%Y-%m-%dT%H:00:00.000Z'), expected)
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
    return (year, *days_from_hours(wet_bulb_hours(rows, cell), ZoneInfo(zone_name), year))


def reduce_rows_year(args):
    rows, cell, zone_name, year = args
    return (year, *days_from_hours(wet_bulb_hours(rows, cell), ZoneInfo(zone_name), year))


def skipped_dates(zone_name, first, last):
    """Plain-calendar dates the zone never had (every real local date lasts ≥ 23 h)."""
    zone, seen = ZoneInfo(zone_name), set()
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
    for base in ('/usr/share/zoneinfo/tzdata.zi',):
        try:
            head = Path(base).read_text().split('\n', 1)[0]
            return head.removeprefix('# version ').strip() or None
        except OSError:
            continue
    try:
        import importlib.metadata
        return importlib.metadata.version('tzdata')
    except Exception:
        return None


def parallel_map(fn, jobs, workers):
    if workers <= 1:
        return [fn(job) for job in jobs]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(fn, jobs))


def compare_period(period, results, years, zone_name):
    all_days, partial, odd = {}, [], []
    for _, days, p, o in results:
        all_days.update(days)
        partial += p
        odd += o
    by_key, months = defaultdict(list), defaultdict(list)
    for iso, value in all_days.items():
        by_key[iso[5:]].append((value[0], value[1], iso))
        months[iso[5:7]].append((value[0], value[1], iso))
    pick = lambda items: max(items, key=lambda v: (v[0], -datetime.fromisoformat(v[1][:-5]).timestamp()))
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
    for month, items in months.items():
        entry = period['monthly'][month]
        compare(f'month-{month}', pick(items), entry['highC'], entry['highUTC'], entry['highLocalDate'])
    top = pick([v for items in by_key.values() for v in items])
    compare('period', top, period['periodHigh']['valueC'], period['periodHigh']['utcTime'], period['periodHigh']['localDate'])
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


def verify_tile_group(group_dir, tile_dir, workers, vectorized=False):
    """Independent check of a tile-pipeline period (reduce-tile-chunks.mjs output)."""
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
    years = list(range(manifest['startYear'], manifest['endYear'] + 1))
    sampled = 0
    if vectorized:
        # Every local date of `year` lies inside its padded UTC window, so one dict of all
        # hours answers exactly the lookups the per-year windows would.
        hours, sampled = vector_wet_bulb_hours(*load_tile_cell_arrays(Path(tile_dir), manifest), manifest['periodSha256'])
        zone = ZoneInfo(zone_name)
        results = [(year, *days_from_hours(hours, zone, year)) for year in years]
    else:
        rows = load_tile_cell_rows(Path(tile_dir), manifest)
        jobs = []
        for year in years:
            lo = f'{year - 1}-12-31T00:00:00.000Z'
            hi = f'{year + 1}-01-02T23:00:00.000Z'
            jobs.append(([r for r in rows if lo <= r['timeUTC'] <= hi], cell, zone_name, year))
        results = parallel_map(reduce_rows_year, jobs, workers)
    tz = {'python': python_tzdata_version(), 'pipeline': manifest.get('tzdata')}
    result = compare_period(period, results, years, zone_name)
    tz_ok = tz['python'] is not None and tz['python'] == tz['pipeline']  # unknown on both sides is no evidence
    result['ok'] = result['ok'] and tz_ok
    # The digest binds this verdict to the exact period bytes, so later accounting can
    # never credit a verification to a period that was rebuilt or replaced since.
    return {'groupKey': manifest['groupKey'], 'periodSha256': manifest['periodSha256'], 'tzdata': tz,
            'solver': {'mode': 'vectorized', 'scalarCrossChecks': sampled} if vectorized else {'mode': 'scalar'},
            'tzdataMatches': tz_ok, **result}


def previously_verified(paths):
    """(groupKey, periodSha256) pairs that already passed in earlier verifier output."""
    done = set()
    for path in paths:
        for line in Path(path).read_text().splitlines():
            row = json.loads(line)
            if row.get('ok') is True and row.get('groupKey') and row.get('periodSha256'):
                done.add((row['groupKey'], row['periodSha256']))
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
    a = p.parse_args()
    count, worst = reference_vectors(a.vectors)
    if worst > 1e-6:
        raise SystemExit(f'Independent Romps solver disagrees with heatindex vectors by {worst} K')
    print(json.dumps({'referenceVectors': count, 'maxAbsErrorK': worst}), flush=True)
    failed = False
    for rank in a.rank:
        result = verify(a.periods / f'r{rank:02d}-y1950-2025', a.jobs, rank, a.workers)
        failed |= not result['ok']
        print(json.dumps(result), flush=True)
    if a.tile_run:
        tiles = {}
        for status_path in sorted((a.tile_run / 'tiles' / a.source).glob('t*/status.json')):
            for period in json.loads(status_path.read_text())['periods']:
                tiles[period['groupKey']] = status_path.parent
        done = previously_verified(a.skip_verified)
        for manifest_path in sorted((a.tile_run / 'groups' / a.source).glob('*/manifest.json')):
            manifest = json.loads(manifest_path.read_text())
            key = manifest['groupKey']
            if key not in tiles:
                continue  # its tile has not been sealed yet; verify after the tile completes
            if (key, manifest['periodSha256']) in done:
                continue
            result = verify_tile_group(manifest_path.parent, tiles[key], a.workers, a.vectorized)
            failed |= not result['ok']
            print(json.dumps(result), flush=True)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
