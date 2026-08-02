import { put } from '@vercel/blob';
import {
  getInhabitedHotspotSnapshotPath,
  validateInhabitedHotspotSnapshot,
} from '@/lib/utils/hotspotSnapshot';
import { promises as fs } from 'node:fs';

export const INHABITED_HOTSPOT_BLOB_PATH = 'inhabited/v1/latest.json';
export const INHABITED_HOTSPOT_BLOB_CACHE_SECONDS = 300;

type BlobPut = typeof put;

export async function publishInhabitedHotspotSnapshot(args: {
  snapshotPath?: string;
  putBlob?: BlobPut;
} = {}) {
  const snapshotPath = args.snapshotPath ?? getInhabitedHotspotSnapshotPath();
  const putBlob = args.putBlob ?? put;
  const raw = await fs.readFile(snapshotPath, 'utf8');
  const payload = JSON.parse(raw) as unknown;

  if (!validateInhabitedHotspotSnapshot(payload)) {
    throw new Error('Refusing to publish invalid inhabited hotspot snapshot.');
  }

  return putBlob(INHABITED_HOTSPOT_BLOB_PATH, raw, {
    access: 'public',
    allowOverwrite: true,
    cacheControlMaxAge: INHABITED_HOTSPOT_BLOB_CACHE_SECONDS,
    contentType: 'application/json; charset=utf-8',
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  publishInhabitedHotspotSnapshot()
    .then((blob) => {
      console.log(JSON.stringify(blob, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
