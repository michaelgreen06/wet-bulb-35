#!/usr/bin/env python3
"""Plan or fetch the private NASA POWER snapshot for all-location climate context.

One point-API request per native MERRA-2 cell used by the canonical inventory, plus
route-coordinate validation requests proving routes resolve to their cell. The
default is a plan only; network requests require --approved-by. Responses, an
append-only fsync'd journal, status and the final source lock stay in a private
directory outside Git. Reruns verify existing checkpoints and resume.

Rate control: one request in flight, at most one start per --min-interval seconds
(default 2 s). 429 honours Retry-After with long exponential backoff; 5xx and network
errors back off too. Sustained throttling, contract changes, or checkpoint corruption
stop the run with a distinct exit code for a human to review.
"""
import argparse
import datetime as dt
import email.utils
import hashlib
import importlib.util
import json
import os
import random
import shutil
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("climate_generator", Path(__file__).with_name("generate-climate-context.py"))
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)

EXIT_THROTTLED, EXIT_CONTRACT, EXIT_INTEGRITY, EXIT_DISK = 3, 4, 5, 6
USER_AGENT = "wetbulb35-climate-context/1 (build-time snapshot; single request in flight)"
MIN_FREE_BYTES = 1024 ** 3


class Stop(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def plan(routes, popular_paths, samples, seed):
    cells = sorted({cell for lat, lon in routes.values() if (cell := GENERATOR.merra2_cell(lat, lon))})
    eligible = [path for path in routes if GENERATOR.merra2_cell(*routes[path]) is not None]
    fixed = sorted(path for path in popular_paths if path in routes and GENERATOR.merra2_cell(*routes[path]))
    rest = sorted(set(eligible) - set(fixed))
    validation = fixed + sorted(random.Random(seed).sample(rest, max(samples - len(fixed), 0)))
    return cells, validation


def check_response(body):
    """Parse and contract-check a response before it is checkpointed; returns the API version."""
    try:
        raw = json.loads(body)
        version = raw["header"]["api"]["version"]
    except (ValueError, KeyError, TypeError):
        raise Stop(EXIT_CONTRACT, "Response is not the expected POWER JSON") from None
    try:
        GENERATOR.validated_monthly(raw, version)
    except ValueError as error:
        raise Stop(EXIT_CONTRACT, str(error)) from None
    return version


def http_get(url, timeout):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read()


def retry_after_seconds(value, now):
    """Retry-After as delta-seconds or an HTTP-date (RFC 9110); None when absent or invalid."""
    value = (value or "").strip()
    if value.isdigit():
        return float(value)
    try:
        moment = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if moment is None or moment.tzinfo is None:
        return None
    return max(0.0, moment.timestamp() - now)


def write_durable(path, data):
    temporary = path.with_name(path.name + ".tmp")
    with open(temporary, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def read_journal(out, repair=False):
    """Verified checkpoint entries.

    Only complete newline-terminated lines count. A torn final line from a crash is
    dropped; with repair=True the journal is atomically rewritten without it so the
    next append starts on a clean line.
    """
    journal = out / "journal.jsonl"
    entries = {}
    if not journal.exists():
        return entries
    data = journal.read_bytes()
    complete, _, torn = data.rpartition(b"\n")
    if torn:
        if not repair:
            raise Stop(EXIT_INTEGRITY, "Journal ends with an incomplete line; resume to repair it")
        write_durable(journal, complete + b"\n" if complete else b"")
    for line in complete.split(b"\n") if complete else []:
        try:
            entry = json.loads(line)
        except ValueError:
            raise Stop(EXIT_INTEGRITY, "Corrupt journal line") from None
        response = out / entry["kind"] / f"{entry['file']}.json"
        if not response.exists() or GENERATOR.sha256(response) != entry["sha256"]:
            raise Stop(EXIT_INTEGRITY, f"Checkpoint hash mismatch for {entry['key']}")
        entries[(entry["kind"], entry["key"])] = entry
    return entries


class Fetcher:
    def __init__(self, out, min_interval, timeout, get=http_get, sleep=time.sleep, clock=time.monotonic,
                 max_failures=6, max_throttles_per_hour=6, log=print, wall=time.time):
        self.out, self.min_interval, self.timeout = out, min_interval, timeout
        self.get, self.sleep, self.clock, self.log, self.wall = get, sleep, clock, log, wall
        self.max_failures, self.max_throttles_per_hour = max_failures, max_throttles_per_hour
        self.last_start = None
        self.throttles = []
        self.latencies = []
        self.first_start = None

    def pace(self):
        if self.last_start is not None:
            wait = self.min_interval - (self.clock() - self.last_start)
            if wait > 0:
                self.sleep(wait)
        self.last_start = self.clock()
        if self.first_start is None:
            self.first_start = self.last_start

    def request(self, url):
        failures = 0
        while True:
            self.pace()
            started = self.clock()
            try:
                status, body = self.get(url, self.timeout)
                self.latencies.append(self.clock() - started)
                if status != 200:
                    raise Stop(EXIT_CONTRACT, f"Unexpected HTTP {status}")
                return body
            except urllib.error.HTTPError as error:
                failures += 1
                if error.code == 429:
                    now = self.clock()
                    self.throttles = [moment for moment in self.throttles if now - moment < 3600] + [now]
                    if len(self.throttles) >= self.max_throttles_per_hour:
                        raise Stop(EXIT_THROTTLED, "Sustained 429 throttling; stopping for review") from None
                    retry = retry_after_seconds((error.headers or {}).get("Retry-After"), self.wall())
                    wait = max(retry or 0, min(3600, 120 * 2 ** (failures - 1)))
                elif 500 <= error.code < 600:
                    retry = retry_after_seconds((error.headers or {}).get("Retry-After"), self.wall())
                    wait = max(retry or 0, min(1800, 30 * 2 ** (failures - 1)))
                else:
                    raise Stop(EXIT_CONTRACT, f"HTTP {error.code} from POWER; request contract needs review") from None
                reason = f"HTTP {error.code}"
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
                failures += 1
                wait, reason = min(1800, 30 * 2 ** (failures - 1)), type(error).__name__
            if failures >= self.max_failures:
                raise Stop(EXIT_THROTTLED, f"{failures} consecutive failures ({reason}); possible block, stopping for review")
            self.log(json.dumps({"retry": url, "reason": reason, "waitSeconds": wait}), flush=True)
            self.sleep(wait)

    def stats(self, remaining):
        latencies = sorted(self.latencies)
        # Start-to-start rate, so the pacing bound (<= 1 / min_interval) is directly comparable.
        rate = (len(self.latencies) - 1) / max(self.last_start - self.first_start, 1e-9) if len(self.latencies) > 1 else 0.0
        return {"requests": len(latencies), "p50Ms": round(statistics.median(latencies) * 1000),
                "p95Ms": round(latencies[min(len(latencies) - 1, int(0.95 * len(latencies)))] * 1000),
                "effectivePerSecond": round(rate, 3), "etaHours": round(remaining / rate / 3600, 2) if rate else None}


def run(jobs, out, fetcher, approved_by, log=print, max_requests=None):
    out.mkdir(parents=True, exist_ok=True)
    os.chmod(out, 0o700)
    for kind in ("cells", "validation"):
        (out / kind).mkdir(exist_ok=True)
    done = read_journal(out, repair=True)
    pending = [job for job in jobs if (job[0], job[1]) not in done][:max_requests]
    log(json.dumps({"verifiedCheckpoints": len(done), "pending": len(pending)}), flush=True)
    status_path = out / "status.json"
    with open(out / "journal.jsonl", "ab") as journal:
        for count, (kind, key, (lat, lon)) in enumerate(pending, 1):
            if shutil.disk_usage(out).free < MIN_FREE_BYTES:
                raise Stop(EXIT_DISK, "Less than 1 GiB free; stopping")
            url = GENERATOR.power_url(lat, lon)
            body = fetcher.request(url)
            version = check_response(body)
            digest = hashlib.sha256(body).hexdigest()
            name = key if kind == "cells" else digest
            write_durable(out / kind / f"{name}.json", body)
            entry = {"kind": kind, "key": key, "file": name, "url": url, "sha256": digest, "apiVersion": version,
                     "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "approvedBy": approved_by}
            journal.write((json.dumps(entry, sort_keys=True) + "\n").encode())
            journal.flush()
            os.fsync(journal.fileno())
            if count == 100 or count % 500 == 0 or count == len(pending):
                stats = fetcher.stats(len(pending) - count)
                write_durable(status_path, (json.dumps({"done": len(done) + count, "total": len(jobs), **stats}) + "\n").encode())
                log(json.dumps({"checkpoint": count, **stats}), flush=True)
    return read_journal(out)


def finalize(out, jobs, accessed_date):
    """Write the generator's source lock once every planned request is checkpointed."""
    done = read_journal(out)
    if any((kind, key) not in done for kind, key, _ in jobs):
        raise Stop(EXIT_INTEGRITY, "Cannot finalize before every planned request is checkpointed")
    entries = [done[(kind, key)] for kind, key, _ in jobs]
    lock = {"schemaVersion": 1, "accessedDate": accessed_date,
            "cells": sorted(({"cell": e["key"], "url": e["url"], "sha256": e["sha256"], "apiVersion": e["apiVersion"]}
                             for e in entries if e["kind"] == "cells"), key=lambda e: e["cell"]),
            "validation": sorted(({"path": e["key"], "url": e["url"], "sha256": e["sha256"], "apiVersion": e["apiVersion"]}
                                  for e in entries if e["kind"] == "validation"), key=lambda e: e["path"])}
    write_durable(out / "source-lock.json", (json.dumps(lock, indent=2) + "\n").encode())
    return lock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--route-index", required=True)
    parser.add_argument("--out-dir", required=True, help="private directory outside the repository")
    parser.add_argument("--tier1", default="scripts/tier1-city-manifest.json")
    parser.add_argument("--validation-samples", type=int, default=GENERATOR.MIN_VALIDATION_SAMPLES)
    parser.add_argument("--seed", type=int, default=20261003)
    parser.add_argument("--min-interval", type=float, default=2.0, help="seconds between request starts (>= 2)")
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--expected-count", type=int, default=130686)
    parser.add_argument("--max-requests", type=int, help="bounded probe: checkpoint at most this many new results")
    parser.add_argument("--approved-by", help="name of the person who approved this request volume")
    args = parser.parse_args()
    if args.min_interval < 2.0:
        raise SystemExit("--min-interval below the approved 2 s spacing")
    routes = GENERATOR.load_routes(args.route_index, args.expected_count)
    popular = {city["path"] for city in json.loads(Path(args.tier1).read_text())["cities"] if city.get("popular")}
    cells, validation = plan(routes, popular, args.validation_samples, args.seed)
    out = Path(args.out_dir).resolve()
    if Path(__file__).resolve().parents[1] in [out, *out.parents]:
        raise SystemExit("Refusing to write NASA responses inside the repository")
    jobs = [("cells", GENERATOR.cell_key(cell), GENERATOR.cell_center(cell)) for cell in cells]
    jobs += [("validation", path, routes[path]) for path in validation]
    print(json.dumps({"routes": len(routes), "cells": len(cells), "validation": len(validation), "requests": len(jobs),
                      "minimumHours": round(len(jobs) * args.min_interval / 3600, 2)}), flush=True)
    if not args.approved_by:
        print("Plan only: pass --approved-by=<name> after the request volume is approved.")
        return
    try:
        fetcher = Fetcher(out, args.min_interval, args.timeout)
        done = run(jobs, out, fetcher, args.approved_by, max_requests=args.max_requests)
        if len(done) < len(jobs):
            print(json.dumps({"complete": False, "checkpointed": len(done), "total": len(jobs)}), flush=True)
            return
        first = min(entry["fetchedAt"] for entry in done.values())[:10]
        lock = finalize(out, jobs, first)
        print(json.dumps({"complete": True, "cells": len(lock["cells"]), "validation": len(lock["validation"])}), flush=True)
    except Stop as stop:
        print(json.dumps({"stopped": str(stop), "exitCode": stop.code}), flush=True)
        raise SystemExit(stop.code) from None


if __name__ == "__main__":
    main()
