import tempfile
import unittest
from unittest import mock
from importlib.util import spec_from_file_location,module_from_spec
from pathlib import Path
SPEC=spec_from_file_location('arco_map',Path(__file__).resolve().parents[1]/'scripts/historical-wetbulb/map_arco_cohort.py')
assert SPEC and SPEC.loader
MODULE=module_from_spec(SPEC);SPEC.loader.exec_module(MODULE)

class TestArcoCohort(unittest.TestCase):
 def test_uses_actual_cell_and_tile_indices_not_coordinate_rounding(self):
  cohort={'schemaVersion':1,'count':3,'rows':[
   {'rank':1,'path':'/a/','geoNamesId':12,'timeZone':'Asia/Singapore','requestCoordinate':[1.36,103.82],'actualEra5LandCell':None},
   {'rank':2,'path':'/b/','geoNamesId':13,'timeZone':'Asia/Singapore','requestCoordinate':[1.39,103.89],'actualEra5LandCell':None},
   {'rank':3,'path':'/c/','geoNamesId':14,'timeZone':'Etc/UTC','requestCoordinate':[1.39,103.89],'actualEra5LandCell':None}]}
  lat=[1.4,1.3,1.2,1.1,1.0];lon=[103.8,103.9,104.0,104.1,104.2,104.3,104.4,104.5,104.6]
  result=MODULE.map_cohort(cohort,lat,lon,lat,lon,chunk_lat=4,chunk_lon=8)
  self.assertEqual(result['rows'][0]['actualEra5LandCell'],[1.4,103.8])
  self.assertEqual(result['rows'][1]['actualEra5LandCell'],[1.4,103.9])
  self.assertEqual(result['rows'][2]['actualEra5LandCell'],[1.4,103.9])
  self.assertEqual(result['rows'][0]['tile'],[0,0])
  self.assertEqual(result['tileCount'],1)
  self.assertEqual(result['cellCount'],2)
  self.assertEqual(result['cellTimezoneCount'],3)
  self.assertTrue(result['researchOnly'])
 def test_metadata_fetch_rejects_untrusted_origin_without_network(self):
  with mock.patch.object(MODULE.urllib.request,'urlopen',side_effect=AssertionError('network must not be reached')):
   with self.assertRaises(ValueError):MODULE.metadata('https://example.invalid/redirect','fake-token')
 def test_mismatched_pressure_grid_or_out_of_range_fails(self):
  c={'schemaVersion':1,'count':1,'rows':[{'rank':1,'path':'/a/','geoNamesId':1,'timeZone':'Etc/UTC','requestCoordinate':[1.35,103.85],'actualEra5LandCell':None}]}
  with self.assertRaises(ValueError):MODULE.map_cohort(c,[1.4,1.3],[103.8,103.9],[1.4,1.2],[103.8,103.9],chunk_lat=4,chunk_lon=8)
  c['rows'][0]['requestCoordinate']=[55,103.85]
  with self.assertRaises(ValueError):MODULE.map_cohort(c,[1.4,1.3],[103.8,103.9],[1.4,1.3],[103.8,103.9],chunk_lat=4,chunk_lon=8)

if __name__=='__main__':unittest.main()
