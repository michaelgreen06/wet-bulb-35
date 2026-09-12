import gzip
import importlib.util
import json
import pathlib
import subprocess
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

    def test_iter_json_array_rejects_missing_comma_across_chunks(self):
        self.assert_iter_json_array_rejected('[{"name":"one"} {"name":"two"}]', chunk_size=16)

    def test_iter_json_array_rejects_trailing_comma_across_chunks(self):
        self.assert_iter_json_array_rejected('[{"name":"one"}, ]', chunk_size=16)

    def test_iter_json_array_rejects_trailing_non_whitespace_across_chunks(self):
        self.assert_iter_json_array_rejected('[{"name":"one"}] trailing', chunk_size=16)

    def test_run_probe_rejects_malformed_records(self):
        malformed_records = [
            [],
            {"name": "Alpha"},
            {"name": "Alpha", "resolvedCountryName": "", "resolvedAdmin1Code": "CA", "latitude": 1.25, "longitude": 2.5},
        ]
        for record in malformed_records:
            with self.subTest(record=record), tempfile.TemporaryDirectory() as directory:
                source = pathlib.Path(directory) / "cities.json"
                source.write_text(json.dumps([record]), encoding="utf-8")
                with self.assertRaises(ValueError):
                    probe.run_probe(source, runs=1)

    def test_production_route_identity_generator_preserves_collision_safe_slugs(self):
        colliding_rows = [
            {"name": "Metsamor", "resolvedCountryName": "Armenia", "resolvedAdmin1Code": "Armavir", "latitude": 40.07233, "longitude": 44.29169},
            {"name": "Metsamor", "resolvedCountryName": "Armenia", "resolvedAdmin1Code": "Armavir", "latitude": 40.14447, "longitude": 44.1167},
        ]
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "cities.json"
            identity = pathlib.Path(directory) / "route-identity.json"
            source.write_text(json.dumps(colliding_rows), encoding="utf-8")
            subprocess.run(
                ["node", "scripts/probe-location-route-identity.mjs", f"--source={source}", f"--out={identity}"],
                check=True,
                cwd=SCRIPT.parents[1],
            )
            generated = json.loads(identity.read_text(encoding="utf-8"))

        self.assertEqual(generated["collisionGroups"], 1)
        self.assertEqual(generated["collisionRows"], 2)
        self.assertEqual([row["outputCitySlug"] for row in generated["rows"]], [
            "metsamor-40-0723-44-2917", "metsamor-40-1445-44-1167",
        ])
        self.assertIn("outputCitySlug", probe.COMPACT_FIELDS)
        self.assertEqual(probe.ROUTE_IDENTITY_CONTRACT["status"], "measured_with_production_generated_identity")

    def test_probe_compacts_by_country_without_persisting_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "cities.json"
            source.write_text(json.dumps(ROWS, ensure_ascii=False, indent=2), encoding="utf-8")
            result = probe.run_probe(source, runs=2)
            repeat_hash = probe.run_probe(source, runs=1)["hashes"]["compact_country_shards_sha256"]
        self.assertEqual(result["counts"], {"rows": 3, "countries": 2, "country_state_pairs": 3})
        self.assertEqual(result["schemas"]["compact"]["retained_fields"], ["name", "resolvedAdmin1Code", "latitude", "longitude", "outputCitySlug"])
        self.assertEqual(result["schemas"]["compact"]["dropped_fields"], ["resolvedCountryName (derived from shard manifest)"])
        self.assertEqual(result["schemas"]["compact"]["route_identity"], probe.ROUTE_IDENTITY_CONTRACT)
        self.assertEqual(result["artifacts"]["compact_country_shards"]["files"], 2)
        self.assertEqual(result["artifacts"]["compact_country_shards"]["largest"]["rows"], 2)
        self.assertEqual(result["artifacts"]["route_manifest"]["files"], 1)
        self.assertEqual(result["artifacts"]["temporary_route_identity_index"]["files"], 1)
        self.assertEqual(result["hashes"]["compact_country_shards_sha256"], repeat_hash)
        self.assertGreater(result["timings_ms"]["source_stream_parse"]["runs"], 0)
        self.assertIn("current_rss_bytes", result["memory"])

    def test_gzip_is_reproducible(self):
        self.assertEqual(probe.gzip_bytes(b"repeatable"), probe.gzip_bytes(b"repeatable"))
        self.assertEqual(gzip.decompress(probe.gzip_bytes(b"repeatable")), b"repeatable")

    def assert_iter_json_array_rejected(self, content, chunk_size):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "cities.json"
            source.write_text(content, encoding="utf-8")
            with self.assertRaises(ValueError):
                list(probe.iter_json_array(source, chunk_size=chunk_size))


if __name__ == "__main__":
    unittest.main()
