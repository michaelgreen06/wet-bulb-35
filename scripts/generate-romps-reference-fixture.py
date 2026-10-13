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
# Cold companion for historical lows: sub-freezing air down to 190 K, where the
# default 240–325 K vectors stop.
COLD_SEED = 20261013
COLD_RANGE_K = (190, 262)
SOURCE_COMMIT = "ebe4a831c1c01de071c8debf27863f1ad92b5782"
SOURCE_ARCHIVE_SHA256 = "14f9bcdb26d758458d7187503a90647764e02cb1f79315470d890aacb561ec2b"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=None)
    parser.add_argument("--cold", action="store_true", help="190–262 K vectors for modeled wet bulb lows")
    args = parser.parse_args()
    seed, (t_lo, t_hi) = (COLD_SEED, COLD_RANGE_K) if args.cold else (SEED, (240, 325))
    out = args.out or ("tests/fixtures/romps-reference-vectors-cold.v1.json" if args.cold
                       else "tests/fixtures/romps-reference-vectors.v1.json")
    version = importlib.metadata.version("heatindex")
    if version != "0.0.2":
        raise SystemExit(f"heatindex 0.0.2 is required, found {version}")

    random.seed(seed)
    vectors = []
    while len(vectors) < POINTS:
        pressure_pa = random.uniform(50_000, 105_000)
        air_temperature_k = random.uniform(t_lo, t_hi)
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
        "seed": seed,
        "points": POINTS,
        "vectors": vectors,
    }
    if args.cold:
        output["airTemperatureRangeK"] = [t_lo, t_hi]
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
