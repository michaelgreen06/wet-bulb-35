import csv
import io
import tempfile
import unittest
import zipfile
from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path

SPEC=spec_from_file_location('city_index',Path(__file__).resolve().parents[1]/'scripts/historical-wetbulb/build_city_index.py')
assert SPEC is not None and SPEC.loader is not None
MODULE=module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def geoname(id,name,lat,lon,code,timezone,alternate=''):
    fields=['']*19
    for position,value in {0:id,1:name,2:name,3:alternate,4:lat,5:lon,6:'P',7:'PPL',8:code,14:1000,17:timezone}.items():
        fields[position]=str(value)
    return '\t'.join(fields)+'\n'

class TestCityIndex(unittest.TestCase):
    def test_exact_and_alternate_match_preserve_route_identity_and_flag_ambiguous_or_missing(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'source.zip'
            records=''.join([
              geoname(1,'Alpha',10,20,'AA','Etc/UTC'),
              geoname(2,'Beta',11.001,21.001,'AA','Etc/UTC','Béta'),
              geoname(3,'Twin',12,22,'AA','Etc/UTC'),
              geoname(4,'Twin',12.001,22.001,'AA','Etc/UTC'),
              geoname(5,'Border',13,23,'BB','Etc/UTC'),
            ])
            with zipfile.ZipFile(p,'w') as z:z.writestr('cities1000.txt',records)
            cities=[{'name':n,'latitude':lat,'longitude':lon,'resolvedCountryName':'A'} for n,lat,lon in [('Alpha',10,20),('Béta',11,21),('Twin',12.0004,22.0004),('Missing',0,0),('Border',13,23)]]
            route={'rows':[{'sourceIndex':i,'countrySlug':'a','stateSlug':'s','outputCitySlug':f'city-{i}',
                            'name':city['name'],'latitude':city['latitude'],'longitude':city['longitude']}
                           for i,city in enumerate(cities)]}
            code={'A':'AA'}
            result=MODULE.build_index(cities,route,p,code)
            self.assertEqual(result['counts'],{'exact':1,'alternate':1,'ambiguous':1,'unmatched':2})
            self.assertEqual(result['rows'][0]['id'],1)
            self.assertEqual(result['rows'][0]['path'],'/wetbulb-temperature/a/s/city-0/')
            self.assertEqual(result['rows'][1]['id'],2)
            self.assertEqual(result['rows'][2]['status'],'ambiguous')
            self.assertEqual(result['rows'][4]['status'],'unmatched')
    def test_never_chooses_a_different_nearby_city_by_coordinate_alone(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'source.zip'
            with zipfile.ZipFile(p,'w') as z:z.writestr('cities1000.txt',geoname(9,'Another',10,20,'AA','Etc/UTC'))
            city=[{'name':'Alpha','latitude':10,'longitude':20,'resolvedCountryName':'A'}]
            route={'rows':[{'sourceIndex':0,'countrySlug':'a','stateSlug':'s','outputCitySlug':'alpha',
                            'name':'Alpha','latitude':10,'longitude':20}]}
            result=MODULE.build_index(city,route,p,{'A':'AA'})
            self.assertEqual(result['counts']['unmatched'],1)

if __name__=='__main__':unittest.main()
