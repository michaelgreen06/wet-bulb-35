import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "generate-ecmwf-hotspot-candidates.py"
SPEC = importlib.util.spec_from_file_location("ecmwf_hotspots", SCRIPT)
assert SPEC and SPEC.loader
HOTSPOTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOTSPOTS)


class NativeGridHotspotCandidateTests(unittest.TestCase):
    def setUp(self):
        self.latitudes = np.array([1.0, 0.75, 0.5])
        self.longitudes = np.array([-0.25, 0.0, 0.25, 0.5])
        self.land_mask = np.array(
            [
                [1.0, 1.0, 0.0, 1.0],
                [1.0, 1.0, 1.0, 1.0],
                [1.0, 1.0, 1.0, 1.0],
            ]
        )
        self.steps = {
            0: {
                "temperature_k": np.full((3, 4), 303.15),
                "dew_point_k": np.full((3, 4), 300.15),
                "pressure_pa": np.full((3, 4), 101325.0),
                "valid_time": "2026-09-22T00:00:00Z",
            },
            3: {
                "temperature_k": np.full((3, 4), 303.15),
                "dew_point_k": np.full((3, 4), 300.15),
                "pressure_pa": np.full((3, 4), 101325.0),
                "valid_time": "2026-09-22T03:00:00Z",
            },
        }
        # The ocean cell is hotter than every land cell and must not set the maximum.
        self.steps[0]["temperature_k"][0, 2] = 310.15
        self.steps[0]["dew_point_k"][0, 2] = 310.15
        self.steps[0]["temperature_k"][1, 1] = 308.15
        self.steps[0]["dew_point_k"][1, 1] = 306.15
        self.steps[3]["temperature_k"][2, 3] = 307.15
        self.steps[3]["dew_point_k"][2, 3] = 306.15

    def test_discovery_retains_land_peak_threshold_and_dilated_city_cells(self):
        candidates = HOTSPOTS.discover_candidates_from_arrays(
            latitudes=self.latitudes,
            longitudes=self.longitudes,
            land_mask=self.land_mask,
            steps=self.steps,
            cities=[
                {"path": "/peak/", "name": "Peak", "state": "", "country": "Test", "latitude": 0.75, "longitude": 0.0},
                {"path": "/neighbor/", "name": "Neighbor", "state": "", "country": "Test", "latitude": 0.75, "longitude": -0.25},
                {"path": "/threshold/", "name": "Threshold", "state": "", "country": "Test", "latitude": 0.5, "longitude": 0.5},
                {"path": "/excluded/", "name": "Excluded", "state": "", "country": "Test", "latitude": 1.0, "longitude": -0.25},
            ],
            model={"source": "ecmwf", "run": "20260922T000000Z", "steps": [0, 3]},
            margin_c=0.01,
            threshold_c=HOTSPOTS.wet_bulb_celsius(101325.0, 307.15, 306.15) - 0.01,
            dilation_rings=1,
        )

        self.assertEqual(candidates["schemaVersion"], 1)
        self.assertEqual(candidates["method"], "romps-thermodynamic-liquid")
        self.assertEqual(candidates["discoveryBoundary"], "three-hourly-native-grid-candidate-discovery-not-final-hourly-ranking")
        self.assertEqual(candidates["globalLandMaximum"]["peakStep"], 0)
        self.assertEqual(candidates["globalLandMaximum"]["latitude"], 0.75)
        self.assertEqual(candidates["globalLandMaximum"]["longitude"], 0.0)
        self.assertGreater(candidates["globalLandMaximum"]["wetBulbC"], 30.0)
        self.assertEqual([city["path"] for city in candidates["cities"]], ["/excluded/", "/neighbor/", "/peak/", "/threshold/"])
        peak = next(city for city in candidates["cities"] if city["path"] == "/peak/")
        self.assertEqual(peak["gridCell"]["peakStep"], 0)
        self.assertEqual(peak["gridCell"]["peakTime"], "2026-09-22T00:00:00Z")
        self.assertEqual(peak["gridCell"]["latitude"], 0.75)
        self.assertEqual(peak["gridCell"]["longitude"], 0.0)

    def test_nearest_grid_mapping_handles_antimeridian_and_latitude_order(self):
        row, column = HOTSPOTS.nearest_grid_cell(
            np.array([1.0, 0.75, 0.5]), np.array([-180.0, -179.75, 179.5, 179.75]), 0.62, -179.9
        )
        self.assertEqual((row, column), (2, 0))
        row, column = HOTSPOTS.nearest_grid_cell(
            np.array([1.0, 0.75, 0.5]), np.array([-180.0, -179.75, 179.5, 179.75]), 0.88, 179.9
        )
        self.assertEqual((row, column), (0, 0))

    def test_validate_rejects_invalid_city_and_nonfinite_grid_value(self):
        with self.assertRaisesRegex(ValueError, "city"):
            HOTSPOTS.validate_city_manifest([{"path": "/bad/"}])
        with self.assertRaisesRegex(ValueError, "finite"):
            HOTSPOTS.discover_candidates_from_arrays(
                latitudes=self.latitudes,
                longitudes=self.longitudes,
                land_mask=self.land_mask,
                steps={
                    0: {
                        "temperature_k": np.full((3, 4), np.nan),
                        "dew_point_k": np.full((3, 4), 300.15),
                        "pressure_pa": np.full((3, 4), 101325.0),
                        "valid_time": "2026-09-22T00:00:00Z",
                    }
                },
                cities=[],
                model={"source": "ecmwf", "run": "20260922T000000Z", "steps": [0]},
            )

    def test_cli_writes_deterministic_validated_json_from_npz_fixture(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            arrays_path = temporary / "fixture.npz"
            cities_path = temporary / "cities.json"
            output_path = temporary / "candidates.json"
            np.savez(
                arrays_path,
                latitudes=self.latitudes,
                longitudes=self.longitudes,
                land_mask=self.land_mask,
                step_0_temperature_k=self.steps[0]["temperature_k"],
                step_0_dew_point_k=self.steps[0]["dew_point_k"],
                step_0_pressure_pa=self.steps[0]["pressure_pa"],
            )
            cities_path.write_text(json.dumps([{"path": "/peak/", "name": "Peak", "state": "", "country": "Test", "latitude": 0.75, "longitude": 0.0}]), encoding="utf-8")
            HOTSPOTS.main([
                "--arrays-npz", str(arrays_path),
                "--cities", str(cities_path),
                "--output", str(output_path),
                "--run", "20260922T000000Z",
                "--steps", "0",
                "--threshold-c", "-100",
                "--dilation-rings", "0",
            ])
            result = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(result["cities"][0]["path"], "/peak/")
            self.assertEqual(result["model"]["steps"], [0])


if __name__ == "__main__":
    unittest.main()
