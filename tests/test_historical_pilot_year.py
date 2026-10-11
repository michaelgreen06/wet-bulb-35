import unittest
import tempfile
import json
from datetime import date
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
SPEC=spec_from_file_location('pilot_one',Path(__file__).resolve().parents[1]/'scripts/historical-wetbulb/run_pilot_year.py')
assert SPEC and SPEC.loader
MODULE=module_from_spec(SPEC);SPEC.loader.exec_module(MODULE)

class TestPilotYear(unittest.TestCase):
 def setUp(self):
  self.m={'schemaVersion':1,'count':1,'researchOnly':True,'actualEra5LandCellMappingVerified':True,
    'sourceMetadataSha256':{'temperature':'a'*64,'pressure':'b'*64},
    'rows':[{'rank':1,'path':'/wetbulb-temperature/test/test/test/','geoNamesId':42,
             'timeZone':'Asia/Kolkata','requestCoordinate':[13.087,80.278],
             'actualEra5LandCell':[13.1,80.3],'tile':[1,2],'cellDataVerified':False}]}
 def test_one_rank_one_padded_year_only(self):
  plan=MODULE.plan_one(self.m,rank=1,year=1952,today=date(2026,9,29))
  self.assertEqual(plan['start'],'1951-12-31')
  self.assertEqual(plan['end'],'1953-01-02')
  self.assertEqual(plan['cellKey'],'13.1,80.3')
  self.assertTrue(plan['researchOnly'])
  self.assertEqual(MODULE.plan_one(self.m,rank=1,year=1950,today=date(2026,9,29))['start'],'1950-01-02')
 def test_resume_rechecks_normalized_source_before_claiming_completed(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);cohort=root/'cohort.json';cohort.write_text(json.dumps(self.m))
   work=root/'r01-y1952';normalized=work/'normalized';normalized.mkdir(parents=True)
   manifest=normalized/'manifest.json';manifest.write_text('{}')
   annual=work/'annual.json';annual.write_text('{}')
   plan=MODULE.plan_one(self.m,rank=1,year=1952,today=date(2026,9,29))
   status={'plan':plan,'cohortSha256':MODULE.digest(cohort),'status':'complete',
           'annualSha256':MODULE.digest(annual),'normalizedManifestSha256':MODULE.digest(manifest)}
   (work/'status.json').write_text(json.dumps(status))
   manifest.write_text('{"tampered":true}')
   with self.assertRaises(ValueError):MODULE.run_one(self.m,cohort,rank=1,year=1952,out=root)
 def test_rejects_future_or_incomplete_year_and_unmapped_cells(self):
  for year in (1949,2026,2101):
   with self.assertRaises(ValueError):MODULE.plan_one(self.m,rank=1,year=year,today=date(2026,9,29))
  with self.assertRaises(ValueError):MODULE.plan_one(self.m,rank=2,year=1952,today=date(2026,9,29))
  self.m['rows'][0]['actualEra5LandCell']=None
  with self.assertRaises(ValueError):MODULE.plan_one(self.m,rank=1,year=1952,today=date(2026,9,29))

if __name__=='__main__':unittest.main()
