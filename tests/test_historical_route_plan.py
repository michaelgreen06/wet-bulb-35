import hashlib
import json
import tempfile
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts/historical-wetbulb'


def load(name):
    spec = spec_from_file_location(name.removesuffix('.py'), SCRIPTS / name)
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PLAN = load('plan_all_routes.py')
GRID = load('era5land_grid.py')


def route(i, lat, lon):
    return {'sourceIndex': i, 'name': f'c{i}', 'latitude': lat, 'longitude': lon,
            'countrySlug': 'x', 'stateSlug': 'y', 'outputCitySlug': f'c{i}'}


class TestRoutePlan(unittest.TestCase):
    def setUp(self):
        self.routes = [route(0, -6.21, 106.84), route(1, -6.22, 106.83), route(2, 13.09, 80.28),
                       route(3, 50.0, 10.0), route(4, 50.01, 10.01), route(5, 0.5, 0.5),
                       route(6, 29.76, -95.36), route(7, 12.35, 1.0), route(8, 60.0, -100.0)]
        zones = ['Asia/Jakarta', 'Asia/Jakarta', 'Asia/Kolkata', 'Europe/Berlin', 'Europe/Berlin', 'UTC',
                 'America/Chicago', 'Africa/Niamey', 'America/Winnipeg']
        self.ids = [{'path': PLAN.route_path(r), 'id': 100 + i, 'timeZone': zones[i], 'status': 'exact'}
                    for i, r in enumerate(self.routes)]
        self.ids[5] = {'path': PLAN.route_path(self.routes[5]), 'id': None, 'timeZone': None, 'status': 'unmatched'}
        self.ids[4]['id'] = self.ids[3]['id']  # ambiguous: one GeoNames ID claimed by two routes
        jakarta = GRID.cell_key(GRID.map_coordinate(-6.21, 106.84)['cell'])
        houston = GRID.cell_key(GRID.map_coordinate(29.76, -95.36)['cell'])
        self.research = {f'{jakarta}|Asia/Jakarta': {'years': set(range(1950, 2026)), 'period': {
            'path': '/p/', 'startYear': 1950, 'endYear': 2025, 'firstComplete': '1950-01-03', 'lastComplete': '2025-12-31',
            'completeDays': 27757, 'periodSha256': 'a' * 64, 'researchOnly': True, 'dir': '/x'}},
            f'{houston}|America/Chicago': {'years': {1950, 1951, 1952}, 'period': None}}
        self.masks = {GRID.cell_key(GRID.map_coordinate(13.09, 80.28)['cell']): 'masked'}

    def classify(self, approvals=None):
        return PLAN.classify(self.routes, self.ids, ranked_paths=[PLAN.route_path(self.routes[i]) for i in (2, 0, 3)],
                             research=self.research, masks=self.masks, approvals=approvals or {},
                             varied_tiles_per_region=1, batch_tiles=1)

    def test_every_route_gets_exactly_one_reasoned_status(self):
        rows = self.classify()
        status = [r['status'] for r in rows]
        self.assertEqual(status, ['research-complete-unpublished', 'research-complete-unpublished', 'unavailable-masked-cell',
                                  'unavailable-identity-ambiguous', 'unavailable-identity-ambiguous', 'unavailable-identity-unmatched',
                                  'unavailable-incomplete-period', 'pending-acquisition', 'pending-acquisition'])
        self.assertTrue(rows[7]['gridTie'])
        self.assertEqual(rows[7]['cell'], [12.4, 1.0])
        summary = PLAN.summarize(rows, total_hours=672_744)
        self.assertEqual(sum(summary['statusCounts'].values()), len(self.routes))
        self.assertEqual(summary['reviewQueue']['unavailable-masked-cell'], [rows[2]['path']])
        self.assertEqual(summary['timeChunksPerTile'], 20)

    def test_supported_only_with_named_approval_for_the_exact_period(self):
        good = {'scope': 'publish-modeled-history', 'periodSha256': 'a' * 64, 'approvedBy': 'Michael',
                'approvedAt': '2026-10-05', 'acceptsResearchProvenance': True}
        self.assertEqual(self.classify({'a' * 64: good})[0]['status'], 'supported')
        for change in ({'periodSha256': 'b' * 64}, {'scope': 'other'}, {'approvedBy': ' '}, {'approvedAt': None},
                       {'acceptsResearchProvenance': False}):
            self.assertEqual(self.classify({'a' * 64: {**good, **change}})[0]['status'], 'research-complete-unpublished', change)

    def test_tiles_take_their_earliest_stage_and_regions_get_varied_batches(self):
        rows = self.classify()
        by_path = {r['path']: r for r in rows}
        self.assertEqual(by_path[PLAN.route_path(self.routes[0])]['stage'], 'pilot')
        self.assertEqual(by_path[PLAN.route_path(self.routes[6])]['stage'], 'pilot')
        self.assertEqual({rows[7]['stage'], rows[8]['stage']}, {'varied-regions'})
        self.assertIsNone(rows[2]['stage'])

    def test_identity_order_drift_is_refused(self):
        self.ids[0], self.ids[1] = self.ids[1], self.ids[0]
        with self.assertRaises(ValueError):
            self.classify()

    def test_research_scan_rejects_tampered_period(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / 'r02'
            folder.mkdir()
            period = json.dumps({'coverage': {'years': [1950], 'firstComplete': '1950-01-03', 'lastComplete': '1950-12-31',
                                              'completeDays': 363}, 'timeZone': 'UTC', 'researchOnly': True})
            (folder / 'period.json').write_text(period)
            manifest = {'periodSha256': hashlib.sha256(period.encode()).hexdigest(), 'gridCell': [1.0, 2.0],
                        'timeZone': 'UTC', 'path': '/p/', 'startYear': 1950, 'endYear': 1950}
            (folder / 'manifest.json').write_text(json.dumps(manifest))
            self.assertIn('1.0,2.0|UTC', PLAN.scan_research([tmp]))
            (folder / 'period.json').write_text(period + ' ')
            with self.assertRaises(ValueError):
                PLAN.scan_research([tmp])

    def test_private_plan_cannot_be_written_into_git(self):
        with self.assertRaises(ValueError):
            PLAN.private_write(PLAN.REPO / 'plan.json', {})


if __name__ == '__main__':
    unittest.main()
