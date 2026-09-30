import unittest
from importlib.util import spec_from_file_location,module_from_spec
from pathlib import Path
SPEC=spec_from_file_location('audit',Path(__file__).resolve().parents[1]/'scripts/historical-wetbulb/survey_mask_batch.py')
assert SPEC and SPEC.loader
MODULE=module_from_spec(SPEC);SPEC.loader.exec_module(MODULE)

class TestSurvey(unittest.TestCase):
 def test_single_cell_complete_or_masked_and_partial_fails(self):
  m={'schemaVersion':1,'researchOnly':True,'sourceSelection':{'start':'1950-02-28','end':'1950-03-01'},
      'files':{'13.1,80.2':{'hours':48}},'maskedCells':[],'hours':48,'cells':1}
  self.assertEqual(MODULE.classify(m,'13.1,80.2'),'valid')
  m['files']={};m['maskedCells']=['13.1,80.2'];m['hours']=0;m['cells']=0
  self.assertEqual(MODULE.classify(m,'13.1,80.2'),'masked')
  m['hours']=12
  with self.assertRaises(ValueError):MODULE.classify(m,'13.1,80.2')
 def test_one_bounded_batch_and_unknowns_explicit(self):
  rows=[{'rank':i,'actualEra5LandCell':[13.1,80.2],'requestCoordinate':[13.1,80.2]} for i in range(1,51)]
  self.assertEqual([r['rank'] for r in MODULE.plan_batch(rows,from_rank=11,count=10)],list(range(11,21)))
  with self.assertRaises(ValueError):MODULE.plan_batch(rows,from_rank=1,count=50)
  with self.assertRaises(ValueError):MODULE.plan_batch(rows,from_rank=0,count=1)

if __name__=='__main__':unittest.main()
