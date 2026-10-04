#!/usr/bin/env python3
"""Poll, within a bounded window, for the newest usable ECMWF IFS cycle.

A cycle is usable only when:
- the public ECMWF Open Data mirror's index for every forecast step that brackets the next
  24 future hours lists 2t, 2d, and sp rows for that exact run and step, and the step-0
  index lists the land-sea mask (an index file can exist before all of its rows); and
- Open-Meteo reports the same (or a newer) ``ecmwf_ifs025`` initialization as available and
  settled, so pinned Single Runs refinement can use the identical run.

Only lightweight index files (about 40 KB each) and Open-Meteo's static model metadata are fetched.
Readiness is never inferred from the scheduler's start time. The first poll that observed
the cycle usable is recorded separately from initialization and later retrieval times.
"""
import argparse
import datetime as dt
import email.utils
import importlib.util
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

_DOWNLOAD_PATH = Path(__file__).with_name("download-ecmwf-hotspot-grid.py")
_DOWNLOAD_SPEC = importlib.util.spec_from_file_location("download_ecmwf_hotspot_grid_shared", _DOWNLOAD_PATH)
if _DOWNLOAD_SPEC is None or _DOWNLOAD_SPEC.loader is None:
    raise RuntimeError(f"cannot load ECMWF window helpers from {_DOWNLOAD_PATH}")
DOWNLOAD = importlib.util.module_from_spec(_DOWNLOAD_SPEC)
_DOWNLOAD_SPEC.loader.exec_module(DOWNLOAD)

OPEN_METEO_METADATA_URL = "https://api.open-meteo.com/data/ecmwf_ifs025/static/meta.json"
# Open-Meteo copies new runs across redundant API servers for several minutes.
OPEN_METEO_SETTLE = dt.timedelta(minutes=10)
# ECMWF documents a 7-9 hour dissemination delay; earlier cycles cannot be complete.
EARLIEST_RELEASE = dt.timedelta(hours=5)
LOOKBACK = dt.timedelta(hours=30)
NOT_READY_EXIT = 3

IndexFunction = Callable[[str], tuple[int, dict[str, str], str]]
FORECAST_PARAMS = frozenset({"2t", "2d", "sp"})
MASK_PARAM = "lsm"
MAX_INDEX_BYTES = 1_000_000
MetadataFunction = Callable[[], tuple[int, dict[str, str], Any]]


