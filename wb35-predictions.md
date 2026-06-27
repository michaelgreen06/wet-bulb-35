# Wet Bulb 35 Forecast Hotspot MVP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add an MVP forecasting workflow to `michaelgreen06/wet-bulb-35` that identifies where forecast wet-bulb conditions are high, starting with an Arabian Peninsula regional scan over the next 24 hours.

**Architecture:** Keep the existing single-location current-weather experience intact, and add a parallel forecast-hotspot subsystem. Use Open-Meteo for hourly forecast temperature + relative humidity, batch multi-coordinate requests by region, compute wet-bulb hour-by-hour in server-side code, and return ranked hotspot cells plus simple clustering metadata through a new API route and a basic results page.

**Tech Stack:** Next.js 15, React 19, TypeScript, existing mixed `app/` + `pages/` routing, Open-Meteo forecast API, existing Stull wet-bulb formula utility, Vitest for new utility/service tests.

---

## 1. Current repo context

Observed repo shape from remote inspection:

- Existing app entrypoint: `app/page.tsx`
- Existing current-weather API: `pages/api/weather.ts`
- Existing current weather fetcher: `lib/utils/weather.ts`
- Existing wet-bulb calculation: `lib/utils/wetbulb.ts`
- Existing display component: `components/WeatherDisplay.tsx`
- Existing SEO/location pages under `pages/wetbulb-temperature/**`
- Existing app already mixes `app/` and `pages/`; do **not** rewrite routing structure in this MVP.

Important current-state observations:

1. The repo currently uses **OpenWeather current conditions** for a single point.
2. The repo does **not** yet have a forecast-hotspot model, region scan model, or wet-bulb scan pipeline.
3. The existing `calculateWetBulb()` helper throws outside `temperature [-20, 50]` and `relativeHumidity [5, 99]`; forecast pipelines should handle edge values more defensively.
4. There is no test harness in the current repo for this subsystem.

---

## 2. MVP scope

### In scope

Build an Arabian Peninsula hotspot forecast MVP that:

- scans a preset region approximately `lat 12..32`, `lon 34..60`
- uses **next 24 hours** of **hourly** Open-Meteo forecast data
- fetches at least:
  - `temperature_2m`
  - `relative_humidity_2m`
- computes **hourly wet-bulb** for each scanned grid cell
- returns hotspot cells where either:
  - `temperature >= configured threshold`, and/or
  - `wetBulb >= configured threshold`
- includes humidity in the output
- exposes results through a server API route
- provides a basic UI page for viewing results
- is structured so later expansion to global scanning is straightforward

### Out of scope for this MVP

- full-world production scan
- live map visualization
- database persistence
- user accounts
- cron/scheduled workers inside this repo
- reverse geocoding every cell in production response
- perfect geospatial polygons/isobands

---

## 3. Product behavior to implement

### Primary user story

A user opens a forecast hotspot page, chooses a preset region (initially Arabian Peninsula), and sees the hottest forecast cells over the next 24 hours with:

- peak air temperature
- relative humidity at the hottest hour
- peak wet-bulb over the 24-hour window
- hour of each peak
- list of “hot hours” meeting threshold criteria

### API behavior

New endpoint should support something like:

`GET /api/hotspots?region=arabian-peninsula&hours=24&tempThreshold=35&wetBulbThreshold=30`

Expected JSON shape:

```json
{
  "region": {
    "id": "arabian-peninsula",
    "label": "Arabian Peninsula",
    "latMin": 12,
    "latMax": 32,
    "lonMin": 34,
    "lonMax": 60,
    "stepDeg": 2
  },
  "scan": {
    "forecastHours": 24,
    "pointsScanned": 154,
    "batchCount": 2,
    "generatedAt": "2026-06-14T02:14:03Z"
  },
  "thresholds": {
    "tempC": 35,
    "wetBulbC": 30
  },
  "hotspots": [
    {
      "lat": 25.98,
      "lon": 48.0,
      "peakTempC": 45.8,
      "peakTempTime": "2026-06-14T12:00:00Z",
      "rhAtPeakTemp": 6,
      "peakWetBulbC": 30.9,
      "peakWetBulbTime": "2026-06-14T16:00:00Z",
      "hotHours": [
        {
          "time": "2026-06-14T12:00:00Z",
          "tempC": 45.8,
          "rh": 6,
          "wetBulbC": 25.7
        }
      ]
    }
  ]
}
```

