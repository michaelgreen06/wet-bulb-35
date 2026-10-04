import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location("facts_generator", Path(__file__).parents[1] / "scripts/generate-location-facts.py")
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def source_row(identifier, name, latitude, longitude, population, elevation, dem, timezone):
    columns = [""] * 19
    columns[0], columns[1], columns[4], columns[5] = str(identifier), name, str(latitude), str(longitude)
    columns[14], columns[15], columns[16], columns[17] = str(population), elevation, dem, timezone
    return "\t".join(columns)


class LocationFactsGeneratorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.source, self.ids, self.routes = root / "source.zip", root / "ids.json", root / "routes.json"
        with zipfile.ZipFile(self.source, "w") as archive:
            archive.writestr("cities1000.txt", "\n".join([
                source_row(1, "Alpha", 40, -105, 100, "1600", "1601", "America/Denver"),
                source_row(2, "Beta", 41, -106, 200, "", "-9999", "America/Denver"),
            ]) + "\n")
        self.sha = hashlib.sha256(self.source.read_bytes()).hexdigest()
        paths = [f"/wetbulb-temperature/us/colorado/{slug}/" for slug in ["alpha", "beta", "beta-duplicate", "unknown"]]
        self.ids.write_text(json.dumps({"sourceSha256": self.sha, "rows": [
            {"path": paths[0], "id": 1, "timeZone": "America/Denver", "status": "exact"},
            {"path": paths[1], "id": 2, "timeZone": "America/Denver", "status": "exact"},
            {"path": paths[2], "id": 2, "timeZone": "America/Denver", "status": "alternate"},
            {"path": paths[3], "id": None, "timeZone": None, "status": "unmatched"},
        ]}))
        self.routes.write_text(json.dumps({"v": 1, "rows": [
            {"countrySlug": "us", "stateSlug": "colorado", "outputCitySlug": slug,
             "latitude": lat, "longitude": lon}
            for slug, lat, lon in [("alpha", 40, -105), ("beta", 41, -106),
                                   ("beta-duplicate", 41.0001, -106), ("unknown", 42, -107)]
        ]}))
        self.paths = paths

    def make(self):
        return MODULE.generate(self.source, self.ids, self.routes, self.sha, "2026-09-29", 4)

    def test_quarantines_ambiguous_ids_and_marks_unmatched_explicitly(self):
        artifact = self.make()
        self.assertEqual(artifact["byPath"][self.paths[0]], [1, 100, "America/Denver", 1600, "elevation"])
        for path in self.paths[1:]:
            self.assertIsNone(artifact["byPath"][path])
        self.assertEqual(artifact["counts"]["matched"], 1)
        self.assertEqual(artifact["counts"]["ambiguousIdentity"], 2)
        self.assertEqual(artifact["counts"]["unmatched"], 1)
        self.assertEqual(artifact["source"]["populationReferenceYear"], None)

    def test_source_or_route_drift_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "checksum"):
            MODULE.generate(self.source, self.ids, self.routes, "bad", "2026-09-29", 4)
        data = json.loads(self.routes.read_text())
        data["rows"][0]["outputCitySlug"] = "changed"
        self.routes.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "route inventory"):
            self.make()

    def test_dem_nodata_is_not_displayed(self):
        data = json.loads(self.ids.read_text())
        data["rows"][2]["id"] = None
        self.ids.write_text(json.dumps(data))
        result = self.make()
        self.assertEqual(result["byPath"][self.paths[1]], [2, 200, "America/Denver", None, None])
        self.assertEqual(result["counts"]["elevationNoData"], 1)


if __name__ == "__main__":
    unittest.main()
