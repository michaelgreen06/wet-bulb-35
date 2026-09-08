import gzip
import importlib.util
import json
import pathlib
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "probe-location-packaging.py"
spec = importlib.util.spec_from_file_location("location_packaging_probe", SCRIPT)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


ROWS = [
    {"name": "Alpha", "resolvedCountryName": "United States", "resolvedAdmin1Code": "CA", "latitude": 1.25, "longitude": 2.5},
    {"name": "Beta", "resolvedCountryName": "United States", "resolvedAdmin1Code": "NY", "latitude": 3.25, "longitude": 4.5},
    {"name": "Gamma", "resolvedCountryName": "Canada", "resolvedAdmin1Code": "ON", "latitude": 5.25, "longitude": 6.5},
]


class LocationPackagingProbeTests(unittest.TestCase):
    def test_iter_json_array_handles_chunk_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "cities.json"
            source.write_text(json.dumps(ROWS, ensure_ascii=False), encoding="utf-8")
            self.assertEqual(list(probe.iter_json_array(source, chunk_size=7)), ROWS)

    def test_probe_compacts_by_country_without_persisting_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "cities.json"
            source.write_text(json.dumps(ROWS, ensure_ascii=False, indent=2), encoding="utf-8")
            result = probe.run_probe(source, runs=2)
            repeat_hash = probe.run_probe(source, runs=1)["hashes"]["compact_country_shards_sha256"]
        self.assertEqual(result["counts"], {"rows": 3, "countries": 2, "country_state_pairs": 3})
        self.assertEqual(result["schemas"]["compact"]["retained_fields"], ["name", "resolvedAdmin1Code", "latitude", "longitude"])
        self.assertEqual(result["schemas"]["compact"]["dropped_fields"], ["resolvedCountryName (derived from shard manifest)"])
        self.assertEqual(result["artifacts"]["compact_country_shards"]["files"], 2)
        self.assertEqual(result["artifacts"]["compact_country_shards"]["largest"]["rows"], 2)
        self.assertEqual(result["artifacts"]["route_manifest"]["files"], 1)
        self.assertEqual(result["hashes"]["compact_country_shards_sha256"], repeat_hash)
        self.assertGreater(result["timings_ms"]["source_stream_parse"]["runs"], 0)
        self.assertIn("current_rss_bytes", result["memory"])

    def test_gzip_is_reproducible(self):
        self.assertEqual(probe.gzip_bytes(b"repeatable"), probe.gzip_bytes(b"repeatable"))
        self.assertEqual(gzip.decompress(probe.gzip_bytes(b"repeatable")), b"repeatable")


if __name__ == "__main__":
    unittest.main()
