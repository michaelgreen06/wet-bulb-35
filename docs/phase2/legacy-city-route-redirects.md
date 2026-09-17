# Legacy city-route redirects

## Scope

The site published city-first routes (`/wetbulb-temperature/{city}/{state}/{country}`) before commit `154a295` inverted the hierarchy. The immutable source snapshot is its parent, commit `b83b6f33d3a1b2bb00551af3bd2f916c276c90c9`.

The historical inventory contained 130,684 rows and 129,089 unique paths. One advertised path had an empty city slug and was never a valid page; it intentionally remains a 404. Eight paths are also valid current routes and retain current-route precedence. The remaining 129,080 exact aliases redirect directly to current trailing-slash canonicals. Historical first-row behavior is preserved for 1,419 duplicate-path groups.

The canonical sitemap remains current-only. Legacy aliases are never added to it.

## Artifact contract

`scripts/legacy-city-route-redirects.v1.json` is a sanitized, versioned artifact containing exact alias-to-canonical mappings. It pins:

- the historical commit and source paths;
- SHA-256 hashes of the historical inventory and slug implementation;
- expected row, path, collision, overlap, invalid-path, and alias counts;
- a reviewed artifact SHA-256.

Normal builds consume the committed artifact and do not require Git history. Regeneration is an explicit maintenance action:

```sh
npm run generate:legacy-city-route-redirects
```

Regeneration requires the pinned historical commit to exist locally. Tests verify byte-identical regeneration when that object is available. A shallow checkout may skip only the regeneration test; artifact validation and production asset building still run.

## Runtime behavior

The asset build validates every target against the current route inventory, then creates private country-keyed metadata shards. Requests under `/locations/` remain inaccessible publicly.

The Worker:

1. resolves current routes first;
2. checks only an exact historical alias after current resolution fails;
3. sends a same-origin `308` directly to the current trailing-slash canonical while preserving the query string and HEAD semantics;
4. leaves unknown, malformed, API, asset, current, and numbered legacy-sitemap paths unchanged;
5. redirects `/sitemap-index.xml` and `/api/sitemap-index.xml` to the equivalent `/sitemap.xml` entry point.

Malformed metadata fails closed as an internal error rather than converting a valid legacy alias into a silent 404. Parsed legacy shards are bounded and concurrent loads are coalesced.

## Future canonical changes

Do not infer redirects by reversing the current route structure. If a canonical path changes, update the immutable artifact so every historical alias points directly to the newest canonical. Builds fail if any committed destination disappears or an alias begins conflicting with a current route. This prevents silent drift and redirect chains.
