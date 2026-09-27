# GA4 product event contract

All product events use `event_version: 1` and `page_type` (`city` or `directory`). Production configuration alone may load GA; staging and preview leave the measurement ID empty. Bots, browser automation, missing `gtag`, and analytics exceptions are no-ops.

| Event | Bounded fields |
|---|---|
| `location_search_success`, `location_search_no_match` | `search_method`: `static`, `places` |
| `current_location_success` | none |
| `current_location_failure` | `failure_category`: `denied`, `timeout`, `unsupported`, `http`, `invalid_payload`, `network`, `unknown` |
| `weather_load_success`, `weather_load_failure` | `trigger`: `page_init`, `current_location`; failure also has `failure_category` |
| `forecast_view`, `forecast_load_failure` | failure has `failure_category` |
| `map_view`, `map_interaction` | interaction: `pointer`, `keyboard`, `zoom` |
| `hotspot_city_click` | `rank_bucket`: `top_10`, `top_25`, `top_50`, `other` |

Automatic events deduplicate once per widget/page. Map and hotspot hooks remain inert until matching markup exists. Never send search text, place names, route paths, coordinates, weather data, identifiers, or exception text.

## Manual GA property setup

After production validation, a GA4 property **Editor** performs this manually; the reporting service account remains Viewer-only and must never alter property settings.

1. In **Admin → Custom definitions**, create event-scoped custom dimensions for: `event_version`, `page_type`, `search_method`, `failure_category`, `trigger`, `interaction_type`, and `rank_bucket`. Use **Text** for enums and **Number** for `event_version`.
2. Wait for incoming production events and verify each parameter in DebugView or Realtime before relying on it in reporting. Do not backfill or upload historical values.
3. In **Admin → Events**, mark only `location_search_success`, `current_location_success`, and `hotspot_city_click` as key events if conversion reporting is wanted. Do not mark automatic weather or forecast load events as key events.
4. Reconfirm that no event parameter contains a query, city/place name, route, coordinates, weather value, identifier, or raw error before saving the configuration.
