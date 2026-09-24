#!/usr/bin/env python3
"""Compare matched IFS and GFS direct-model hotspot shadow products."""

import argparse
import json
from pathlib import Path
from typing import Any


def normalized_coordinate(cell: dict[str, Any]) -> tuple[float, float]:
    longitude = float(cell["longitude"])
    longitude = ((longitude + 180.0) % 360.0) - 180.0
    return round(float(cell["latitude"]), 6), round(longitude, 6)


def compare_documents(
    ifs_grid: dict[str, Any],
    gfs_grid: dict[str, Any],
    ifs_candidates: dict[str, Any],
    gfs_candidates: dict[str, Any],
) -> dict[str, Any]:
    ifs_bounds = ifs_grid["model"]["validTimeBounds"]
    gfs_bounds = gfs_grid["model"]["validTimeBounds"]
    if ifs_bounds != gfs_bounds:
        raise ValueError("IFS and GFS shadow products must use identical valid-time bounds")
    if not ifs_grid.get("cells") or not gfs_grid.get("cells"):
        raise ValueError("IFS and GFS shadow products must contain ranked grid cells")

    def overlap(count: int) -> int:
        left = {normalized_coordinate(cell) for cell in ifs_grid["cells"][:count]}
        right = {normalized_coordinate(cell) for cell in gfs_grid["cells"][:count]}
        return len(left & right)

    ifs_paths = {city["path"] for city in ifs_candidates["cities"]}
    gfs_paths = {city["path"] for city in gfs_candidates["cities"]}
    return {
        "schemaVersion": 1,
        "window": {"start": ifs_bounds["start"], "end": ifs_bounds["end"]},
        "models": {
            "ifs": {
                "source": ifs_grid["model"]["source"],
                "initialization": ifs_grid["model"]["initialization"],
                "evaluatedCellCount": ifs_grid["model"]["evaluatedCellCount"],
                "topWetBulbC": ifs_grid["cells"][0]["wetBulbC"],
                "topCell": ifs_grid["cells"][0],
            },
            "gfs": {
                "source": gfs_grid["model"]["source"],
                "initialization": gfs_grid["model"]["initialization"],
                "evaluatedCellCount": gfs_grid["model"]["evaluatedCellCount"],
                "topWetBulbC": gfs_grid["cells"][0]["wetBulbC"],
                "topCell": gfs_grid["cells"][0],
            },
        },
        "globalGrid": {
            "top20Overlap": overlap(20),
            "top50Overlap": overlap(50),
        },
        "inhabitedCandidates": {
            "ifs": len(ifs_paths),
            "gfs": len(gfs_paths),
            "overlap": len(ifs_paths & gfs_paths),
            "ifsOnly": len(ifs_paths - gfs_paths),
            "gfsOnly": len(gfs_paths - ifs_paths),
        },
    }


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected a JSON object: {path}")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ifs-grid", required=True, type=Path)
    parser.add_argument("--gfs-grid", required=True, type=Path)
    parser.add_argument("--ifs-candidates", required=True, type=Path)
    parser.add_argument("--gfs-candidates", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    comparison = compare_documents(
        read_json(args.ifs_grid),
        read_json(args.gfs_grid),
        read_json(args.ifs_candidates),
        read_json(args.gfs_candidates),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(comparison, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps(comparison))


if __name__ == "__main__":
    main()
