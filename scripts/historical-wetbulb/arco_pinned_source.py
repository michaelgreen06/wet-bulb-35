#!/usr/bin/env python3
"""Content-pinned ARCO ERA5-Land tile × time-chunk source (approval-gated; never on page views).

The ARCO stores are appended in place (their .zmetadata digest changed between
2026-09-30 and 2026-10-04), so a metadata digest cannot pin values. This source
GETs each compressed upstream chunk object itself, records its SHA-256 and byte
length, and decodes only those bytes (Blosc/LZ4, little-endian float32, NaN
fill). One 33,792-hour chunk per variable serves all 32 cells of a 4×8 tile.

Before any non-pilot stage, a fetched pilot chunk must reproduce PR #41's
retained hourly values exactly (self-check.json), or acquisition stops.
"""
import hashlib
import json
import math
import struct
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TEMP_URL = 'https://arco.datastores.ecmwf.int/cadl-arco-geo-007/arco/reanalysis_era5_land/sfc-2m-temperature/geoChunked.zarr'
PRESS_URL = 'https://arco.datastores.ecmwf.int/cadl-arco-geo-009/arco/reanalysis_era5_land/sfc-pressure-precipitation/geoChunked.zarr'
FIELDS = (('t2m', TEMP_URL), ('d2m', TEMP_URL), ('sp', PRESS_URL))
CHUNK = (33_792, 4, 8)
MAX_OBJECT_BYTES = 40_000_000
HOUR_MS = 3_600_000
# Established stated-period bounds (PR #41): first hour 1950-01-02T00Z; last padded
# hour for local 2025 is 2026-01-02T23Z. Hours outside are never read into chunks,
# so later in-place appends cannot change the reduced inputs.
FIRST_MS = int(datetime(1950, 1, 2, tzinfo=timezone.utc).timestamp() * 1000)
LAST_MS = int(datetime(2026, 1, 2, 23, tzinfo=timezone.utc).timestamp() * 1000)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise PermissionError('Authenticated ARCO requests must not redirect')


def http_get(url, token, *, limit=MAX_OBJECT_BYTES):
    """Return bytes, or None for an absent Zarr chunk (404 = fill value)."""
    if not url.startswith((TEMP_URL, PRESS_URL)) or not token:
        raise PermissionError('Untrusted ARCO origin or missing private token')
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=120) as reply:
            data = reply.read(limit + 1)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    if len(data) > limit:
        raise ValueError('ARCO object exceeds the safety bound')
    return data


def validate_metadata(meta):
    for name, url in FIELDS:
        store = meta[url]
        array = store[f'{name}/.zarray']
        if (array['chunks'] != list(CHUNK) or array['dtype'] != '<f4' or array.get('filters')
                or array['compressor'].get('id') != 'blosc' or not (isinstance(array['fill_value'], str) or array['fill_value'] is None
                                                                     or math.isnan(array['fill_value']))
                or array['shape'][1:] != [1801, 3600] or array.get('order', 'C') != 'C'):
            raise ValueError(f'ARCO {name} layout changed; review before acquisition')
        attrs = store.get(f'{name}/.zattrs', {})
        if any(k in attrs for k in ('scale_factor', 'add_offset', '_FillValue', 'missing_value')):
            raise ValueError(f'ARCO {name} now uses CF encoding; review before acquisition')
    shapes = {meta[url][f'{name}/.zarray']['shape'][0] for name, url in FIELDS}
    if len(shapes) != 1:
        raise ValueError('ARCO field time axes differ in length')
    return shapes.pop()


def tile_cells(tile):
    """Cell keys of a 4×8 tile in Zarr C order (latitude index, then longitude index)."""
    keys = []
    for i in range(CHUNK[1]):
        for j in range(CHUNK[2]):
            ilat, ilon = tile[0] * CHUNK[1] + i, tile[1] * CHUNK[2] + j
            keys.append(f'{-90 + ilat / 10:.1f},{-179.9 + ilon / 10:.1f}' if ilat < 1801 and ilon < 3600 else None)
    return keys


