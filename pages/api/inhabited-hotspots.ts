import type { NextApiRequest, NextApiResponse } from 'next';
import type { InhabitedHotspotSnapshot } from '@/lib/types/hotspots';
import { readInhabitedHotspotSnapshot } from '@/lib/utils/hotspotSnapshot';

type ErrorResponse = {
  error: string;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<InhabitedHotspotSnapshot | ErrorResponse>,
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const data = await readInhabitedHotspotSnapshot();

    if (!data) {
      return res.status(404).json({
        error:
          'No inhabited hotspot snapshot has been generated yet. Run npm run generate-hotspots.',
      });
    }

    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to read inhabited hotspot snapshot.';
    return res.status(500).json({ error: message });
  }
}
