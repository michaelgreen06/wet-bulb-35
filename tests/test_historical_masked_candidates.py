import tempfile
import unittest
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
SPEC=spec_from_file_location('candidates',Path(__file__).resolve().parents[1]/'scripts/historical-wetbulb/review_masked_cells.py')
assert SPEC and SPEC.loader
MODULE=module_from_spec(SPEC);SPEC.loader.exec_module(MODULE)

class TestCandidateReport(unittest.TestCase):
 def test_closest_valid_grid_cell_is_a_review_candidate_not_an_automatic_substitution(self):
  city={'rank':1,'path':'/wetbulb-temperature/india/tamil-nadu/chennai/',
        'requestCoordinate':[13.08784,80.27847],'actualEra5LandCell':[13.1,80.3],'timeZone':'Asia/Kolkata'}
  manifest={'schemaVersion':1,'researchOnly':True,'sourceSelection':{'start':'1950-02-28','end':'1950-03-01'},
    'files':{'13.1,80.2':{'hours':48},'13.0,80.2':{'hours':48}},'maskedCells':['13.1,80.3']}
  result=MODULE.candidate_report(city,manifest,max_km=15)
  self.assertEqual(result['status'],'review-required')
  self.assertEqual(result['nearestValidCell'],[13.1,80.2])
  self.assertTrue(8 < result['distanceKm'] < 9)
  self.assertEqual(result['publishedCell'],None)
  self.assertEqual(result['requestedCell'],[13.1,80.3])
 def test_adjacent_tile_candidate_needs_independent_origin_mask_proof(self):
  city={'rank':39,'path':'/rio/','requestCoordinate':[-22.90642,-43.18223],
        'actualEra5LandCell':[-22.9,-43.2],'timeZone':'America/Sao_Paulo'}
  source={'schemaVersion':1,'researchOnly':True,'sourceSelection':{'start':'1950-02-28','end':'1950-03-01'},
          'files':{},'maskedCells':['-22.9,-43.2']}
  candidate={'schemaVersion':1,'researchOnly':True,'sourceSelection':source['sourceSelection'],
             'files':{'-22.9,-43.1':{'hours':48}},'maskedCells':[]}
  with self.assertRaises(ValueError):MODULE.candidate_report(city,candidate,max_km=15)
  result=MODULE.candidate_report(city,candidate,max_km=15,origin_manifest=source)
  self.assertEqual(result['nearestValidCell'],[-22.9,-43.1]);self.assertEqual(result['status'],'review-required')
  with self.assertRaises(ValueError):MODULE.candidate_report(city,candidate,max_km=15,
    origin_manifest={**source,'sourceSelection':{'start':'1951-01-01','end':'1951-01-02'}})
 def test_fails_for_nonmasked_city_short_sample_and_no_candidate(self):
  city={'rank':1,'path':'/a/','requestCoordinate':[1.3,103.9],'actualEra5LandCell':[1.3,103.9],'timeZone':'UTC'}
  source={'schemaVersion':1,'researchOnly':True,'sourceSelection':{'start':'1950-01-02','end':'1950-01-03'},
          'files':{'1.3,103.8':{'hours':2}},'maskedCells':['1.3,103.9']}
  with self.assertRaises(ValueError):MODULE.candidate_report(city,source,max_km=15)
  source['files']['1.3,103.8']['hours']=48
  self.assertEqual(MODULE.candidate_report(city,source,max_km=1)['status'],'unavailable')
  source['maskedCells']=[]
  with self.assertRaises(ValueError):MODULE.candidate_report(city,source,max_km=15)

if __name__=='__main__':unittest.main()
