import tempfile
import unittest
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec

SPEC=spec_from_file_location('arco',Path(__file__).resolve().parents[1]/'scripts/historical-wetbulb/extract_arco_tile.py')
assert SPEC is not None and SPEC.loader is not None
MODULE=module_from_spec(SPEC);SPEC.loader.exec_module(MODULE)

class TestARCO(unittest.TestCase):
    def test_join_same_hour_and_cell_with_missing_land_mask(self):
        times=['1950-01-02T00:00:00.000Z','1950-01-02T01:00:00.000Z']
        cells=[(33.4,-112.1),(33.4,-112.0)]
        t=[[293,294],[292,293]];d=[[280,281],[279,280]];p=[[97000,None],[97100,None]]
        rows,masked=MODULE.align_tile_hours(times,cells,t,d,p)
        self.assertEqual(set(rows),{'33.4,-112.1'})
        self.assertEqual(len(rows['33.4,-112.1']),2)
        self.assertEqual(rows['33.4,-112.1'][0]['pressurePa'],97000)
        self.assertEqual(masked,['33.4,-112.0'])
    def test_only_selected_cell_is_materialized_and_missing_selection_fails(self):
        times=['1950-01-02T00:00:00.000Z','1950-01-02T01:00:00.000Z']
        cells=[(33.4,-112.1),(33.4,-112.0)]
        t=[[293,294],[292,293]];d=[[280,281],[279,280]];p=[[97000,97001],[97100,97101]]
        rows,masked=MODULE.align_tile_hours(times,cells,t,d,p,target_cells=[(33.4,-112.1)])
        self.assertEqual(list(rows),['33.4,-112.1']);self.assertEqual(masked,[])
        with self.assertRaises(ValueError):
            MODULE.align_tile_hours(times,cells,t,d,p,target_cells=[(10,10)])
        self.assertEqual(MODULE.local_year_window(1952),('1951-12-31','1953-01-02'))
        self.assertEqual(MODULE.local_year_window(1950),('1950-01-02','1951-01-02'))
    def test_misaligned_or_partial_cell_is_rejected(self):
        times=['1950-01-02T00:00:00.000Z','1950-01-02T01:00:00.000Z']
        cells=[(33.4,-112.1)]
        with self.assertRaises(ValueError):
            MODULE.align_tile_hours(times,cells,[[293],[292]],[[280],[279]],[[97000]])
        with self.assertRaises(ValueError):
            MODULE.align_tile_hours(times,cells,[[293],[292]],[[280],[279]],[[97000],[None]])
        with self.assertRaises(ValueError):
            MODULE.align_tile_hours(times,cells,[[293],[292]],[[280],[279]],[[97000],[97100]],pressure_times=['1950-01-02T02:00:00.000Z']*2)

if __name__=='__main__':unittest.main()