### UI behavior

Create a simple page that:

- defaults to `region=arabian-peninsula`
- defaults to `tempThreshold=35`, `wetBulbThreshold=30`, `hours=24`
- fetches `/api/hotspots`
- shows loading/error states
- renders a sorted list of hotspots by severity
- highlights:
  - hottest air temperature
  - highest wet-bulb
  - most humid hotspot above threshold

Do **not** build a map first. A good list view is enough for MVP.

---

## 4. Architectural decisions

### 4.1 Keep current and forecast systems separate

Do **not** jam hotspot logic into `lib/utils/weather.ts` or `pages/api/weather.ts`.

Reason:
- current weather uses OpenWeather current endpoint
- hotspot forecasting uses Open-Meteo hourly multi-point forecast endpoint
- different response shapes, constraints, and caching/rate-limit behavior

### 4.2 Use Open-Meteo only for hotspot forecasting

Do not route forecast hotspot requests through OpenWeather.

Reason:
- Open-Meteo supports free multi-coordinate hourly forecast batching
- it matches the already-tested scan approach
- it avoids adding API-key dependency for the new subsystem

### 4.3 Build region presets as config

Use a typed region config instead of hardcoding bbox values in API handler.

Reason:
- Arabian Peninsula is MVP
- later regions (South Asia, Sahel, global subtropical belts) become trivial additions

### 4.4 Keep the first MVP server-side and synchronous

On-demand API scan is acceptable for Arabian Peninsula at 2° resolution.

Reason:
- ~154 points fits into a small number of batched requests
- enough to prove UX and architecture
- avoids premature worker infrastructure

### 4.5 Add response caching in the API layer

Use a short-lived in-memory cache, e.g. 5–15 minutes keyed by region + thresholds + hours.

Reason:
- protects against repeated scans
- reduces Open-Meteo rate-limit pressure
- sufficient for MVP and Vercel-style ephemeral environments

---

## 5. Files to add and modify

### New files

- `lib/types/hotspots.ts`
- `lib/config/hotspotRegions.ts`
- `lib/utils/openMeteoForecast.ts`
- `lib/utils/hotspotScan.ts`
- `lib/utils/hotspotCluster.ts` *(optional for MVP list grouping; create only if simple grouping is actually needed)*
- `pages/api/hotspots.ts`
- `components/HotspotFilters.tsx`
- `components/HotspotResults.tsx`
- `app/hotspots/page.tsx`
- `tests/lib/utils/wetbulb.test.ts`
- `tests/lib/utils/openMeteoForecast.test.ts`
- `tests/lib/utils/hotspotScan.test.ts`
- `vitest.config.ts`
- `tests/setup.ts`

### Files to modify

- `package.json`
- `lib/utils/wetbulb.ts`
- `app/page.tsx` *(optional: add link/card to hotspot page; do not block MVP on this)*
- `README.md`

---

## 6. Data model to use

Create `lib/types/hotspots.ts` with explicit types:

```ts
export type HotspotRegionId = 'arabian-peninsula';

export type RegionConfig = {
  id: HotspotRegionId;
  label: string;
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  stepDeg: number;
};

export type HourlyCellSample = {
  time: string;
  tempC: number;
  rh: number;
  wetBulbC: number;
};

export type HotspotCell = {
  lat: number;
  lon: number;
  peakTempC: number;
  peakTempTime: string;
  rhAtPeakTemp: number;
  peakWetBulbC: number;
  peakWetBulbTime: string;
  hotHours: HourlyCellSample[];
};

export type HotspotScanRequest = {
  regionId: HotspotRegionId;
  forecastHours: number;
  tempThresholdC: number;
  wetBulbThresholdC: number;
};

export type HotspotScanResponse = {
  region: RegionConfig;
  scan: {
    forecastHours: number;
    pointsScanned: number;
    batchCount: number;
    generatedAt: string;
  };
  thresholds: {
    tempC: number;
    wetBulbC: number;
  };
  hotspots: HotspotCell[];
};
```