def assemble(decoded, tile, wanted, first_hour, end_hour):
    """decoded: {field: flat float32 [33792][4][8] or None} → [hour][wanted cell][t2m,d2m,sp]."""
    keys = tile_cells(tile)
    positions = [keys.index(cell) for cell in wanted]
    nan = float('nan')
    values = []
    per_hour = CHUNK[1] * CHUNK[2]
    for h in range(first_hour, end_hour):
        base = h * per_hour
        for p in positions:
            for name, _ in FIELDS:
                block = decoded[name]
                values.append(nan if block is None else block[base + p])
    return values


class ArcoPinnedSource:
    name = 'arco'
    chunk_type = 'ARCO-pinned-chunks'

    def __init__(self, *, max_bytes, self_check_root, token=None, get=http_get, decode=None):
        self.token = token or self._token()
        self.get, self.max_bytes, self.used_bytes = get, max_bytes, 0
        self.decode = decode or self._blosc
        self.self_check_root = Path(self_check_root)
        raw = {url: self._fetch(url + '/.zmetadata', limit=2_000_000, count=False) for url in (TEMP_URL, PRESS_URL)}
        self.metadata_sha256 = {url: hashlib.sha256(raw[url]).hexdigest() for url in raw}
        self.meta = {url: json.loads(raw[url])['metadata'] for url in raw}
        self.time_length = validate_metadata(self.meta)
        self.times = self._time_axis()
        if FIRST_MS not in self.times or LAST_MS not in self.times:
            raise ValueError('ARCO time axis does not cover the stated period')
        self.first_index, self.last_index = self.times.index(FIRST_MS), self.times.index(LAST_MS)
        self.data_start_ms = FIRST_MS

    @staticmethod
    def _token():
        lines = dict(line.split(': ', 1) for line in (Path.home() / '.cdsapirc').read_text().splitlines() if ': ' in line)
        return lines.get('key', '')

    @staticmethod
    def _blosc(data, code='f'):
        import numcodecs  # optional research dependency
        raw = numcodecs.Blosc().decode(data)
        width = struct.calcsize(code)
        return struct.unpack(f'<{len(raw) // width}{code}', raw)

    def _fetch(self, url, *, limit=MAX_OBJECT_BYTES, count=True):
        data = self.get(url, self.token, limit=limit)
        if count and data is not None:
            self.used_bytes += len(data)
            if self.used_bytes > self.max_bytes:
                raise PermissionError('Approved ARCO byte cap reached; stopping')
        return data

    def _time_axis(self):
        array = self.meta[TEMP_URL]['time/.zarray']
        if array['dtype'] != '<i8' or self.meta[TEMP_URL]['time/.zattrs'].get('units') != 'hours since 1970-01-01':
            raise ValueError('ARCO time axis encoding changed; review before acquisition')
        values = []
        for k in range(math.ceil(array['shape'][0] / array['chunks'][0])):
            values += self.decode(self._fetch(f'{TEMP_URL}/time/{k}', count=False), 'q')
        values = [v * HOUR_MS for v in values[:array['shape'][0]]]
        if any(b - a != HOUR_MS for a, b in zip(values, values[1:])) or len(values) != self.time_length:
            raise ValueError('ARCO time axis is not contiguous hourly')
        return values

    def chunk_count(self, tile, cells):
        return self.last_index // CHUNK[0] - self.first_index // CHUNK[0] + 1

    def fetch(self, tile, cells, index):
        k = self.first_index // CHUNK[0] + index
        lo = max(k * CHUNK[0], self.first_index)
        hi = min((k + 1) * CHUNK[0], self.last_index + 1)
        decoded, objects = {}, []
        for name, url in FIELDS:
            key = f'{name}/{k}.{tile[0]}.{tile[1]}'
            data = self._fetch(f'{url}/{key}')
            objects.append({'key': key, 'absent': data is None} if data is None else
                           {'key': key, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
            block = None if data is None else self.decode(data, 'f')
            if block is not None and len(block) != CHUNK[0] * CHUNK[1] * CHUNK[2]:
                raise ValueError('Decoded ARCO chunk has an unexpected size')
            decoded[name] = block
        return {'cells': list(cells), 'start_ms': self.times[lo], 'hours': hi - lo,
                'values': assemble(decoded, tile, cells, lo - k * CHUNK[0], hi - k * CHUNK[0]),
                'source': {'type': 'ARCO-pinned-chunks', 'pinned': True,
                           'zmetadataSha256': self.metadata_sha256, 'objects': objects}}
