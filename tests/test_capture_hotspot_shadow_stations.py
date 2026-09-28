import importlib.util
import unittest
from pathlib import Path

import numpy as np

SCRIPT = Path(__file__).parents[1] / "scripts" / "capture-hotspot-shadow-stations.py"
SPEC = importlib.util.spec_from_file_location("capture_hotspot_shadow_stations", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class StationForecastCaptureTests(unittest.TestCase):
    def setUp(self):
        self.stations = [
            {"stationId": "FIXED", "name": "Fixed", "latitude": 0.0, "longitude": 0.0, "elevationM": 5.0},
            {"stationId": "A", "name": "Alpha", "latitude": 10.0, "longitude": 10.0, "elevationM": 10.0},
            {"stationId": "B", "name": "Beta", "latitude": 20.0, "longitude": 20.0, "elevationM": 20.0},
        ]
        self.grid = {
            "latitudes": np.array([20.0, 10.0, 0.0]),
            "longitudes": np.array([0.0, 10.0, 20.0]),
        }

    @staticmethod
    def steps(offset=0.0):
        result = {}
        for step in range(24):
            shape = (3, 3)
            result[step] = {
                "temperature_k": np.full(shape, 303.15 + offset + step / 10),
                "dew_point_k": np.full(shape, 299.15 + offset + step / 10),
                "pressure_pa": np.full(shape, 100000.0 + step),
                "valid_time": f"2026-09-{24 if step < 15 else 25:02d}T{(9 + step) % 24:02d}:00:00Z",
            }
        return result

    def test_selects_fixed_and_union_dynamic_stations_deterministically(self):
        selected = MODULE.select_station_panel(
            station_catalog=self.stations,
            fixed_station_ids=["FIXED"],
            ifs_cells=[{"latitude": 10.0, "longitude": 10.0, "wetBulbC": 31.0}],
            gfs_cells=[{"latitude": 20.0, "longitude": 20.0, "wetBulbC": 30.0}],
            max_dynamic_stations=20,
            max_station_distance_km=100.0,
        )
        self.assertEqual([item["stationId"] for item in selected], ["FIXED", "A", "B"])
        self.assertEqual(selected[1]["selection"]["groups"], ["dynamic"])
        self.assertEqual({x["model"] for x in selected[1]["selection"]["hotspotSources"]}, {"ifs"})
        self.assertEqual({x["model"] for x in selected[2]["selection"]["hotspotSources"]}, {"gfs"})

    def test_rejects_dynamic_station_outside_distance_limit(self):
        selected = MODULE.select_station_panel(
            station_catalog=self.stations[:1],
            fixed_station_ids=["FIXED"],
            ifs_cells=[{"latitude": 40.0, "longitude": 40.0, "wetBulbC": 31.0}],
            gfs_cells=[],
            max_dynamic_stations=20,
            max_station_distance_km=25.0,
        )
        self.assertEqual([item["stationId"] for item in selected], ["FIXED"])

    def test_captures_exact_shared_24_hours_and_each_models_grid_cell(self):
        selected = MODULE.select_station_panel(
            station_catalog=self.stations,
            fixed_station_ids=["FIXED"],
            ifs_cells=[],
            gfs_cells=[],
            max_dynamic_stations=0,
            max_station_distance_km=100.0,
        )
        document = MODULE.build_capture_document(
            stations=selected,
            ifs_axes=(self.grid["latitudes"], self.grid["longitudes"]),
            gfs_axes=(self.grid["latitudes"], np.array([0.0, 9.75, 20.0])),
            ifs_steps=self.steps(),
            gfs_steps=self.steps(0.5),
            ifs_initialization="2026-09-24T06:00:00Z",
            gfs_initialization="2026-09-24T06:00:00Z",
            window_start="2026-09-24T09:00:00Z",
            window_end="2026-09-25T08:00:00Z",
            created_at="2026-09-24T08:30:00Z",
            selection_metadata={"fixedPanelVersion": 1, "maxDynamicStations": 20, "maxStationDistanceKm": 100.0},
        )
        MODULE.validate_capture_document(document)
        self.assertEqual(document["window"]["hourCount"], 24)
        station = document["stations"][0]
        self.assertEqual(len(station["forecasts"]["ifs"]["hours"]), 24)
        self.assertEqual(station["forecasts"]["ifs"]["gridCell"], {"latitude": 0.0, "longitude": 0.0})
        self.assertEqual(station["forecasts"]["gfs"]["gridCell"], {"latitude": 0.0, "longitude": 0.0})
        self.assertGreater(station["forecasts"]["gfs"]["hours"][0]["wetBulbC"], station["forecasts"]["ifs"]["hours"][0]["wetBulbC"])

    def test_rejects_non_identical_hour_sequences(self):
        gfs = self.steps()
        gfs.pop(23)
        selected = MODULE.select_station_panel(
            station_catalog=self.stations,
            fixed_station_ids=["FIXED"],
            ifs_cells=[],
            gfs_cells=[],
            max_dynamic_stations=0,
            max_station_distance_km=100.0,
        )
        with self.assertRaisesRegex(ValueError, "24 shared hourly"):
            MODULE.build_capture_document(
                stations=selected,
                ifs_axes=(self.grid["latitudes"], self.grid["longitudes"]),
                gfs_axes=(self.grid["latitudes"], self.grid["longitudes"]),
                ifs_steps=self.steps(),
                gfs_steps=gfs,
                ifs_initialization="2026-09-24T06:00:00Z",
                gfs_initialization="2026-09-24T06:00:00Z",
                window_start="2026-09-24T09:00:00Z",
                window_end="2026-09-25T08:00:00Z",
                created_at="2026-09-24T08:30:00Z",
                selection_metadata={"fixedPanelVersion": 1, "maxDynamicStations": 20, "maxStationDistanceKm": 100.0},
            )


if __name__ == "__main__":
    unittest.main()
