import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "generate-global-grid-hotspot-snapshot.py"
SPEC = importlib.util.spec_from_file_location("global_grid_hotspots", SCRIPT)
assert SPEC and SPEC.loader
HOTSPOTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOTSPOTS)


class GlobalGridHotspotSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.latitudes = np.array([1.0, 0.5])
        self.longitudes = np.array([-0.25, 0.0, 0.25])
        self.steps = {
            0: {
                "temperature_k": np.array([[304.15, 303.15, np.nan], [302.15, 272.15, 301.15]]),
                "dew_point_k": np.array([[304.15, 302.15, np.nan], [301.15, 271.15, 300.15]]),
                "pressure_pa": np.full((2, 3), 101325.0),
                "valid_time": "2026-09-22T00:00:00Z",
            },
            3: {
                "temperature_k": np.array([[303.15, 305.15, np.nan], [302.15, 272.15, 301.15]]),
                "dew_point_k": np.array([[302.15, 305.15, np.nan], [301.15, 271.15, 300.15]]),
                "pressure_pa": np.full((2, 3), 101325.0),
                "valid_time": "2026-09-22T03:00:00Z",
            },
        }

    def test_ranks_every_finite_warm_cell_including_ocean_deterministically(self):
        document = HOTSPOTS.generate_snapshot_from_arrays(
            latitudes=self.latitudes,
            longitudes=self.longitudes,
            steps=self.steps,
            model={"source": "ecmwf-ifs-0.25", "initialization": "2026-09-22T00:00:00Z", "steps": [0, 3]},
        )

        self.assertEqual(document["schemaVersion"], 1)
        self.assertEqual(document["method"], "romps-thermodynamic-liquid")
        self.assertEqual(document["methodVersion"], "2026-heatindex-0.0.2")
        self.assertEqual(document["model"], {
            "source": "ecmwf-ifs-0.25",
            "initialization": "2026-09-22T00:00:00Z",
            "validTimeBounds": {"start": "2026-09-22T00:00:00Z", "end": "2026-09-22T03:00:00Z"},
            "steps": [0, 3],
            "grid": {"latitudeCount": 2, "longitudeCount": 3},
            "evaluatedCellCount": 4,
        })
        self.assertEqual(len(document["cells"]), 4)
        self.assertEqual(document["cells"][0]["latitude"], 1.0)
        self.assertEqual(document["cells"][0]["longitude"], 0.0)
        self.assertEqual(document["cells"][0]["peakStep"], 3)
        self.assertEqual(document["cells"][0]["peakTime"], "2026-09-22T03:00:00Z")
        self.assertGreater(document["cells"][0]["wetBulbC"], 31.0)
        self.assertEqual(document["cells"][-1]["latitude"], 0.5)
        self.assertEqual(document["cells"][-1]["longitude"], 0.25)
        HOTSPOTS.validate_snapshot_document(document)

    def test_limits_tied_cells_to_fifty_with_coordinate_tiebreakers(self):
        latitudes = np.array([1.0, 0.0, -1.0])
        longitudes = np.arange(20, dtype=float)
        shape = (3, 20)
        document = HOTSPOTS.generate_snapshot_from_arrays(
            latitudes=latitudes,
            longitudes=longitudes,
            steps={
                0: {
                    "temperature_k": np.full(shape, 303.15),
                    "dew_point_k": np.full(shape, 303.15),
                    "pressure_pa": np.full(shape, 101325.0),
                    "valid_time": "2026-09-22T00:00:00Z",
                }
            },
            model={"source": "ecmwf", "initialization": "2026-09-22T00:00:00Z", "steps": [0]},
        )
        self.assertEqual(document["model"]["evaluatedCellCount"], 60)
        self.assertEqual(len(document["cells"]), 50)
        self.assertEqual((document["cells"][0]["latitude"], document["cells"][0]["longitude"]), (-1.0, 0.0))
        self.assertEqual((document["cells"][-1]["latitude"], document["cells"][-1]["longitude"]), (1.0, 9.0))

    def test_validation_rejects_non_three_hour_step_and_invalid_grid_values(self):
        with self.assertRaisesRegex(ValueError, "three-hourly"):
            HOTSPOTS.generate_snapshot_from_arrays(
                latitudes=self.latitudes,
                longitudes=self.longitudes,
                steps={1: self.steps[0]},
                model={"source": "ecmwf", "initialization": "2026-09-22T00:00:00Z", "steps": [1]},
            )
        broken = {**self.steps[0], "pressure_pa": np.array([[101325.0, -1.0, np.nan], [101325.0, 101325.0, 101325.0]])}
        with self.assertRaisesRegex(ValueError, "positive"):
            HOTSPOTS.generate_snapshot_from_arrays(
                latitudes=self.latitudes,
                longitudes=self.longitudes,
                steps={0: broken},
                model={"source": "ecmwf", "initialization": "2026-09-22T00:00:00Z", "steps": [0]},
            )

    def test_cli_writes_validated_deterministic_npz_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = Path(temporary_directory)
            fixture = temporary / "fixture.npz"
            output = temporary / "snapshot.json"
            output_again = temporary / "snapshot-again.json"
            np.savez(
                fixture,
                latitudes=self.latitudes,
                longitudes=self.longitudes,
                step_0_temperature_k=self.steps[0]["temperature_k"],
                step_0_dew_point_k=self.steps[0]["dew_point_k"],
                step_0_pressure_pa=self.steps[0]["pressure_pa"],
                step_3_temperature_k=self.steps[3]["temperature_k"],
                step_3_dew_point_k=self.steps[3]["dew_point_k"],
                step_3_pressure_pa=self.steps[3]["pressure_pa"],
            )
            arguments = [
                "--arrays-npz", str(fixture), "--output", str(output), "--run", "2026-09-22T00:00:00Z", "--steps", "0,3"
            ]
            HOTSPOTS.main(arguments)
            HOTSPOTS.main([*arguments[:3], str(output_again), *arguments[4:]])
            document = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(output.read_bytes(), output_again.read_bytes())
            self.assertEqual(document["model"]["evaluatedCellCount"], 4)
            self.assertNotIn("land", json.dumps(document).lower())

    def test_grib_loader_reuses_shared_decoder_without_land_mask(self):
        message = {
            "latitudes": self.latitudes,
            "longitudes": self.longitudes,
            "initialization": "2026-09-22T00:00:00Z",
            "valid_time": "2026-09-22T00:00:00Z",
            "step": 0,
            "units": "K",
        }
        messages = [
            {**message, "short_name": "2t", "values": self.steps[0]["temperature_k"]},
            {**message, "short_name": "2d", "values": self.steps[0]["dew_point_k"]},
            {**message, "short_name": "sp", "units": "Pa", "values": self.steps[0]["pressure_pa"]},
        ]
        with mock.patch.object(HOTSPOTS.SHARED, "_decode_grib_messages", return_value=messages) as decoder:
            latitudes, longitudes, steps, initialization = HOTSPOTS.load_grib_inputs(Path("forecast.grib"), (0,))
        decoder.assert_called_once_with(Path("forecast.grib"))
        self.assertTrue(np.array_equal(latitudes, self.latitudes))
        self.assertTrue(np.array_equal(longitudes, self.longitudes))
        self.assertEqual(initialization, "2026-09-22T00:00:00Z")
        self.assertEqual(steps[0]["valid_time"], "2026-09-22T00:00:00Z")


if __name__ == "__main__":
    unittest.main()
