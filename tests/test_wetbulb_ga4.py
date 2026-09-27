import importlib.util
import json
import pathlib
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("wetbulb_ga4", ROOT / "scripts" / "wetbulb_ga4.py")
ga4 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ga4)

class Ga4CoreTests(unittest.TestCase):
    def test_normalizes_paths_and_classifies_pages(self):
        self.assertEqual(ga4.normalize_path("/wetbulb-temperature/us/texas/austin/?x=1"), "/wetbulb-temperature/us/texas/austin/")
        self.assertEqual(ga4.classify_page("/"), "homepage")
        self.assertEqual(ga4.classify_page("/wetbulb-temperature/"), "directory")
        self.assertEqual(ga4.classify_page("/wetbulb-temperature/us/"), "country")
        self.assertEqual(ga4.classify_page("/wetbulb-temperature/us/texas/"), "region")
        self.assertEqual(ga4.classify_page("/wetbulb-temperature/us/texas/austin/"), "city")

    def test_aggregates_synthetic_rows_without_raw_payload_persistence(self):
        rows = [
            {"hostName": "www.wetbulb35.com", "landingPagePlusQueryString": "/?a=1", "sessions": 10, "totalUsers": 5, "engagedSessions": 8},
            {"hostName": "www.wetbulb35.com", "landingPagePlusQueryString": "/?a=2", "sessions": 2, "totalUsers": 1, "engagedSessions": 1},
            {"hostName": "www.wetbulb35.com", "landingPagePlusQueryString": "(not set)", "sessions": 3, "totalUsers": 2, "engagedSessions": 0},
            {"hostName": "staging.example", "landingPagePlusQueryString": "/x", "sessions": 99, "totalUsers": 99, "engagedSessions": 99},
            {"hostName": "www.wetbulb35.com", "landingPagePlusQueryString": "/wetbulb-temperature/us/tx/austin", "sessions": 12, "totalUsers": 1, "engagedSessions": 3},
        ]
        summary = ga4.aggregate_pages(rows)
        self.assertEqual(summary["totals"]["sessions"], 24)
        self.assertEqual(summary["pages"][0]["path"], "/")
        self.assertEqual(summary["pages"][0]["sessions"], 12)
        self.assertEqual(len([page for page in summary["pages"] if page["path"] == "/"]), 1)
        self.assertEqual(summary["anomalies"]["not_set_landing_sessions"], 3)
        self.assertTrue(summary["anomalies"]["repeat_heavy_pages"])
        encoded = json.dumps(summary, sort_keys=True)
        self.assertNotIn("staging.example", encoded)
        self.assertNotIn("?a=1", encoded)

    def test_not_set_and_deterministic_serialization(self):
        sources = ga4.aggregate_dimension_rows([
            {"sessionSourceMedium": "(not set)", "sessions": 7},
            {"sessionSourceMedium": "google / organic", "sessions": 3},
        ], "sessionSourceMedium")
        self.assertEqual(sources["not_set_sessions"], 7)
        self.assertEqual(ga4.stable_json({"b": 1, "a": 2}), '{"a":2,"b":1}\n')
        self.assertIn("forecast_view", ga4.PRODUCT_EVENTS)
        self.assertNotIn("page_view", ga4.PRODUCT_EVENTS)

    def test_data_api_query_is_paginated_and_production_filtered(self):
        class Value:
            def __init__(self, value): self.value = value
        class Row:
            def __init__(self, dimension, metric):
                self.dimension_values = [Value(dimension)]
                self.metric_values = [Value(metric)]
        class Response:
            def __init__(self, rows): self.rows = rows
        class Client:
            def __init__(self): self.requests = []
            def run_report(self, request):
                self.requests.append(request)
                return Response([Row("google / organic", "2")]) if len(self.requests) == 1 else Response([])
        class DateRange:
            def __init__(self, **kwargs): self.kwargs = kwargs
        class Dimension:
            def __init__(self, **kwargs): self.kwargs = kwargs
        class Metric:
            def __init__(self, **kwargs): self.kwargs = kwargs
        class DimensionFilter:
            class StringFilter:
                class MatchType: EXACT = "EXACT"
                def __init__(self, **kwargs): self.kwargs = kwargs
            def __init__(self, **kwargs): self.kwargs = kwargs
        class DimensionFilterExpression:
            def __init__(self, **kwargs): self.kwargs = kwargs
        class Request:
            def __init__(self, **kwargs): self.kwargs = kwargs
        client = Client()
        with patch.object(ga4, "_api_types", return_value=(DateRange, Dimension, DimensionFilter, DimensionFilterExpression, Metric, Request)):
            rows = ga4.query_report(client, "2026-09-01", "2026-09-02", dimensions=("sessionSourceMedium",), metrics=("sessions",), page_size=1)
        self.assertEqual(rows, [{"sessionSourceMedium": "google / organic", "sessions": "2"}])
        self.assertEqual(len(client.requests), 2)
        self.assertEqual(client.requests[0].kwargs["property"], "properties/543514683")
        self.assertEqual(client.requests[0].kwargs["offset"], 0)
        self.assertEqual(client.requests[1].kwargs["offset"], 1)
        self.assertIn("dimension_filter", client.requests[0].kwargs)

if __name__ == "__main__":
    unittest.main()
