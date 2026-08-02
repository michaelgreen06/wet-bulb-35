import type { HotspotRegionId, RegionConfig } from '@/lib/types/hotspots';

export const HOTSPOT_REGIONS: Record<HotspotRegionId, RegionConfig> = {
  global: {
    id: 'global',
    label: 'Global land-focused scan',
    latMin: -90,
    latMax: 90,
    lonMin: -180,
    lonMax: 175,
    stepDeg: 5,
    strategy: 'two-pass',
    refinedStepDeg: 1,
    refinementRadiusDeg: 2,
    refinementCandidateCount: 12,
    maxLocationsPerMinute: 450,
    batchSize: 75,
    landFocused: true,
  },
  'arabian-peninsula': {
    id: 'arabian-peninsula',
    label: 'Arabian Peninsula',
    latMin: 12,
    latMax: 32,
    lonMin: 34,
    lonMax: 60,
    stepDeg: 2,
    strategy: 'single-pass',
    landFocused: true,
  },
};

export function getHotspotRegion(regionId: HotspotRegionId): RegionConfig {
  return HOTSPOT_REGIONS[regionId];
}
