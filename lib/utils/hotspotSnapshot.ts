import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HotspotSnapshot, InhabitedHotspotSnapshot } from '@/lib/types/hotspots';

export const HOTSPOT_SNAPSHOT_PUBLIC_PATH = '/data/hotspots/latest.json';
export const INHABITED_HOTSPOT_SNAPSHOT_PUBLIC_PATH = '/data/hotspots/inhabited-latest.json';

export function getHotspotSnapshotPath(): string {
  return path.join(process.cwd(), 'public', 'data', 'hotspots', 'latest.json');
}

export function getInhabitedHotspotSnapshotPath(): string {
  return path.join(process.cwd(), 'public', 'data', 'hotspots', 'inhabited-latest.json');
}

export async function readHotspotSnapshot(): Promise<HotspotSnapshot | null> {
  try {
    const raw = await fs.readFile(getHotspotSnapshotPath(), 'utf8');
    return JSON.parse(raw) as HotspotSnapshot;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function readInhabitedHotspotSnapshot(): Promise<InhabitedHotspotSnapshot | null> {
  try {
    const raw = await fs.readFile(getInhabitedHotspotSnapshotPath(), 'utf8');
    return JSON.parse(raw) as InhabitedHotspotSnapshot;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function writeHotspotSnapshot(snapshot: HotspotSnapshot): Promise<void> {
  const filePath = getHotspotSnapshotPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

export async function writeInhabitedHotspotSnapshot(
  snapshot: InhabitedHotspotSnapshot,
): Promise<void> {
  const filePath = getInhabitedHotspotSnapshotPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}
