#!/usr/bin/env python3
"""Measure country-sharded location metadata without retaining generated files."""
import argparse
import gzip
import hashlib
import json
import os
import pathlib
import resource
import statistics
import subprocess

import tempfile
import time
from collections import defaultdict

CHUNK_SIZE = 64 * 1024
RAW_FIELDS = ["name", "resolvedCountryName", "resolvedAdmin1Code", "latitude", "longitude"]
COMPACT_FIELDS = ["name", "resolvedAdmin1Code", "latitude", "longitude", "outputCitySlug"]
ROUTE_IDENTITY_CONTRACT = {
    "status": "measured_with_production_generated_identity",
    "generator": "scripts/probe-location-route-identity.mjs using prototype-static-generator.mjs prepareCities/getRouteParts",
    "per_row_identity": "outputCitySlug",
}


def iter_json_array(path, chunk_size=CHUNK_SIZE):
    """Incrementally decode a top-level JSON array, retaining only its buffer."""
    decoder = json.JSONDecoder()
    with open(path, "r", encoding="utf-8") as handle:
        buffer = ""
        started = False
        finished = False
        expects_value = True
        comma_before_value = False
        while True:
            chunk = handle.read(chunk_size)
            eof = not chunk
            buffer += chunk
            while True:
                text = buffer.lstrip()
                buffer = text
                if finished:
                    if text:
                        raise ValueError("unexpected data after JSON array")
                    break
                if not started:
                    if not text:
                        break
                    if text[0] != "[":
                        raise ValueError("source must be a JSON array")
                    started = True
                    buffer = text[1:]
                    continue
                if not text:
                    break
                if expects_value:
                    if text[0] == "]":
                        if comma_before_value:
                            raise ValueError("trailing comma in JSON array")
                        finished = True
                        buffer = text[1:]
                        continue
                    try:
                        value, end = decoder.raw_decode(text)
                    except json.JSONDecodeError as error:
                        if eof:
                            raise ValueError("incomplete JSON array") from error
                        break
                    # A scalar token may be split directly at a chunk boundary.
                    if end == len(text) and not eof:
                        break
                    yield value
                    buffer = text[end:]
                    expects_value = False
                    comma_before_value = False
                    continue
                if text[0] == ",":
                    buffer = text[1:]
                    expects_value = True
                    comma_before_value = True
                    continue
                if text[0] == "]":
                    finished = True
                    buffer = text[1:]
                    continue
                raise ValueError("expected comma or closing bracket in JSON array")
            if eof:
                if not finished:
                    raise ValueError("incomplete JSON array")
                break
    if not started or not finished:
        raise ValueError("source must be a complete JSON array")


def gzip_bytes(data):
    return gzip.compress(data, compresslevel=9, mtime=0)


def file_gzip_bytes(path):
    class Counter:
        def __init__(self):
            self.count = 0

        def write(self, data):
            self.count += len(data)
            return len(data)

        def flush(self):
            pass

    counter = Counter()
    with gzip.GzipFile(fileobj=counter, mode="wb", compresslevel=9, mtime=0) as compressed:
        with open(path, "rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                compressed.write(block)
    return counter.count


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def directory_hash(directory):
    digest = hashlib.sha256()
    for path in sorted(pathlib.Path(directory).glob("*.json")):
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(sha256_file(path)))
    return digest.hexdigest()


def current_rss_bytes():
    try:
        for line in pathlib.Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError):
        pass
    return None


def peak_rss_bytes():
    # Linux ru_maxrss is KiB. Deliberately omit a value on unknown platforms.
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024 if os.name == "posix" and pathlib.Path("/proc").exists() else None


def timing(runs, fn):
    values = []
    for _ in range(runs):
        start = time.perf_counter_ns()
        fn()
        values.append((time.perf_counter_ns() - start) / 1_000_000)
    return {"runs": runs, "min": round(min(values), 3), "median": round(statistics.median(values), 3), "max": round(max(values), 3)}