class RetryLater(Exception):
    """A source asked us to slow down or failed transiently."""

    def __init__(self, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


def iso(value: dt.datetime) -> str:
    return value.astimezone(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamps must include a UTC offset")
    return parsed.astimezone(dt.UTC)


def retry_after_seconds(headers: dict[str, str], now: dt.datetime) -> float | None:
    value = next((headers[key] for key in headers if key.lower() == "retry-after"), None)
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            moment = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
        return max(0.0, (moment.astimezone(dt.UTC) - now).total_seconds())


def candidate_cycles(now: dt.datetime, published_initialization: dt.datetime | None) -> list[dt.datetime]:
    """Newest-first 00/06/12/18Z cycles that could be complete and are newer than the published one."""
    latest = (now - EARLIEST_RELEASE).replace(minute=0, second=0, microsecond=0)
    latest -= dt.timedelta(hours=latest.hour % 6)
    cycles = []
    cycle = latest
    while cycle > now - LOOKBACK:
        if published_initialization is None or cycle > published_initialization:
            cycles.append(cycle)
        cycle -= dt.timedelta(hours=6)
    return cycles


def required_steps(run: dt.datetime, now: dt.datetime) -> list[int]:
    start, end = DOWNLOAD.hourly_window(now)
    return DOWNLOAD.covering_steps(run, start, end)


def index_requirements(base_url: str, run: dt.datetime, steps: list[int]) -> list[tuple[str, int, frozenset[str]]]:
    """Index URL, step, and required params; 06/18Z cycles are published under the ``oper`` stream."""
    stamp = run.strftime("%Y%m%d%H%M%S")
    prefix = f"{base_url.rstrip('/')}/{run:%Y%m%d}/{run:%H}z/ifs/0p25/oper/{stamp}"
    required = {step: set(FORECAST_PARAMS) for step in steps}
    required.setdefault(0, set()).add(MASK_PARAM)
    # The last step is checked first: it is the latest to be disseminated.
    ordered = [steps[-1], *steps[:-1], *([0] if 0 not in steps else [])]
    return [(f"{prefix}-{step}h-oper-fc.index", step, frozenset(required[step])) for step in ordered]


def index_urls(base_url: str, run: dt.datetime, steps: list[int]) -> list[str]:
    return [url for url, _step, _params in index_requirements(base_url, run, steps)]


def listed_params(index_text: str, run: dt.datetime, step: int) -> set[str]:
    """Surface fields an ECMWF index lists for exactly this run and step, with a nonempty byte range."""
    params: set[str] = set()
    for line in index_text.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if (isinstance(row, dict)
                and row.get("date") == f"{run:%Y%m%d}" and row.get("time") == f"{run:%H}00"
                and row.get("type") == "fc" and row.get("stream") == "oper" and row.get("levtype") == "sfc"
                and str(row.get("step")) == str(step)
                and isinstance(row.get("_length"), int) and row["_length"] > 0
                and isinstance(row.get("param"), str)):
            params.add(row["param"])
    return params


def ecmwf_ready(fetch_index: IndexFunction, base_url: str, run: dt.datetime, steps: list[int], now: dt.datetime,
                log: Callable[[str], None] = lambda _message: None) -> bool:
    for url, step, required in index_requirements(base_url, run, steps):
        status, headers, text = fetch_index(url)
        if status in (429, 503):
            raise RetryLater(f"ECMWF mirror returned {status}", retry_after_seconds(headers, now))
        if status >= 500:
            raise RetryLater(f"ECMWF mirror returned {status}")
        if status != 200:
            return False
        missing = required - listed_params(text, run, step)
        if missing:
            # An index can be published before all of its field rows.
            log(f"{iso(run)} step {step}: index lacks {', '.join(sorted(missing))}.")
            return False
    return True


def open_meteo_ready(metadata: Any, run: dt.datetime, now: dt.datetime) -> tuple[bool, str | None]:
    if not isinstance(metadata, dict):
        return False, None
    initialization = metadata.get("last_run_initialisation_time")
    availability = metadata.get("last_run_availability_time")
    if not isinstance(initialization, int) or not isinstance(availability, int) or isinstance(initialization, bool):
        return False, None
    available_at = dt.datetime.fromtimestamp(availability, dt.UTC)
    ready = dt.datetime.fromtimestamp(initialization, dt.UTC) >= run and available_at + OPEN_METEO_SETTLE <= now
    return ready, iso(available_at)


def poll(
    *,
    fetch_index: IndexFunction,
    read_metadata: MetadataFunction,
    base_url: str,
    deadline: dt.datetime,
    published_initialization: dt.datetime | None,
    interval_seconds: float = 300,
    jitter_seconds: float = 60,
    max_backoff_seconds: float = 1_800,
    clock: Callable[[], dt.datetime] = lambda: dt.datetime.now(dt.UTC),
    sleep: Callable[[float], None] = time.sleep,
    rng: random.Random | None = None,
    log: Callable[[str], None] = lambda message: print(message, file=sys.stderr),
) -> dict[str, Any]:
    rng = rng or random.Random()
    checks = 0
    errors = 0
    ecmwf_first_seen: dict[str, str] = {}
    while True:
        now = clock()
        checks += 1
        wait = interval_seconds + rng.uniform(0, jitter_seconds)
        try:
            for run in candidate_cycles(now, published_initialization):
                try:
                    steps = required_steps(run, now)
                except ValueError:
                    continue
                if not ecmwf_ready(fetch_index, base_url, run, steps, now, log):
                    continue
                ecmwf_first_seen.setdefault(iso(run), iso(now))
                status, headers, metadata = read_metadata()
                if status in (429, 503) or status >= 500:
                    raise RetryLater(f"Open-Meteo metadata returned {status}", retry_after_seconds(headers, now))
                ready, available_at = open_meteo_ready(metadata if status == 200 else None, run, now)
                if not ready:
                    log(f"{iso(run)}: ECMWF steps are listed; Open-Meteo has not settled on this run yet.")
                    break
                return {
                    "ready": True,
                    "initialization": iso(run),
                    "date": run.date().isoformat(),
                    "time": run.hour,
                    "steps": steps,
                    "firstSeenReadyAt": iso(now),
                    "ecmwfFirstSeenAt": ecmwf_first_seen[iso(run)],
                    "openMeteoAvailableAt": available_at,
                    "checks": checks,
                }
            errors = 0
        except RetryLater as error:
            errors += 1
            backoff = min(max_backoff_seconds, interval_seconds * 2 ** (errors - 1))
            wait = max(wait, backoff, error.retry_after or 0)
            log(f"Readiness check deferred {wait:.0f}s: {error}")
        except (OSError, ValueError) as error:
            errors += 1
            wait = max(wait, min(max_backoff_seconds, interval_seconds * 2 ** (errors - 1)))
            log(f"Readiness check failed ({type(error).__name__}); retrying in {wait:.0f}s.")
        if now + dt.timedelta(seconds=wait) > deadline:
            return {"ready": False, "checks": checks, "deadline": iso(deadline), "ecmwfFirstSeen": ecmwf_first_seen}
        sleep(wait)


class MirrorIndex:
    """Reads index files on the same mirror the downloader uses (Azure needs a short-lived SAS token)."""

    def __init__(self, source: str):
        self.source = source
        self._client = None

    def client(self):
        if self._client is None:
            from ecmwf.opendata import Client

            self._client = Client(source=self.source, model="ifs", resol="0p25", infer_stream_keyword=False)
        return self._client

    @property
    def base_url(self) -> str:
        return self.client().url

    def __call__(self, url: str) -> tuple[int, dict[str, str], str]:
        for attempt in range(2):
            response = self.client().session.get(url, timeout=20, allow_redirects=True, stream=True)
            try:
                if response.status_code == 403 and self.source == "azure" and attempt == 0:
                    self._client = None  # expired SAS token
                    continue
                body = response.raw.read(MAX_INDEX_BYTES + 1, decode_content=True) if response.status_code == 200 else b""
                if len(body) > MAX_INDEX_BYTES:
                    raise ValueError(f"ECMWF index exceeds {MAX_INDEX_BYTES} bytes: {url}")
                return response.status_code, dict(response.headers), body.decode("utf-8", errors="replace")
            finally:
                response.close()
        return 403, {}, ""


def _http_metadata(url: str, timeout: float = 20) -> tuple[int, dict[str, str], Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "wetbulb35-readiness/1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), json.loads(response.read(65_536))
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()) if error.headers else {}, None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--deadline", required=True, help="UTC ISO timestamp after which polling stops")
    parser.add_argument("--published-initialization", help="initialization of the currently published snapshot; older or equal cycles are skipped")
    parser.add_argument("--source", default="azure", choices=("ecmwf", "aws", "azure"), help="must match the downloader's mirror")
    parser.add_argument("--open-meteo-metadata-url", default=OPEN_METEO_METADATA_URL)
    parser.add_argument("--interval-seconds", type=float, default=300)
    parser.add_argument("--jitter-seconds", type=float, default=60)
    args = parser.parse_args(argv)
    published = parse_iso(args.published_initialization) if args.published_initialization else None
    fetch_index = MirrorIndex(args.source)
    result = poll(
        fetch_index=fetch_index,
        read_metadata=lambda: _http_metadata(args.open_meteo_metadata_url),
        base_url=fetch_index.base_url,
        deadline=parse_iso(args.deadline),
        published_initialization=published,
        interval_seconds=args.interval_seconds,
        jitter_seconds=args.jitter_seconds,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(f".{args.output.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(json.dumps(result))
    return 0 if result["ready"] else NOT_READY_EXIT


if __name__ == "__main__":
    sys.exit(main())
