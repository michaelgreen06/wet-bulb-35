# Phase 2: City-page SEO scope

The SEO template work in this phase changes only city pages. It adds one city-specific H1, concise city metadata and introductory copy, visible geographic breadcrumbs, hemisphere-correct coordinate display, and a single methodology/data-source section. A sitewide visible-copy correction also standardizes “wet bulb” without a hyphen.

Visible copy uses “wet bulb” without a hyphen and describes the result as calculated; estimate language is reserved for the bottom disclaimer. OpenWeather is omitted from top-page copy. The bottom methodology section carries the provider phrase, link, and logo required by OpenWeather's published attribution guidance: https://openweathermap.org/faq.md

US titles use `City, State`; non-US titles use `City, administrative area, country` so identical city names retain country context. Canonical URLs, BreadcrumbList JSON-LD, static rendering, provider behavior, route inventory, and all non-city pages remain unchanged. Related-city links are intentionally out of scope.

The city entry in `tests/fixtures/hono-renderer-goldens.json` is intentionally refreshed for this approved city-only HTML change; its pre-Phase-2 provenance remains recorded in the fixture.
