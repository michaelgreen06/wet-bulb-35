import datetime as dt
import importlib.util
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).parents[1] / "scripts" / "download-gfs-hotspot-grid.py"
SPEC = importlib.util.spec_from_file_location("download_gfs_hotspot_grid", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class GfsDownloaderTests(unittest.TestCase):
    def test_hourly_steps_match_exact_inclusive_window(self):
        run = dt.datetime(2026, 9, 23, 18, tzinfo=dt.UTC)
        start = dt.datetime(2026, 9, 24, 1, tzinfo=dt.UTC)
        end = dt.datetime(2026, 9, 25, 0, tzinfo=dt.UTC)
        self.assertEqual(MODULE.hourly_steps(run, start, end), list(range(7, 31)))

    def test_window_must_contain_exactly_24_hourly_valid_times(self):
        run = dt.datetime(2026, 9, 23, 18, tzinfo=dt.UTC)
        with self.assertRaisesRegex(ValueError, "24 hourly"):
            MODULE.hourly_steps(
                run,
                dt.datetime(2026, 9, 24, 1, tzinfo=dt.UTC),
                dt.datetime(2026, 9, 24, 23, tzinfo=dt.UTC),
            )

    def test_index_parser_selects_exact_surface_fields(self):
        index = "\n".join([
            "1:0:d=2026092318:VIS:surface:24 hour fcst:",
            "2:100:d=2026092318:PRES:surface:24 hour fcst:",
            "3:250:d=2026092318:TMP:2 m above ground:24 hour fcst:",
            "4:400:d=2026092318:RH:2 m above ground:24 hour fcst:",
            "5:550:d=2026092318:DPT:2 m above ground:24 hour fcst:",
            "6:700:d=2026092318:LAND:surface:24 hour fcst:",
            "7:800:d=2026092318:ICEC:surface:24 hour fcst:",
        ])
        self.assertEqual(MODULE.forecast_ranges(index), [
            (100, 249, "PRES"),
            (250, 399, "TMP"),
            (550, 699, "DPT"),
        ])
        self.assertEqual(MODULE.land_mask_range(index), (700, 799, "LAND"))

    def test_range_download_requires_exact_content_range_and_grib_framing(self):
        response = mock.Mock(
            status_code=206,
            content=b"GRIBxxxx7777",
            headers={"content-range": "bytes 0-11/100"},
        )
        with mock.patch.object(MODULE.requests, "get", return_value=response):
            self.assertEqual(MODULE.get_range("https://example.test/file", 0, 11), b"GRIBxxxx7777")

        response.content = b"BAD!xxxx7777"
        with mock.patch.object(MODULE.requests, "get", return_value=response), self.assertRaisesRegex(RuntimeError, "GRIB framing"):
            MODULE.get_range("https://example.test/file", 0, 11)


if __name__ == "__main__":
    unittest.main()
