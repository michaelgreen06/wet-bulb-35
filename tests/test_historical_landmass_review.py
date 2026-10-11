import unittest
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
SPEC=spec_from_file_location('landmass',Path(__file__).resolve().parents[1]/'scripts/historical-wetbulb/review_landmass.py')
assert SPEC and SPEC.loader
MODULE=module_from_spec(SPEC);SPEC.loader.exec_module(MODULE)

def rectangle(w,s,e,n):return (w,s,e,n)
def covers(rect,lon,lat):return rect[0]<=lon<=rect[2] and rect[1]<=lat<=rect[3]

class TestLandmass(unittest.TestCase):
 def setUp(self):
  self.city={'rank':1,'path':'/a/','geoNamesId':10,'requestCoordinate':[1.30,103.85],
             'actualEra5LandCell':[1.3,103.9]}
  self.report={'rank':1,'path':'/a/','status':'review-required','requestedCell':[1.3,103.9],
               'nearestValidCell':[1.3,103.8],'distanceKm':5.6,'publishedCell':None}
  self.admin=[('Singapore','sg-main',rectangle(103.75,1.25,103.95,1.4)),
              ('Malaysia','my-main',rectangle(103.75,1.4,104,1.5))]
  self.land=[('land','island-main',rectangle(103.75,1.25,103.95,1.4)),
             ('land','malaysia-main',rectangle(103.75,1.4,104,1.5))]
 def test_same_country_and_island_within_bound_is_eligible_not_published(self):
  result=MODULE.review_landmass(self.city,self.report,self.admin,self.land,contains=covers,
    connects=lambda geom,start,end:covers(geom,*start) and covers(geom,*end))
  self.assertEqual(result['status'],'eligible-for-manual-review')
  self.assertEqual(result['publishedCell'],None)
  self.assertEqual(result['candidateCell'],[1.3,103.8])
  self.assertEqual(result['country'],'Singapore')
  self.assertEqual(result['landComponent'],'island-main')
 def test_different_land_component_country_or_too_far_is_rejected(self):
  for admin,land,report in [
   (self.admin,[('land','island-other',rectangle(103.75,1.25,103.82,1.4)),('land','island-main',rectangle(103.82,1.25,103.95,1.4))],self.report),
   ([('Malaysia','my-main',rectangle(103.75,1.25,103.82,1.4)),('Singapore','sg-main',rectangle(103.82,1.25,103.95,1.4))],self.land,self.report),
   (self.admin,self.land,{**self.report,'nearestValidCell':[2.0,104.2],
       'distanceKm':MODULE.distance_km(1.3,103.85,2.0,104.2)}),
  ]:
   with self.subTest(report=report):
    self.assertEqual(MODULE.review_landmass(self.city,report,admin,land,contains=covers,
      connects=lambda geom,start,end:covers(geom,*start) and covers(geom,*end))['status'],'rejected')
 def test_report_must_match_masked_nearest_source_and_never_prepublish(self):
  for report in [{**self.report,'path':'/changed/'},{**self.report,'publishedCell':[1.3,103.8]},
                 {**self.report,'requestedCell':[1.3,103.8]}]:
   with self.assertRaises(ValueError):MODULE.review_landmass(self.city,report,self.admin,self.land,
     contains=covers,connects=lambda geom,start,end:True)
 def test_connected_landmass_is_not_enough_if_straight_path_crosses_a_bay(self):
  result=MODULE.review_landmass(self.city,self.report,self.admin,self.land,
    contains=covers,connects=lambda geom,start,end:False)
  self.assertEqual(result['status'],'rejected')

if __name__=='__main__':unittest.main()
