#!/usr/bin/env python3
"""Pure ERA5-Land ARCO geo-chunked grid mapping (no network).

The authenticated ARCO axes (read once by map_arco_cohort.py) are 0.1° cell
centres: latitude ascending -90.0..90.0 (1,801 values) and longitude
-179.9..180.0 (3,600 values); t2m/d2m/sp share 4-latitude × 8-longitude tiles.
A coordinate within 1e-6° of a half-cell boundary is equidistant from two cell
centres; it deterministically takes the north/east cell (the order observed in
the one tie among the 50 metadata-resolved cells, Guangzhou 113.25° E) and is
flagged `tie` so the choice is auditable and disclosed with the grid point.
"""
import math

LAT_CELLS = 1801
LON_CELLS = 3600
TILE_SHAPE = (4, 8)
TIE_EPSILON_DEG = 1e-6


def _index(offset_tenths, size):
    below = math.floor(offset_tenths)
    tie = abs(offset_tenths - below - 0.5) < TIE_EPSILON_DEG * 10
    # Float error can put an exact x.x5 coordinate on either side of the midpoint.
    return (below + 1 if tie else math.floor(offset_tenths + 0.5)), tie


def map_coordinate(latitude, longitude):
    """Return the nearest ERA5-Land cell, its grid/tile index, and tie status."""
    if (not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float))
            or not math.isfinite(latitude) or not math.isfinite(longitude)
            or not -90 <= latitude <= 90 or not -180 <= longitude <= 180):
        raise ValueError('Invalid route coordinate')
    ilat, lat_tie = _index((latitude + 90) * 10, LAT_CELLS)
    # Axis starts at -179.9; -180.0 is the same meridian as 180.0 (last index).
    shifted = (longitude + 179.9) * 10
    if shifted < -0.5:
        shifted += LON_CELLS
    ilon, lon_tie = _index(shifted, LON_CELLS)
    ilon %= LON_CELLS
    ilat = min(max(ilat, 0), LAT_CELLS - 1)
    cell = [round(-90 + ilat / 10, 1), round(-179.9 + ilon / 10, 1)]
    return {
        'cell': cell,
        'gridIndex': [ilat, ilon],
        'tile': [ilat // TILE_SHAPE[0], ilon // TILE_SHAPE[1]],
        'tie': lat_tie or lon_tie,
    }


def cell_key(cell):
    return f'{cell[0]:.1f},{cell[1]:.1f}'


def haversine_km(lat, lon, other_lat, other_lon):
    a, b = math.radians(lat), math.radians(other_lat)
    dlat, dlon = b - a, math.radians(other_lon - lon)
    value = math.sin(dlat / 2) ** 2 + math.cos(a) * math.cos(b) * math.sin(dlon / 2) ** 2
    return 12742.0176 * math.asin(min(1, math.sqrt(value)))