---

## 7. Step-by-step implementation plan

### Task 1: Add test harness for utility-first development

**Objective:** Introduce a lightweight test setup before touching forecast logic.

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`

**Step 1: Add scripts and dev dependencies**

Add to `package.json`:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "@vitest/coverage-v8": "^2.1.0"
  }
}
```

**Step 2: Add Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8'
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.')
    }
  }
});
```

**Step 3: Run test command to verify setup**

Run:

```bash
npm install
npm test
```

Expected:
- install succeeds
- test command runs, even if no tests found initially

**Step 4: Commit**

```bash
git add package.json package-lock.json vitest.config.ts tests/setup.ts
git commit -m "test: add vitest harness for forecast hotspot work"
```

---

### Task 2: Harden wet-bulb utility for forecast pipelines

**Objective:** Make wet-bulb calculation safe for hourly forecast arrays and edge humidity values.

**Files:**
- Modify: `lib/utils/wetbulb.ts`
- Create: `tests/lib/utils/wetbulb.test.ts`

**Step 1: Write failing tests**

Create tests for:
- typical hot/dry values
- typical hot/humid values
- RH = 100 handling
- RH < 5 clamped or rejected consistently
- temperature above 50 handling policy

Use this policy for MVP:
- clamp RH into `[5, 99]`
- keep temperature as-is unless clearly invalid (`NaN`, `Infinity`)

Sample tests:

```ts
import { describe, expect, it } from 'vitest';
import { calculateWetBulb } from '@/lib/utils/wetbulb';

describe('calculateWetBulb', () => {
  it('returns a plausible wet-bulb for hot dry conditions', () => {
    expect(calculateWetBulb(45, 10)).toBeLessThan(35);
  });

  it('returns a higher wet-bulb for hotter humid conditions', () => {
    expect(calculateWetBulb(38, 60)).toBeGreaterThan(30);
  });

  it('does not throw on humidity of 100', () => {
    expect(() => calculateWetBulb(35, 100)).not.toThrow();
  });
});
```

**Step 2: Update utility implementation**

Refactor `lib/utils/wetbulb.ts` to:
- keep `kelvinToCelsius()` untouched
- add a small internal clamp helper
- reject only `NaN` / non-finite values
- clamp RH for formula compatibility

**Step 3: Run tests**

```bash
npm test -- wetbulb
```

Expected: passing tests.

**Step 4: Commit**

```bash
git add lib/utils/wetbulb.ts tests/lib/utils/wetbulb.test.ts
git commit -m "fix: harden wet-bulb calculation for forecast scans"
```

---

### Task 3: Add typed hotspot region config

**Objective:** Introduce region presets with Arabian Peninsula as the first supported scan target.

**Files:**
- Create: `lib/types/hotspots.ts`
- Create: `lib/config/hotspotRegions.ts`
- Create: `tests/lib/utils/hotspotScan.test.ts`

**Step 1: Add region types**

Add types shown above to `lib/types/hotspots.ts`.

**Step 2: Add region preset**

Create `lib/config/hotspotRegions.ts`:

```ts
import type { RegionConfig, HotspotRegionId } from '@/lib/types/hotspots';

