import tempfile
import unittest
import zipfile
from io import BytesIO
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec

SPEC=spec_from_file_location('cds_download',Path(__file__).resolve().parents[1]/'scripts/historical-wetbulb/download_cds.py')
assert SPEC is not None and SPEC.loader is not None
MODULE=module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

class FakeClient:
    def __init__(self,cost=75,status='successful'):
        self.cost=cost;self.status=status;self.requests=[]
        b=BytesIO()
        with zipfile.ZipFile(b,'w') as z:z.writestr('sample.csv','x,y\n1,2\n')
        self.sample=b.getvalue()
    def estimate_costs(self,dataset,request):
        self.requests.append((dataset,request))
        return {'cost':self.cost,'limit':500}
    def submit(self,dataset,request):
        self.requests.append((dataset,request))
        return type('Remote',(),{'request_id':'job-123','status':self.status})()
    def get_remote(self,request_id):
        request=self.requests[-1][1] if self.requests else None
        return type('Remote',(),{'request_id':request_id,'status':self.status,
                                 'collection_id':'reanalysis-era5-land-timeseries','request':request})()
    def get_results(self,request_id):
        sample=self.sample
        class Result:
            json={'asset':{'value':{'file:size':len(sample)}}}
            def download(self,target):Path(target).write_bytes(sample)
        return Result()

class TestCDSDownloader(unittest.TestCase):
    def test_request_is_bounded_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            c=FakeClient();dest=Path(tmp)/'one.zip'
            r=MODULE.download_bounded(c,location=(33.4484,-112.074),start='1950-02-28',end='1950-03-01',target=dest)
            self.assertEqual(r['jobId'],'job-123');self.assertEqual(dest.read_bytes(),c.sample)
            dataset,request=c.requests[0]
            self.assertEqual(dataset,'reanalysis-era5-land-timeseries')
            self.assertEqual(request['variable'],['2m_temperature','2m_dewpoint_temperature','surface_pressure'])
            self.assertEqual(request['date'],['1950-02-28/1950-03-01'])
            with self.assertRaises(ValueError):MODULE.download_bounded(c,location=(33.4484,-112.074),start='1950-02-28',end='1950-03-01',target=dest)
    def test_no_submission_when_over_cost_or_too_many_dates_or_large_area(self):
        with tempfile.TemporaryDirectory() as tmp:
            c=FakeClient(cost=501)
            with self.assertRaises(ValueError):MODULE.download_bounded(c,location=(33,-112),start='1950-01-02',end='1950-01-04',target=Path(tmp)/'a')
            self.assertEqual(len(c.requests),1)
            with self.assertRaises(ValueError):MODULE.download_bounded(c,location=(float('nan'),-112),start='1950-01-02',end='1950-01-04',target=Path(tmp)/'nan')
            with self.assertRaises(ValueError):MODULE.download_bounded(c,location=(33,-112),start='1950-01-02',end='1952-01-04',target=Path(tmp)/'b')
            with self.assertRaises(ValueError):MODULE.download_bounded(c,area=[33.5,-112.5,32.5,-111.5],start='1950-01-02',end='1950-01-03',target=Path(tmp)/'c')
            self.assertEqual(len(c.requests),1)
    def test_pending_job_does_not_create_or_replace_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            c=FakeClient(status='accepted');dest=Path(tmp)/'one.zip'
            r=MODULE.download_bounded(c,location=(33,-112),start='1950-01-02',end='1950-01-03',target=dest)
            self.assertEqual(r['status'],'accepted');self.assertFalse(dest.exists())

    def test_resume_job_must_match_exact_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            c=FakeClient(status='accepted');dest=Path(tmp)/'one.zip'
            first=MODULE.download_bounded(c,location=(33,-112),start='1950-01-02',end='1950-01-03',target=dest)
            self.assertEqual(first['status'],'accepted')
            with self.assertRaises(ValueError):
                MODULE.download_bounded(c,location=(33,-111),start='1950-01-02',end='1950-01-03',target=dest,resume_job='job-123')
            c.status='successful'
            done=MODULE.download_bounded(c,location=(33,-112),start='1950-01-02',end='1950-01-03',target=dest,resume_job='job-123')
            self.assertEqual(done['status'],'successful')

if __name__=='__main__':unittest.main()
