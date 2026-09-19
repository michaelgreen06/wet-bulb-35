import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "popular_40_generator",
    ROOT / "scripts" / "generate-popular-40-enrichment.py",
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load Popular-40 generator")
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class FakeArray:
    def __init__(self, values):
        self.values = values

    def flatten(self):
        return self.values

    def __getitem__(self, index):
        if index != (0, 0):
            raise IndexError(index)
        return self.values[0]


class FakeRaster:
    width = 10
    height = 10

    def __init__(self, neighborhood, center):
        self.neighborhood = neighborhood
        self.center = center

    def index(self, longitude, latitude):
        return 5, 5

    def read(self, band, window):
        rows, columns = window
        if rows[1] - rows[0] == 1 and columns[1] - columns[0] == 1:
            return FakeArray([self.center])
        return FakeArray(self.neighborhood)


class Popular40GeneratorTests(unittest.TestCase):
    def setUp(self):
        self.city = {
            "path": "/wetbulb-temperature/example/example/example/",
            "latitude": 29.76328,
            "longitude": -95.36327,
        }
        self.entry = {
            "apiVersion": "v2.9.7",
            "url": (
                "https://power.larc.nasa.gov/api/temporal/climatology/point"
                "?parameters=T2MWET&community=RE&longitude=-95.36327"
                "&latitude=29.76328&format=JSON&start=1991&end=2020"
            ),
        }
        monthly = {month: 20.0 + index / 10 for index, month in enumerate(GENERATOR.MONTHS)}
        self.response = {
            "header": {
                "time_standard": "LST",
                "range": GENERATOR.POWER_RANGE,
                "api": {"version": "v2.9.7"},
                "sources": ["MERRA2", "POWER"],
                "fill_value": -999.0,
            },
            "properties": {"parameter": {"T2MWET": monthly}},
            "parameters": {"T2MWET": {"units": "C"}},
        }

    def test_power_contract_requires_exact_period_and_response_range(self):
        GENERATOR.validate_power_request(self.entry, self.city)
        self.assertEqual(len(GENERATOR.validated_power_response(self.response, self.entry, self.city["path"])), 12)

        wrong_request = dict(self.entry)
        wrong_request["url"] = wrong_request["url"].replace("start=1991&end=2020", "start=1981&end=2010")
        with self.assertRaisesRegex(ValueError, "request contract"):
            GENERATOR.validate_power_request(wrong_request, self.city)

        wrong_response = {**self.response, "header": {**self.response["header"], "range": "January 1981 - December 2010"}}
        with self.assertRaisesRegex(ValueError, "response contract"):
            GENERATOR.validated_power_response(wrong_response, self.entry, self.city["path"])

    def test_koppen_sampling_rejects_ambiguous_neighborhoods(self):
        valid = GENERATOR.raster_sample(FakeRaster([14] * 9, 14), 0, 0)
        self.assertEqual(valid["code"], "Cfa")
        with self.assertRaisesRegex(ValueError, "manual review"):
            GENERATOR.raster_sample(FakeRaster([14, 14, 14, 14, 14, 15, 15, 15, 15], 14), 0, 0)
        with self.assertRaisesRegex(ValueError, "manual review"):
            GENERATOR.raster_sample(FakeRaster([15] * 8 + [14], 14), 0, 0)


if __name__ == "__main__":
    unittest.main()