export const HOTSPOT_REGIONS: Record<HotspotRegionId, RegionConfig> = {
  'arabian-peninsula': {
    id: 'arabian-peninsula',
    label: 'Arabian Peninsula',
    latMin: 12,
    latMax: 32,
    lonMin: 34,
    lonMax: 60,
    stepDeg: 2
  }
};
```

**Step 3: Add first test for region lookup / grid expectations**

Test expected point count for Arabian region at 2° spacing.

Expected point count:
- lat values: 12..32 inclusive => 11
- lon values: 34..60 inclusive => 14
- total => **154**

**Step 4: Run tests**

```bash
npm test -- hotspotScan
```

**Step 5: Commit**

```bash
git add lib/types/hotspots.ts lib/config/hotspotRegions.ts tests/lib/utils/hotspotScan.test.ts
git commit -m "feat: add hotspot region config for arabian peninsula"
```

---

### Task 4: Build Open-Meteo forecast client

**Objective:** Create an isolated client for multi-coordinate hourly forecast requests.

**Files:**
- Create: `lib/utils/openMeteoForecast.ts`
- Create: `tests/lib/utils/openMeteoForecast.test.ts`

**Step 1: Write failing tests for request building and parsing**

Test:
- coordinate batching into comma-separated lat/lon lists
- requested variables include `temperature_2m,relative_humidity_2m`
- response parser accepts both single-object and array response shapes

**Step 2: Implement client**

Create:

```ts
type ForecastPoint = {
  latitude: number;
  longitude: number;
  hourly: {
    time: string[];
    temperature_2m: number[];
    relative_humidity_2m: number[];
  };
};

export async function fetchOpenMeteoBatch(args: {
  coords: Array<{ lat: number; lon: number }>;
  forecastHours: number;
}): Promise<ForecastPoint[]> { /* ... */ }
```

Implementation requirements:
- use `fetch`
- call `https://api.open-meteo.com/v1/forecast`
- request:
  - `hourly=temperature_2m,relative_humidity_2m`
  - `timezone=GMT`
  - `forecast_hours=<n>`
- normalize output to `ForecastPoint[]`
- throw useful error messages on non-200 responses

**Step 3: Add simple backoff wrapper**

Add 429 retry policy:
- retry up to 3 times
- exponential-ish delay: 500ms, 1000ms, 2000ms

Keep it simple; no external retry library.

**Step 4: Run tests**

```bash
npm test -- openMeteoForecast
```

**Step 5: Commit**

```bash
git add lib/utils/openMeteoForecast.ts tests/lib/utils/openMeteoForecast.test.ts
git commit -m "feat: add open-meteo hourly forecast client"
```

---

### Task 5: Build the hotspot scan service

**Objective:** Convert a region config into grid points, fetch forecast batches, compute hourly wet-bulb, and return sorted hotspot cells.

**Files:**
- Create: `lib/utils/hotspotScan.ts`
- Modify: `tests/lib/utils/hotspotScan.test.ts`

**Step 1: Write failing tests for core scan behavior**

Test behaviors:
- generates full grid from bbox + step
- batches coordinates into fixed-size chunks (use 80 or 100)
- computes wet-bulb for each hourly sample
- includes a cell if **either** temp threshold or wet-bulb threshold is hit
- sorts hotspots by `peakWetBulbC desc`, then `peakTempC desc`

**Step 2: Implement helpers**

In `lib/utils/hotspotScan.ts`, add helpers:

```ts
export function generateGrid(region: RegionConfig): Array<{ lat: number; lon: number }> { /* ... */ }
export function chunkCoords<T>(items: T[], size: number): T[][] { /* ... */ }
export function summarizeForecastPoint(/* ... */): HotspotCell | null { /* ... */ }
export async function scanRegionForHotspots(/* ... */): Promise<HotspotScanResponse> { /* ... */ }
```

**Step 3: Severity/sorting policy**

Use this output policy for MVP:
- keep a point if any hour satisfies:
  - `tempC >= tempThreshold`, or
  - `wetBulbC >= wetBulbThreshold`
- `peakTempC` = max temp over window
- `peakWetBulbC` = max wet-bulb over window
- `rhAtPeakTemp` = RH from the same hour as `peakTempC`
- `hotHours` = only hours satisfying one of the thresholds
- sort by:
  1. `peakWetBulbC desc`
  2. `peakTempC desc`
  3. `rhAtPeakTemp desc`

**Step 4: Add lightweight cache wrapper**

Inside this module or the API route, add in-memory cache:

```ts
const cache = new Map<string, { expiresAt: number; data: HotspotScanResponse }>();
```

Cache TTL: `10 minutes`

**Step 5: Run tests**

```bash
npm test -- hotspotScan
```

**Step 6: Commit**

```bash
git add lib/utils/hotspotScan.ts tests/lib/utils/hotspotScan.test.ts
git commit -m "feat: add server-side hotspot scan pipeline"
```

