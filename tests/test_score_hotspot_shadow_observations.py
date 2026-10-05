import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "score-hotspot-shadow-observations.py"
SPEC = importlib.util.spec_from_file_location("score_hotspot_shadow_observations", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ObservationScoreTests(unittest.TestCase):
    def test_parses_ghcnh_fields_quality_and_station_pressure_units(self):
        columns = [
            "STATION", "DATE",
            "temperature", "temperature_Quality_Code", "temperature_Source_Code", "temperature_Measurement_Code",
            "dew_point_temperature", "dew_point_temperature_Quality_Code", "dew_point_temperature_Source_Code", "dew_point_temperature_Measurement_Code",
            "station_level_pressure", "station_level_pressure_Quality_Code", "station_level_pressure_Source_Code", "station_level_pressure_Measurement_Code",
            "wet_bulb_temperature", "wet_bulb_temperature_Quality_Code", "wet_bulb_temperature_Measurement_Code",
        ]
        values = [
            "S1", "2026-09-24T09:00:00",
            "31.2", "1", "A", "", "26.1", "5", "A", "", "1001.2", "", "A", "", "27.0", "1", "D",
        ]
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "station.psv"
            path.write_text("|".join(columns) + "\n" + "|".join(values) + "\n", encoding="utf-8")
            records = MODULE.parse_ghcnh_psv(path, "S1", "2026-09-24T09:00:00Z", "2026-09-24T09:00:00Z")
        self.assertEqual(len(records), 1)
        self.assertAlmostEqual(records[0]["pressurePa"], 100120.0)
        self.assertTrue(records[0]["qualityAccepted"])
        self.assertEqual(records[0]["reportedWetBulbMeasurementCode"], "D")

    def test_matches_nearest_report_inside_thirty_minutes(self):
        records = [
            {"date": "2026-09-24T09:31:00Z", "temperatureC": 30.0, "dewPointC": 25.0, "pressurePa": 100000.0, "qualityAccepted": True},
            {"date": "2026-09-24T09:20:00Z", "temperatureC": 31.0, "dewPointC": 26.0, "pressurePa": 100100.0, "qualityAccepted": True},
        ]
        matched = MODULE.match_observation(records, "2026-09-24T09:00:00Z", tolerance_minutes=30)
        self.assertEqual(matched["date"], "2026-09-24T09:20:00Z")
        self.assertIsNone(MODULE.match_observation(records[:1], "2026-09-24T09:00:00Z", tolerance_minutes=30))

    def test_one_report_cannot_score_two_adjacent_forecast_hours(self):
        records = [{
            "date": "2026-09-24T09:30:00Z", "temperatureC": 30.0,
            "dewPointC": 25.0, "pressurePa": 100000.0, "qualityAccepted": True,
        }]
        matches = MODULE.match_observations_to_hours(
            records,
            ["2026-09-24T09:00:00Z", "2026-09-24T10:00:00Z"],
            tolerance_minutes=30,
        )
        self.assertEqual(sum(value is not None for value in matches.values()), 1)

    def test_score_status_remains_provisional_until_revision_window_ends(self):
        self.assertEqual(MODULE.score_status(
            window_end="2026-09-25T08:00:00Z",
            now="2026-09-27T00:00:00Z",
            finalize_after_hours=120,
        ), "provisional")
        self.assertEqual(MODULE.score_status(
            window_end="2026-09-25T08:00:00Z",
            now="2026-09-30T08:00:00Z",
            finalize_after_hours=120,
        ), "final")

    def test_quality_filter_preserves_component_metrics_but_requires_pressure_for_wet_bulb(self):
        capture = self.capture()
        observations = {
            "S1": [
                {"date": "2026-09-24T09:00:00Z", "temperatureC": 31.0, "dewPointC": 26.0, "pressurePa": None, "qualityAccepted": True, "quality": {}},
                {"date": "2026-09-24T10:00:00Z", "temperatureC": 30.0, "dewPointC": 25.0, "pressurePa": 100000.0, "qualityAccepted": True, "quality": {}},
            ]
        }
        result = MODULE.score_capture(capture, observations, retrieved_at="2026-09-27T00:00:00Z")
        self.assertEqual(result["availability"]["hourlyPairsMatched"], 2)
        self.assertEqual(result["availability"]["hourlyPairsScoredWetBulb"], 1)
        self.assertEqual(result["summaries"]["ifs"]["temperatureC"]["count"], 2)
        self.assertEqual(result["summaries"]["ifs"]["wetBulbC"]["count"], 1)

    def test_computes_bias_mae_rmse_and_pairwise_difference(self):
        result = MODULE.metric_summary([1.0, -3.0])
        self.assertEqual(result["count"], 2)
        self.assertAlmostEqual(result["meanError"], -1.0)
        self.assertAlmostEqual(result["meanAbsoluteError"], 2.0)
        self.assertAlmostEqual(result["rootMeanSquareError"], 5 ** 0.5)

    def test_rejects_scoring_before_delay(self):
        with self.assertRaisesRegex(ValueError, "availability delay"):
            MODULE.ensure_score_eligible(
                window_end="2026-09-25T08:00:00Z",
                now="2026-09-26T08:00:00Z",
                minimum_delay_hours=36,
            )

    @staticmethod
    def capture():
        hours = []
        for hour in (9, 10):
            hours.append({"validTime": f"2026-09-24T{hour:02d}:00:00Z", "temperatureC": 30.0, "dewPointC": 25.0, "pressurePa": 100000.0, "wetBulbC": 26.0})
        return {
            "schemaVersion": 1,
            "kind": "direct-model-station-forecast-capture",
            "createdAt": "2026-09-24T08:30:00Z",
            "window": {"start": "2026-09-24T09:00:00Z", "end": "2026-09-24T10:00:00Z", "hourCount": 2},
            "method": {"name": "romps-thermodynamic-liquid", "version": "2026-heatindex-0.0.2", "sampling": "nearest-native-grid-cell"},
            "models": {
                "ifs": {"source": "ecmwf-ifs-0.25", "initialization": "2026-09-24T06:00:00Z"},
                "gfs": {"source": "noaa-gfs-0.25", "initialization": "2026-09-24T06:00:00Z"},
            },
            "selection": {"fixedPanelVersion": 1, "maxDynamicStations": 20, "maxStationDistanceKm": 100.0},
            "stations": [{
                "stationId": "S1", "name": "Station", "latitude": 0.0, "longitude": 0.0, "elevationM": 0.0,
                "selection": {"groups": ["fixed"], "hotspotSources": []},
                "forecasts": {
                    "ifs": {"gridCell": {"latitude": 0.0, "longitude": 0.0}, "hours": hours},
                    "gfs": {"gridCell": {"latitude": 0.0, "longitude": 0.0}, "hours": [{**x, "temperatureC": 31.0} for x in hours]},
                },
            }],
        }


if __name__ == "__main__":
    unittest.main()
