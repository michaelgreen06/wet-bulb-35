#!/usr/bin/env python3
"""Collect sanitized private admin-dashboard panels (issue #53).

Writes one 0600 JSON document per panel outside Git. Prints only de-duplicated alert lines
(panel id, state and reason code) so a cron wrapper can forward material failures.
"""
from __future__ import annotations

import argparse
import os
import pathlib
import sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import admin_status as status


def collectors(args, now, environ):
    def site():
        return status.collect_site(args.origin, now=now)

    def top50():
        return status.collect_top50(args.origin, now=now, environ=environ)

    def search():
        service, site_url, call = status.gsc_from_environment(environ)
        return status.collect_search(service, site_url, now.date(), call, origin=args.origin)

    def ga4():
        return status.collect_ga4(status.ga4_from_environment(environ), now.date())

    return {"site": site, "top50": top50, "search": search, "ga4": ga4}


def main(argv=None, environ=None):
    environ = os.environ if environ is None else environ
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--panels", default=",".join(status.HOST_PANELS))
    parser.add_argument("--output-dir", default=str(status.DEFAULT_OUTPUT_DIR))
    parser.add_argument("--origin", default=status.DEFAULT_ORIGIN)
    parser.add_argument("--publish-kv", action="store_true",
                        help="upload to the approved private KV namespace (requires ADMIN_STATUS_KV_* configuration)")
    args = parser.parse_args(argv)
    panels = [panel.strip() for panel in args.panels.split(",") if panel.strip()]
    unknown = sorted(set(panels) - set(status.HOST_PANELS))
    if unknown:
        parser.error(f"unknown panels: {', '.join(unknown)}")
    if args.origin != status.DEFAULT_ORIGIN and not args.origin.startswith("https://"):
        parser.error("--origin must be https")

    now = datetime.now(timezone.utc)
    output_dir = pathlib.Path(args.output_dir)
    available = collectors(args, now, environ)
    docs = {}
    for panel in panels:
        previous = status.read_previous(output_dir, panel)
        doc = status.run_panel(panel, available[panel], previous, now)
        status.write_private(output_dir, panel, doc)
        docs[panel] = doc
        line = status.alert_line(doc, previous)
        if line:
            print(line)
    if args.publish_kv:
        try:
            status.publish_kv(docs, environ)
        except Exception as error:  # noqa: BLE001
            print(f"WetBulb35 admin status: publish skipped ({status.reason_for(error)})", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