---

### Task 6: Expose hotspot scan through a new API route

**Objective:** Provide a stable JSON endpoint for the frontend and external automation.

**Files:**
- Create: `pages/api/hotspots.ts`

**Step 1: Write the handler contract**

The route should:
- only allow `GET`
- validate:
  - `region`
  - `hours`
  - `tempThreshold`
  - `wetBulbThreshold`
- call `scanRegionForHotspots()`
- return JSON with proper cache headers

**Step 2: Implementation details**

Use defaults:
- `region=arabian-peninsula`
- `hours=24`
- `tempThreshold=35`
- `wetBulbThreshold=30`

Validation rules:
- `hours`: allow `1..48`, default `24`
- `tempThreshold`: allow `20..55`, default `35`
- `wetBulbThreshold`: allow `20..40`, default `30`

Set response header:

```ts
res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
```

**Step 3: Manual verification**

Run locally:

```bash
npm run dev
curl 'http://localhost:3000/api/hotspots?region=arabian-peninsula&hours=24&tempThreshold=35&wetBulbThreshold=30'
```

Expected:
- 200 JSON response
- non-empty `hotspots` array
- `pointsScanned` = `154`

**Step 4: Commit**

```bash
git add pages/api/hotspots.ts
git commit -m "feat: add hotspot forecast api route"
```

---

### Task 7: Build a simple hotspot results page

**Objective:** Add a basic UI for viewing forecast hotspots without a map.

**Files:**
- Create: `components/HotspotFilters.tsx`
- Create: `components/HotspotResults.tsx`
- Create: `app/hotspots/page.tsx`

**Step 1: Create filter component**

`components/HotspotFilters.tsx` should provide:
- region select (only Arabian Peninsula for now)
- temp threshold input
- wet-bulb threshold input
- forecast hours input
- refresh button

**Step 2: Create results component**

`components/HotspotResults.tsx` should render:
- summary metrics:
  - hotspots found
  - hottest cell temp
  - highest wet-bulb cell
- hotspot cards with:
  - lat/lon
  - peak temp and time
  - RH at peak temp
  - peak wet-bulb and time
  - list of hot hours

Suggested card fields:

```tsx
<article>
  <h3>{hotspot.lat.toFixed(2)}, {hotspot.lon.toFixed(2)}</h3>
  <p>Peak air temp: {hotspot.peakTempC.toFixed(1)}°C</p>
  <p>RH at hottest hour: {hotspot.rhAtPeakTemp}%</p>
  <p>Peak wet bulb: {hotspot.peakWetBulbC.toFixed(1)}°C</p>
</article>
```

**Step 3: Create page**

`app/hotspots/page.tsx` should:
- be a client page if stateful filters are used inline
- fetch `/api/hotspots`
- render loading/error states
- default to Arabian region + 24h + 35C temp + 30C wet-bulb

**Step 4: Manual verification**

Run:

```bash
npm run dev
```

Verify in browser:
- `/hotspots` loads
- result cards render
- changing thresholds triggers a refetch

**Step 5: Commit**

```bash
git add app/hotspots/page.tsx components/HotspotFilters.tsx components/HotspotResults.tsx
git commit -m "feat: add hotspot forecast ui"
```

---

### Task 8: Link MVP into the rest of the app

**Objective:** Make the new hotspot workflow discoverable without disturbing existing pages.

**Files:**
- Modify: `app/page.tsx`
- Optionally modify: `components/Header.tsx`

**Step 1: Add a simple link/card**

Add one CTA on the home page:
- “View forecast hotspots”
- links to `/hotspots`

**Step 2: Verify no regression**

Make sure:
- existing location search still works
- current-location behavior still works
- weather card still renders

**Step 3: Commit**

```bash
git add app/page.tsx components/Header.tsx
git commit -m "feat: link hotspot forecast page from main app"
```

---

### Task 9: Document the subsystem

**Objective:** Update README so another developer understands the new forecast flow.

**Files:**
- Modify: `README.md`

**Step 1: Add sections**

