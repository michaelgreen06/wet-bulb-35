import type { NextApiRequest, NextApiResponse } from 'next';
import type { HotspotSnapshot } from '@/lib/types/hotspots';
import { readHotspotSnapshot } from '@/lib/utils/hotspotSnapshot';

type ErrorResponse = {
  error: string;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<HotspotSnapshot | ErrorResponse>,
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const data = await readHotspotSnapshot();

    if (!data) {
      return res.status(404).json({
        error: 'No hotspot snapshot has been generated yet. Run npm run generate-hotspots.',
      });
    }

    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read forecast hotspot snapshot.';
    return res.status(500).json({ error: message });
  }
}
