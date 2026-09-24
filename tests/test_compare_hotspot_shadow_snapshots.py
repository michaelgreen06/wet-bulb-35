import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "compare-hotspot-shadow-snapshots.py"
SPEC = importlib.util.spec_from_file_location("compare_hotspot_shadow_snapshots", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ShadowComparisonTests(unittest.TestCase):
    def test_compares_normalized_grid_coordinates_and_candidate_paths(self):
        def grid(source, cells):
            return {
                "model": {
                    "source": source,
                    "initialization": "2026-09-23T12:00:00Z",
                    "validTimeBounds": {"start": "2026-09-23T20:00:00Z", "end": "2026-09-24T19:00:00Z"},
                    "evaluatedCellCount": 100,
                },
                "cells": cells,
            }
        ifs_grid = grid("ecmwf-ifs-0.25", [
            {"latitude": 10, "longitude": -90, "wetBulbC": 30},
            {"latitude": 20, "longitude": 80, "wetBulbC": 29},
        ])
        gfs_grid = grid("noaa-gfs-0.25", [
            {"latitude": 10, "longitude": 270, "wetBulbC": 29.5},
            {"latitude": 30, "longitude": 70, "wetBulbC": 28},
        ])
        ifs_candidates = {"cities": [{"path": "/a/"}, {"path": "/b/"}]}
        gfs_candidates = {"cities": [{"path": "/b/"}, {"path": "/c/"}]}
        result = MODULE.compare_documents(ifs_grid, gfs_grid, ifs_candidates, gfs_candidates)
        self.assertEqual(result["globalGrid"]["top20Overlap"], 1)
        self.assertEqual(result["inhabitedCandidates"], {
            "ifs": 2, "gfs": 2, "overlap": 1, "ifsOnly": 1, "gfsOnly": 1,
        })
        self.assertEqual(result["window"]["start"], "2026-09-23T20:00:00Z")


if __name__ == "__main__":
    unittest.main()
