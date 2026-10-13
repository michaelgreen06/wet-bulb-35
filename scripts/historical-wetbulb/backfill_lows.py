#!/usr/bin/env python3
"""Offline low-extrema backfill for tiles sealed before lows existed (issue #57).

For every sealed tile without low-status.json, re-reduces its retained, checksummed
hourly chunks with the pinned reducer. The reducer must reproduce every legacy high
file byte-for-byte and the sealed status exactly (hashed before and after); only the
versioned companion <group>/low-v1/{period,manifest}.json and the tile's
low-status.json are added. No network, no provider calls, never deletes anything.
Holds the output folder's run lock, so it can never overlap an acquisition writer.
"""
import argparse
import fcntl
import json
import shutil
import sys
import time
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = spec_from_file_location('run_tile_backfill', HERE / 'run_tile_backfill.py')
RUN = module_from_spec(spec)
spec.loader.exec_module(RUN)


def pending_tiles(out, source):
    return [p.parent for p in sorted((out / 'tiles' / source).glob('t*-*/status.json'))
            if not (p.parent / RUN.LOW_STATUS).exists()]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--source', default='arco')
    p.add_argument('--start-year', type=int, default=1950)
    p.add_argument('--end-year', type=int, default=2025)
    p.add_argument('--max-tiles', type=int, default=10_000)
    p.add_argument('--min-free-gb', type=float, default=40)
    p.add_argument('--workers', type=int, default=1, help='Tiles reduced concurrently (each one Node process)')
    a = p.parse_args()
    out = RUN.check_private_out(a.out)
    if a.min_free_gb < 10 or a.max_tiles < 1 or not 1 <= a.workers <= 4:
        raise SystemExit('Disk floor under 10 GB, no tiles requested, or workers outside 1–4')
    with (out / '.run.lock').open('a+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('Another run holds the lock for this output folder; refusing to start') from None
        todo = pending_tiles(out, a.source)
        done, lows, failed_low, started = 0, 0, 0, time.monotonic()
        outcome, error = 'finished', None

        def one(tile_dir):
            if shutil.disk_usage(out).free < a.min_free_gb * 1e9:
                raise OSError(f'Stopped: less than {a.min_free_gb:g} GB free')
            return tile_dir, RUN.backfill_tile_lows(tile_dir, out, start_year=a.start_year, end_year=a.end_year)

        try:
            with ThreadPoolExecutor(max_workers=a.workers) as pool:
                pending = {pool.submit(one, tile_dir) for tile_dir in todo[:a.max_tiles]}
                while pending:
                    finished, pending = wait(pending, return_when=FIRST_EXCEPTION)
                    for future in finished:
                        if future.exception():
                            for other in pending:
                                other.cancel()  # tiles not yet started stay untouched
                            raise future.exception()
                        tile_dir, record = future.result()
                        done += 1
                        lows += len(record['lowPeriods'])
                        failed_low += len(record['failedLowGroups'])
                        print(json.dumps({'tile': tile_dir.name, 'lowPeriods': len(record['lowPeriods']),
                                          'failedLowGroups': record['failedLowGroups'],
                                          'elapsedS': round(time.monotonic() - started)}), flush=True)
            if len(todo) > a.max_tiles:
                outcome = 'bounded'
        except BaseException as caught:
            outcome, error = 'failed', f'{type(caught).__name__}: {caught}'[:1000]
            raise
        finally:
            progress = {'schemaVersion': 1, 'source': a.source, 'lowSchema': RUN.LOW_SCHEMA, 'outcome': outcome, 'error': error,
                        'pendingAtStart': len(todo), 'tilesBackfilled': done, 'lowPeriods': lows, 'failedLowGroups': failed_low,
                        'remaining': len(pending_tiles(out, a.source)), 'updatedUTC': datetime.now(timezone.utc).isoformat()}
            RUN.durable_write(out / f'progress-lows-{a.source}.json', progress)
            print(json.dumps(progress), flush=True)
    sys.exit(1 if failed_low else 0)


if __name__ == '__main__':
    main()
