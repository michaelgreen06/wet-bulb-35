#!/usr/bin/env python3
"""Generate deterministic Romps parity vectors with heatindex 0.0.2."""

import argparse
import importlib.metadata
import json
import math
import random
from pathlib import Path

import heatindex

SEED = 20260920
POINTS = 500
SOURCE_COMMIT = "ebe4a831c1c01de071c8debf27863f1ad92b5782"
SOURCE_ARCHIVE_SHA256 = "14f9bcdb26d758458d7187503a90647764e02cb1f79315470d890aacb561ec2b"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="tests/fixtures/romps-reference-vectors.v1.json")
    args = parser.parse_args()
    version = importlib.metadata.version("heatindex")
    if version != "0.0.2":
        raise SystemExit(f"heatindex 0.0.2 is required, found {version}")

    random.seed(SEED)
    vectors = []
    while len(vectors) < POINTS:
        pressure_pa = random.uniform(50_000, 105_000)
        air_temperature_k = random.uniform(240, 325)
        relative_humidity = random.random()
        wet_bulb_k = float(heatindex.wetbulb(pressure_pa, air_temperature_k, relative_humidity))
        if math.isfinite(wet_bulb_k):
            vectors.append({
                "pressurePa": pressure_pa,
                "airTemperatureK": air_temperature_k,
                "relativeHumidity": relative_humidity,
                "wetBulbK": wet_bulb_k,
            })
    output = {
        "schemaVersion": 1,
        "source": {
            "package": "heatindex",
            "version": version,
            "commit": SOURCE_COMMIT,
            "sourceArchiveSha256": SOURCE_ARCHIVE_SHA256,
        },
        "seed": SEED,
        "points": POINTS,
        "vectors": vectors,
    }
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