Document:
- difference between current single-location weather and hotspot forecast scan
- Open-Meteo dependency
- API route usage
- hotspot page URL
- threshold semantics
- rate-limit/caching notes

**Step 2: Example README snippet**

Include:

```md
## Forecast Hotspots MVP

This repo now includes a regional hotspot scan for forecast heat / wet-bulb risk.

- Page: `/hotspots`
- API: `/api/hotspots?region=arabian-peninsula&hours=24&tempThreshold=35&wetBulbThreshold=30`

The forecast scanner uses Open-Meteo hourly temperature and relative humidity,
then computes wet-bulb temperature server-side for each scanned grid cell.
```

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document forecast hotspot mvp"
```

---

## 8. Validation checklist

The coding agent should not call the feature done until all of these are true:

### Automated

- `npm test` passes
- no failing tests in:
  - `tests/lib/utils/wetbulb.test.ts`
  - `tests/lib/utils/openMeteoForecast.test.ts`
  - `tests/lib/utils/hotspotScan.test.ts`

### Manual

- `npm run dev` starts cleanly
- `GET /api/hotspots?region=arabian-peninsula&hours=24&tempThreshold=35&wetBulbThreshold=30` returns 200
- returned `pointsScanned` is `154`
- returned hotspots include humidity values
- returned hotspots include wet-bulb values
- `/hotspots` renders without crashing
- home page current-weather workflow still works

### Data sanity checks

For Arabian Peninsula results, expect to see hotspots broadly in/around:
- Eastern Saudi
- central Saudi / Riyadh region
- UAE / Oman interior
- Kuwait-border/Gulf interior
- southeast Iran edge of scan

If output contains zero hotspots or obviously cold cells, the scan logic is wrong.

---

## 9. Risks and pitfalls

### Risk 1: Open-Meteo rate limiting

Observed during research: minutely rate limits can produce 429s.

Mitigation:
- batch coordinates aggressively
- keep Arabian MVP at 2°
- add short retry logic
- add 10-minute API response cache

### Risk 2: Existing wet-bulb helper is too strict

Current implementation throws on humidity outside formula range.

Mitigation:
- clamp RH inputs for forecast use
- test edge cases explicitly

### Risk 3: Mixed app/pages routing confusion

Repo already uses both `app/` and `pages/`.

Mitigation:
- keep API route under `pages/api/`
- keep new UI page under `app/hotspots/page.tsx`
- do not refactor routing architecture in MVP

### Risk 4: UI overreach

A map would slow implementation.

Mitigation:
- deliver strong API + list UI first
- defer map until after hotspot ranking works reliably

### Risk 5: False assumption that hottest hour == highest wet-bulb hour

That is often false.

Mitigation:
- compute wet-bulb for every hour, not just the hottest-temp hour
- store both `peakTempTime` and `peakWetBulbTime`

---

## 10. Explicit non-goals for the coding agent

Do **not** do these during MVP unless separately requested:

- do not remove OpenWeather current-weather support
- do not refactor the whole app to one router system
- do not add a database
- do not add auth
- do not add world-scale scan jobs
- do not add Google Maps visualization first
- do not over-engineer clustering/polygons before the raw hotspot list works

---

## 11. Phase 2 after MVP (not part of this handoff)

Once Arabian MVP works, the next logical steps are:

1. add more region presets (`sahel`, `south-asia`, `global-subtropics`)
2. add two-pass scanning:
   - coarse global scan
   - refined local scan around hot cells
3. add clustering / “named area” summaries
4. add scheduled scans and cached snapshots
5. add a map overlay / heat layer
6. add severe-condition pages for SEO or sharing

---

## 12. Recommended first execution order for the coding agent

If the implementer wants the shortest low-risk path, do this in order:

1. Task 1 — test harness
2. Task 2 — harden wet-bulb util
3. Task 3 — region config + types
4. Task 4 — Open-Meteo client
5. Task 5 — hotspot scanner
6. Task 6 — API route
7. Verify API manually before any UI
8. Task 7 — hotspot page
9. Task 8 — homepage link
10. Task 9 — docs

That keeps the feature backend-first, testable, and easy to review.
