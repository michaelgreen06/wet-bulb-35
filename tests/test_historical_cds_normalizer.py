import csv
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec

SPEC = spec_from_file_location('normalizer', Path(__file__).resolve().parents[1] / 'scripts/historical-wetbulb/normalize_cds.py')
assert SPEC is not None and SPEC.loader is not None
MODULE = module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def archive(path, *, mismatch=False, missing=False):
    temp = io.StringIO()
    pressure = io.StringIO()
    t = csv.writer(temp)
    p = csv.writer(pressure)
    t.writerow(['valid_time','latitude','longitude','d2m','t2m'])
    p.writerow(['valid_time','latitude','longitude','sp'])
    for h in range(3):
        for lon in (-112.1, -112.0):
            time=f'1950-02-28 {h:02}:00:00'
            t.writerow([time,33.4,lon,282,298])
            p.writerow([time if not mismatch or h else '1950-02-28 04:00:00',33.4,lon,'' if missing else 97000])
    with zipfile.ZipFile(path,'w') as z:
        z.writestr('reanalysis-era5-land-timeseries-sfc-2m-temperatureabc.csv',temp.getvalue())
        z.writestr('reanalysis-era5-land-timeseries-sfc-pressure-precipitationdef.csv',pressure.getvalue())


class TestNormalizer(unittest.TestCase):
    def test_separate_groups_join_by_same_time_and_cell_then_partition(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'sample.zip'
            archive(source)
            out=Path(directory)/'private'
            manifest=MODULE.normalize_archive(source,out)
            self.assertEqual(manifest['hours'],6)
            self.assertEqual(manifest['cells'],2)
            self.assertEqual(set(manifest['files']),{'33.4,-112.1','33.4,-112.0'})
            self.assertEqual(manifest['files']['33.4,-112.1']['hours'],3)
            rows=(out / manifest['files']['33.4,-112.1']['file']).read_text().splitlines()
            import json
            first=json.loads(rows[0])
            self.assertEqual(first,{'timeUTC':'1950-02-28T00:00:00.000Z','temperatureK':298.0,'dewpointK':282.0,'pressurePa':97000.0,'gridCell':[33.4,-112.1]})
            self.assertEqual(len(rows),3)
            self.assertFalse(any('/' in f['file'] or '..' in f['file'] for f in manifest['files'].values()))
    def test_fails_closed_for_misaligned_time_or_missing_pressure(self):
        with tempfile.TemporaryDirectory() as directory:
            for name,opts in [('mismatch',{'mismatch':True}),('missing',{'missing':True})]:
                source=Path(directory)/(name+'.zip');archive(source,**opts)
                with self.assertRaises(ValueError):MODULE.normalize_archive(source,Path(directory)/name)

if __name__ == '__main__': unittest.main()
