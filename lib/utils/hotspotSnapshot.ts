import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { InhabitedHotspotSnapshot } from '@/lib/types/hotspots';

export const INHABITED_HOTSPOT_SNAPSHOT_PUBLIC_PATH = '/data/hotspots/inhabited-latest.json';

export function getInhabitedHotspotSnapshotPath(): string {
  return path.join(process.cwd(), 'public', 'data', 'hotspots', 'inhabited-latest.json');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isValidInhabitedHotspot(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }

  const city = value.city;

  return (
    isFiniteNumber(value.lat) &&
    isFiniteNumber(value.lon) &&
    isFiniteNumber(value.peakTempC) &&
    isIsoDateString(value.peakTempTime) &&
    isFiniteNumber(value.rhAtPeakTemp) &&
    isFiniteNumber(value.peakWetBulbC) &&
    isIsoDateString(value.peakWetBulbTime) &&
    Array.isArray(value.hotHours) &&
    isObject(city) &&
    typeof city.name === 'string' &&
    isFiniteNumber(city.latitude) &&
    isFiniteNumber(city.longitude) &&
    isFiniteNumber(city.population)
  );
}

export function validateInhabitedHotspotSnapshot(
  value: unknown,
): value is InhabitedHotspotSnapshot {
  if (!isObject(value)) {
    return false;
  }

  const scan = value.scan;
  const thresholds = value.thresholds;
  const snapshot = value.snapshot;
  const hotspots = value.hotspots;

  if (
    value.schemaVersion !== 1 ||
    typeof value.label !== 'string' ||
    !isObject(scan) ||
    scan.algorithm !== 'grid-cell-v1' ||
    !isFiniteNumber(scan.forecastHours) ||
    !isFiniteNumber(scan.candidateCities) ||
    !isFiniteNumber(scan.citiesScanned) ||
    !isFiniteNumber(scan.batchCount) ||
    !isIsoDateString(scan.generatedAt) ||
    !isObject(thresholds) ||
    !isFiniteNumber(thresholds.tempC) ||
    !isFiniteNumber(thresholds.wetBulbC) ||
    !isFiniteNumber(value.minPopulation) ||
    !isFiniteNumber(value.limit) ||
    !Array.isArray(hotspots) ||
    !isObject(snapshot) ||
    (snapshot.generatedBy !== 'cron' && snapshot.generatedBy !== 'manual') ||
    snapshot.source !== 'open-meteo' ||
    (snapshot.expiresAt !== undefined && !isIsoDateString(snapshot.expiresAt))
  ) {
    return false;
  }

  if (
    scan.populationQualifiedCities !== undefined &&
    !isFiniteNumber(scan.populationQualifiedCities)
  ) {
    return false;
  }

  if (
    scan.gridQualifiedCandidateCities !== undefined &&
    !isFiniteNumber(scan.gridQualifiedCandidateCities)
  ) {
    return false;
  }

  if (
    scan.maxCandidateCities !== undefined &&
    !isFiniteNumber(scan.maxCandidateCities)
  ) {
    return false;
  }

  if (
    scan.citiesExcludedByCandidateCap !== undefined &&
    !isFiniteNumber(scan.citiesExcludedByCandidateCap)
  ) {
    return false;
  }

  for (let index = 0; index < hotspots.length; index += 1) {
    if (!isValidInhabitedHotspot(hotspots[index])) {
      return false;
    }

    const current = hotspots[index];
    const previous = hotspots[index - 1];
    if (
      index > 0 &&
      isObject(current) &&
      isObject(previous) &&
      isFiniteNumber(current.peakWetBulbC) &&
      isFiniteNumber(previous.peakWetBulbC) &&
      current.peakWetBulbC > previous.peakWetBulbC
    ) {
      return false;
    }
  }

  return true;
}

export async function readInhabitedHotspotSnapshot(): Promise<InhabitedHotspotSnapshot | null> {
  try {
    const raw = await fs.readFile(getInhabitedHotspotSnapshotPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (!validateInhabitedHotspotSnapshot(parsed)) {
      throw new Error('Bundled inhabited hotspot snapshot is invalid.');
    }

    return parsed;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function writeInhabitedHotspotSnapshot(
  snapshot: InhabitedHotspotSnapshot,
): Promise<void> {
  if (!validateInhabitedHotspotSnapshot(snapshot)) {
    throw new Error('Refusing to write invalid inhabited hotspot snapshot.');
  }

  const filePath = getInhabitedHotspotSnapshotPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}