def parse_stream(path):
    return sum(1 for _ in iter_json_array(path))


def parse_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def generate_route_identity(source, output):
    generator = pathlib.Path(__file__).with_name("probe-location-route-identity.mjs")
    completed = subprocess.run(
        ["node", str(generator), f"--source={source}", f"--out={output}"],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def artifact_stats(directory, rows_by_file):
    paths = list(pathlib.Path(directory).glob("*.json"))
    sizes = [(path, path.stat().st_size, file_gzip_bytes(path), rows_by_file[path.name]) for path in paths]
    largest = max(sizes, key=lambda item: (item[1], item[0].name))
    return {
        "files": len(paths),
        "raw_bytes": sum(item[1] for item in sizes),
        "gzip_bytes": sum(item[2] for item in sizes),
        "largest": {"file": largest[0].name, "rows": largest[3], "raw_bytes": largest[1], "gzip_bytes": largest[2]},
    }


def run_probe(source, runs=5):
    source = pathlib.Path(source)
    if not source.is_file():
        raise FileNotFoundError(source)
    with tempfile.TemporaryDirectory(prefix="location-packaging-probe-") as temporary:
        root = pathlib.Path(temporary)
        identity_path = root / "route-identity.json"
        identity_generation = generate_route_identity(source, identity_path)
        identity = parse_json(identity_path)
        if identity.get("v") != 1 or not isinstance(identity.get("rows"), list):
            raise ValueError("production route identity index has an unsupported format")
        identity_by_source_index = {row.get("sourceIndex"): row for row in identity["rows"] if isinstance(row, dict)}
        if len(identity_by_source_index) != len(identity["rows"]):
            raise ValueError("production route identity index has duplicate source indexes")
        raw_dir, compact_dir = root / "raw", root / "compact"
        raw_dir.mkdir(); compact_dir.mkdir()
        raw_handles, compact_handles, used_names = {}, {}, set()
        rows_by_file, country_names, states = defaultdict(int), {}, set()
        minified = root / "source.min.json"
        with open(minified, "wb") as minified_handle:
            minified_handle.write(b"[")
            first_source = True
            source_rows = iter_json_array(source)
            for source_index, source_row in enumerate(source_rows):
                row = identity_by_source_index.get(source_index)
                if not isinstance(source_row, dict) or not isinstance(row, dict):
                    raise ValueError("every source entry must be an object")
                missing = [field for field in RAW_FIELDS if field not in row]
                if missing:
                    raise ValueError("source entry missing: " + ", ".join(missing))
                if any(source_row[field] != row[field] for field in RAW_FIELDS):
                    raise ValueError("production route identity row does not match source row")
                country = row["resolvedCountryName"]
                if not isinstance(country, str) or not country:
                    raise ValueError("resolvedCountryName must be a non-empty string")
                if country not in country_names:
                    country_slug = row.get("countrySlug")
                    if not isinstance(country_slug, str) or not country_slug:
                        raise ValueError("production route identity row missing countrySlug")
                    if country_slug in used_names:
                        raise ValueError("production route identity has duplicate countrySlug")
                    used_names.add(country_slug)
                    filename = country_slug + ".json"
                    country_names[country] = (country_slug, filename)
                    raw_handles[country] = open(raw_dir / filename, "wb")
                    compact_handles[country] = open(compact_dir / filename, "wb")
                    raw_handles[country].write(b"["); compact_handles[country].write(b'{"v":1,"r":[')
                raw = json.dumps({field: row[field] for field in RAW_FIELDS}, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
                if not isinstance(row.get("outputCitySlug"), str) or not row["outputCitySlug"]:
                    raise ValueError("production route identity row missing outputCitySlug")
                compact = json.dumps([row[field] for field in COMPACT_FIELDS], ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
                if rows_by_file[country_names[country][1]]:
                    raw_handles[country].write(b","); compact_handles[country].write(b",")
                raw_handles[country].write(raw); compact_handles[country].write(compact)
                if not first_source: minified_handle.write(b",")
                minified_handle.write(raw); first_source = False
                rows_by_file[country_names[country][1]] += 1
                states.add((country, row["resolvedAdmin1Code"]))
            minified_handle.write(b"]")
        if len(identity_by_source_index) != sum(rows_by_file.values()):
            raise ValueError("production route identity index row count does not match source")
        for handle in raw_handles.values(): handle.write(b"]"); handle.close()
        for handle in compact_handles.values(): handle.write(b"]}"); handle.close()
        manifest = [{"country": country, "countrySlug": value[0], "file": value[1]} for country, value in sorted(country_names.items(), key=lambda item: item[1][0])]
        manifest_path = root / "route-manifest.json"
        manifest_path.write_bytes(json.dumps({"v": 1, "countries": manifest}, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
        raw_stats, compact_stats = artifact_stats(raw_dir, rows_by_file), artifact_stats(compact_dir, rows_by_file)
        largest_path = compact_dir / compact_stats["largest"]["file"]
        result = {
            "probe_version": 2,
            "source": {"path": str(source), "raw_bytes": source.stat().st_size, "gzip_bytes": file_gzip_bytes(source), "sha256": sha256_file(source)},
            "counts": {"rows": sum(rows_by_file.values()), "countries": len(country_names), "country_state_pairs": len(states)},
            "schemas": {"raw_field_preserving": {"retained_fields": RAW_FIELDS, "dropped_fields": []}, "compact": {"format": "{v:1,r:[[name,admin1,latitude,longitude,outputCitySlug],...]}; country and countrySlug are manifest context", "retained_fields": COMPACT_FIELDS, "dropped_fields": ["resolvedCountryName (derived from shard manifest)"], "route_identity": ROUTE_IDENTITY_CONTRACT, "uncertain_renderer_requirement": "No current route renderer reads another source field; a future renderer requiring per-row country duplication, source-object keys, or unknown fields needs validation."}},
            "artifacts": {"minified_source": {"files": 1, "raw_bytes": minified.stat().st_size, "gzip_bytes": file_gzip_bytes(minified)}, "raw_country_shards": raw_stats, "compact_country_shards": compact_stats, "route_manifest": {"files": 1, "raw_bytes": manifest_path.stat().st_size, "gzip_bytes": file_gzip_bytes(manifest_path)}, "temporary_route_identity_index": {"files": 1, "raw_bytes": identity_path.stat().st_size, "gzip_bytes": file_gzip_bytes(identity_path)}},
            "hashes": {"raw_country_shards_sha256": directory_hash(raw_dir), "compact_country_shards_sha256": directory_hash(compact_dir), "route_manifest_sha256": sha256_file(manifest_path), "temporary_route_identity_index_sha256": sha256_file(identity_path)},
            "timings_ms": {"production_route_identity_generation": identity_generation["elapsedMs"], "source_stream_parse": timing(runs, lambda: parse_stream(source)), "largest_compact_shard_parse": timing(runs, lambda: parse_json(largest_path))},
            "memory": {"current_rss_bytes": current_rss_bytes(), "peak_rss_bytes": peak_rss_bytes(), "peak_rss_method": "resource.getrusage(RUSAGE_SELF).ru_maxrss on Linux (process-lifetime high-water mark)"},
            "projected_artifact_files": {"current_committed": 1, "raw_shards_committed_or_runtime": raw_stats["files"] + 1, "compact_shards_committed_or_runtime": compact_stats["files"] + 1, "generated_files_persisted": 0},
        }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="scripts/resolved_cities.json")
    parser.add_argument("--runs", type=int, default=5)
    args = parser.parse_args()
    if args.runs < 1: parser.error("--runs must be at least 1")
    print(json.dumps(run_probe(args.source, args.runs), ensure_ascii=False, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
