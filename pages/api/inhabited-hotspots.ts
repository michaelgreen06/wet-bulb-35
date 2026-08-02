import type { NextApiRequest, NextApiResponse } from 'next';
import type { InhabitedHotspotSnapshot } from '@/lib/types/hotspots';
import {
  readInhabitedHotspotSnapshot,
  validateInhabitedHotspotSnapshot,
} from '@/lib/utils/hotspotSnapshot';

type ErrorResponse = {
  error: string;
};

type DataSource = 'blob' | 'bundled-fallback';

const CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=3600';

async function readBlobSnapshot(): Promise<InhabitedHotspotSnapshot | null> {
  const url = process.env.INHABITED_HOTSPOT_DATA_URL?.trim();

  if (!url) {
    return null;
  }

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  return validateInhabitedHotspotSnapshot(payload) ? payload : null;
}

async function loadSnapshot(): Promise<{
  data: InhabitedHotspotSnapshot | null;
  source: DataSource;
}> {
  const blobSnapshot = await readBlobSnapshot().catch(() => null);

  if (blobSnapshot) {
    return { data: blobSnapshot, source: 'blob' };
  }

  return {
    data: await readInhabitedHotspotSnapshot(),
    source: 'bundled-fallback',
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<InhabitedHotspotSnapshot | ErrorResponse>,
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const { data, source } = await loadSnapshot();

    if (!data) {
      return res.status(404).json({
        error:
          'No inhabited hotspot snapshot has been generated yet. Run npm run generate-inhabited-hotspots.',
      });
    }

    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.setHeader('X-Hotspot-Data-Source', source);
    return res.status(200).json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to read inhabited hotspot snapshot.';
    return res.status(500).json({ error: message });
  }
}
