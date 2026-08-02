import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INHABITED_HOTSPOT_BLOB_CACHE_SECONDS,
  INHABITED_HOTSPOT_BLOB_PATH,
  publishInhabitedHotspotSnapshot,
} from '@/scripts/publish-inhabited-hotspots';
import type { InhabitedHotspotSnapshot } from '@/lib/types/hotspots';

function validSnapshot(): InhabitedHotspotSnapshot {
  return {
    schemaVersion: 1,
    label: 'Highest forecast wet-bulb among up to 1,000 grid-prioritized populated places.',
    scan: {
      algorithm: 'grid-cell-v1',
      forecastHours: 24,
      candidateCities: 1,
      populationQualifiedCities: 2,
      gridQualifiedCandidateCities: 1,
      maxCandidateCities: 1000,
      citiesExcludedByCandidateCap: 0,
      gatingMode: 'grid-cell',
      citiesScanned: 1,
      batchCount: 1,
      generatedAt: '2026-08-01T00:00:00Z',
      cacheHit: false,
    },
    thresholds: {
      tempC: 35,
      wetBulbC: 30,
    },
    minPopulation: 25000,
    limit: 50,
    hotspots: [
      {
        lat: 25,
        lon: 55,
        peakTempC: 39,
        peakTempTime: '2026-08-01T12:00:00Z',
        rhAtPeakTemp: 55,
        peakWetBulbC: 31,
        peakWetBulbTime: '2026-08-01T13:00:00Z',
        hotHours: [],
        city: {
          name: 'Example City',
          latitude: 25,
          longitude: 55,
          population: 100000,
        },
      },
    ],
    snapshot: {
      generatedBy: 'cron',
      source: 'open-meteo',
      expiresAt: '2026-08-02T06:00:00Z',
    },
  };
}

async function writeTempJson(value: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wetbulb-publish-test-'));
  const filePath = path.join(dir, 'snapshot.json');
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
  return filePath;
}

describe('publishInhabitedHotspotSnapshot', () => {
  it('uploads valid snapshots to the stable public Blob pathname', async () => {
    const snapshotPath = await writeTempJson(validSnapshot());
    const calls: unknown[][] = [];
    const putBlob = (async (...args: unknown[]) => {
      calls.push(args);
      return {
        url: 'https://example.blob.vercel-storage.com/inhabited/v1/latest.json',
      };
    }) as never;

    const result = await publishInhabitedHotspotSnapshot({ snapshotPath, putBlob });

    expect(result.url).toContain('/inhabited/v1/latest.json');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(INHABITED_HOTSPOT_BLOB_PATH);
    expect(calls[0][2]).toMatchObject({
      access: 'public',
      allowOverwrite: true,
      cacheControlMaxAge: INHABITED_HOTSPOT_BLOB_CACHE_SECONDS,
      contentType: 'application/json; charset=utf-8',
    });
  });

  it('does not call Blob put for invalid snapshots', async () => {
    const snapshot = validSnapshot() as unknown as Record<string, unknown>;
    delete snapshot.schemaVersion;
    const snapshotPath = await writeTempJson(snapshot);
    const putBlob = (async () => {
      throw new Error('put should not be called');
    }) as never;

    await expect(
      publishInhabitedHotspotSnapshot({ snapshotPath, putBlob }),
    ).rejects.toThrow('Refusing to publish invalid inhabited hotspot snapshot');
  });
});
