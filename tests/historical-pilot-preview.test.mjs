import test from 'node:test';
import assert from 'node:assert/strict';
import { pageHtml } from '../lib/page-renderer.mjs';

const city = { name: 'New Delhi', resolvedAdmin1Code: 'Delhi', resolvedCountryName: 'India', latitude: 28.6, longitude: 77.2, outputCitySlug: 'new-delhi' };
const monthly = Array.from({ length: 12 }, (_, i) => ({ valueC: 31.2, localDate: `2020-${String(i + 1).padStart(2, '0')}-15` }));
const history = { cell: [28.6, 77.2], timeZone: 'Asia/Kolkata', first: '1950-01-03', last: '2025-12-31', monthly, period: monthly[6], days: [] };

test('historical pilot preview uses the real city renderer without a live weather call', () => {
  const baseline = pageHtml(city, { googleAnalyticsId: '' });
  assert.doesNotMatch(baseline, /data-historical-wet-bulb(?:>|\s)/);
  assert.match(baseline, /data-weather-widget/);

  const preview = pageHtml(city, { googleAnalyticsId: '', historicalPilotPreview: true, historicalWetBulb: history, historyDistanceKm: 2.3 });
  assert.match(preview, /data-historical-wet-bulb(?:>|\s)/);
  assert.match(preview, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(preview, /Highest modeled hourly wet bulb by month/);
  assert.match(preview, /Private historical pilot preview/);
  assert.doesNotMatch(preview, /data-weather-widget|data-current-location|data-search-input/);
  assert.doesNotMatch(preview, /G-LNPWV0JL7S/);
});
