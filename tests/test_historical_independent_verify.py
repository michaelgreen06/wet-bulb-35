import hashlib
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = spec_from_file_location('verify', ROOT / 'scripts/historical-wetbulb/verify_period_independent.py')
MOD = module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


def job(root, cell, zone, year, *, drop=None):
    """Synthetic PR #41-shaped year (test fixture only, never data)."""
    folder = Path(root) / f'r02-y{year}'
    (folder / 'normalized').mkdir(parents=True)
    rows, at = [], datetime(year - 1, 12, 31, tzinfo=timezone.utc)
    while at <= datetime(year + 1, 1, 2, 23, tzinfo=timezone.utc):
        if at != drop:
            rows.append({'timeUTC': at.strftime('%Y-%m-%dT%H:00:00.000Z'), 'temperatureK': 295 + (at.hour % 7),
                         'dewpointK': 290.0, 'pressurePa': 100000.0, 'gridCell': cell})
        at += timedelta(hours=1)
    body = ''.join(json.dumps(r) + '\n' for r in rows).encode()
    key = f'{cell[0]:.1f},{cell[1]:.1f}'
    manifest = {'files': {key: {'file': 'c.ndjson', 'sha256': hashlib.sha256(body).hexdigest(), 'hours': len(rows)}},
                'sourceSha256': 's' * 64}
    (folder / 'normalized' / 'c.ndjson').write_bytes(body)
    (folder / 'normalized' / 'manifest.json').write_text(json.dumps(manifest))
    status = {'plan': {'year': year, 'timeZone': zone, 'actualEra5LandCell': cell}, 'sourceSelectionSha256': 's' * 64,
              'normalizedManifestSha256': hashlib.sha256((folder / 'normalized' / 'manifest.json').read_bytes()).hexdigest()}
    (folder / 'status.json').write_text(json.dumps(status))
    return folder


class TestIndependentVerifier(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_bisection_romps_matches_heatindex_reference_vectors(self):
        count, worst = MOD.reference_vectors(ROOT / 'tests/fixtures/romps-reference-vectors.v1.json')
        self.assertEqual(count, 500)
        self.assertLess(worst, 1e-9)

    def test_half_hour_offset_days_use_every_utc_hour_inside_local_midnights(self):
        folder = job(self.tmp.name, [28.6, 77.2], 'Asia/Kolkata', 2021)
        _, days, partial, odd = MOD.reduce_year((str(folder), [28.6, 77.2], 'Asia/Kolkata', 2021))
        self.assertEqual((len(days), partial, odd), (365, [], []))
        self.assertTrue(days['2021-01-01'][1].startswith('2020-12-31T') or days['2021-01-01'][1].startswith('2021-01-01T'))

    def test_dst_dates_have_23_and_25_hours(self):
        folder = job(self.tmp.name, [40.7, -74.0], 'America/New_York', 2021)
        _, days, _, odd = MOD.reduce_year((str(folder), [40.7, -74.0], 'America/New_York', 2021))
        self.assertEqual(odd, [('2021-03-14', 23), ('2021-11-07', 25)])
        self.assertEqual(days['2021-03-14'][2], 23)

    def test_missing_hour_makes_only_its_local_date_partial(self):
        drop = datetime(2021, 6, 1, 12, tzinfo=timezone.utc)
        folder = job(self.tmp.name, [40.7, -74.0], 'America/New_York', 2021, drop=drop)
        _, days, partial, _ = MOD.reduce_year((str(folder), [40.7, -74.0], 'America/New_York', 2021))
        self.assertEqual(partial, ['2021-06-01'])
        self.assertEqual(len(days), 364)

    def test_checksum_and_identity_joins_fail_closed(self):
        folder = job(self.tmp.name, [40.7, -74.0], 'America/New_York', 2021)
        with self.assertRaisesRegex(ValueError, 'identity'):
            MOD.reduce_year((str(folder), [40.7, -74.0], 'America/Chicago', 2021))
        (folder / 'normalized' / 'c.ndjson').write_text('{}\n')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            MOD.reduce_year((str(folder), [40.7, -74.0], 'America/New_York', 2021))

    def test_a_wholly_missing_local_date_fails_even_if_counts_agree(self):
        days = {}
        day = datetime(2021, 1, 1)
        while day.year == 2021:
            iso = day.date().isoformat()
            if iso != '2021-06-01':  # no hours at all for this date
                days[iso] = (20.0 + day.timetuple().tm_yday / 1000, f'{iso}T12:00:00.000Z', 24)
            day += timedelta(days=1)
        period = {'daily': {}, 'monthly': {}, 'coverage': {'completeDays': len(days), 'firstComplete': '2021-01-01',
                                                            'lastComplete': '2021-12-31'}}
        for iso, (v, t, _) in days.items():
            period['daily'][iso[5:]] = {'valueC': v, 'utcTime': t, 'localDate': iso, 'contributingYears': 1}
            month = period['monthly'].get(iso[5:7])
            if not month or v > month['highC']:
                period['monthly'][iso[5:7]] = {'highC': v, 'highUTC': t, 'highLocalDate': iso}
        top = max(days.items(), key=lambda kv: kv[1][0])
        period['periodHigh'] = {'valueC': top[1][0], 'utcTime': top[1][1], 'localDate': top[0]}
        result = MOD.compare_period(period, [(2021, days, [], [])], [2021], 'UTC')
        self.assertTrue(result['checks']['completeDays'])
        self.assertFalse(result['checks']['spanFullyCovered'])
        self.assertFalse(result['ok'])

    def test_skipped_zone_dates_are_known(self):
        self.assertEqual(MOD.skipped_dates('Pacific/Apia', '2011-01-01', '2011-12-31'), ['2011-12-30'])
        self.assertEqual(MOD.skipped_dates('UTC', '2011-01-01', '2011-12-31'), [])


if __name__ == '__main__':
    unittest.main()
