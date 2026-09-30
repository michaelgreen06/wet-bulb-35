import json
import tempfile
import unittest
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
SPEC=spec_from_file_location('top10',Path(__file__).resolve().parents[1]/'scripts/historical-wetbulb/run_top10_backfill.py')
assert SPEC and SPEC.loader
MOD=module_from_spec(SPEC);SPEC.loader.exec_module(MOD)

class TestTop10Backfill(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.base=Path(self.tmp.name)
  self.rows=[{'rank':i,'path':f'/city/{i}/','actualEra5LandCell':[float(i),1.0],'timeZone':'UTC'} for i in range(1,51)]
  self.mapped={'schemaVersion':1,'count':50,'researchOnly':True,'actualEra5LandCellMappingVerified':True,'rows':self.rows}
  self.survey=self.base/'survey'
  for row in self.rows:
   rank=row['rank'];key=f'{float(rank):.1f},1.0';folder=self.survey/f'r{rank:02d}';folder.mkdir(parents=True)
   masked=rank in (1,10,28,30,39,50)
   manifest={'schemaVersion':1,'researchOnly':True,'sourceSelection':{'start':'1950-02-28','end':'1950-03-01'},
             'files':{} if masked else {key:{'hours':48}},'maskedCells':[key] if masked else [],
             'hours':0 if masked else 48,'cells':0 if masked else 1}
   (folder/'manifest.json').write_text(json.dumps(manifest))
 def test_first_ten_valid_ranked_and_bounded(self):
  ranks=MOD.select_ten(self.mapped,self.survey)
  self.assertEqual([x['rank'] for x in ranks],[2,3,4,5,6,7,8,9,11,12])
  jobs=MOD.plan_jobs(ranks,start_year=1950,end_year=2025)
  self.assertEqual(len(jobs),760)
  self.assertEqual(jobs[0],(2,1950));self.assertEqual(jobs[-1],(12,2025))
 def test_missing_or_partial_survey_and_year_overrun_rejected(self):
  (self.survey/'r02'/'manifest.json').unlink()
  with self.assertRaises(ValueError):MOD.select_ten(self.mapped,self.survey)
  with self.assertRaises(ValueError):MOD.plan_jobs(self.rows[:10],start_year=1950,end_year=2026)
  with self.assertRaises(ValueError):MOD.plan_jobs(self.rows[:10],start_year=1949,end_year=2025)
 def test_expected_daily_coverage_and_no_missing_interior_days(self):
  self.assertEqual(MOD.coverage_dates(1950,'1950-01-03','1950-12-31'),363)
  self.assertEqual(MOD.coverage_dates(1952,'1952-01-01','1952-12-31'),366)
  with self.assertRaises(ValueError):MOD.coverage_dates(1951,'1951-01-01','1951-12-30')
  with self.assertRaises(ValueError):MOD.coverage_dates(1951,'1951-02-01','1951-12-31')

if __name__=='__main__':unittest.main()
