export type HotspotRegionId = 'global' | 'arabian-peninsula';

export type ScanStrategy = 'single-pass' | 'two-pass';

export type RegionConfig = {
  id: HotspotRegionId;
  label: string;
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  stepDeg: number;
  strategy: ScanStrategy;
  refinedStepDeg?: number;
  refinementRadiusDeg?: number;
  refinementCandidateCount?: number;
  maxLocationsPerMinute?: number;
  batchSize?: number;
  landFocused?: boolean;
};

export type HourlyCellSample = {
  time: string;
  tempC: number;
  rh: number;
  wetBulbC: number;
};

export type HotspotNearestLocation = {
  name: string;
  admin1: string;
  country: string;
  lat: number;
  lon: number;
  distanceKm: number;
  url: string;
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
  nearestLocation?: HotspotNearestLocation;
};

export type PopulatedCity = {
  name: string;
  countryCode?: string;
  country?: string;
  admin1Code?: string;
  admin1?: string;
  latitude: number;
  longitude: number;
  population: number;
};

export type InhabitedHotspotCell = HotspotCell & {
  city: PopulatedCity;
};

export type HotspotScanRequest = {
  regionId: HotspotRegionId;
  forecastHours: number;
  tempThresholdC: number;
  wetBulbThresholdC: number;
  limit: number;
};

export type HotspotScanResponse = {
  region: RegionConfig;
  scan: {
    forecastHours: number;
    coarsePointsScanned: number;
    refinedPointsScanned: number;
    pointsScanned: number;
    batchCount: number;
    generatedAt: string;
    cacheHit?: boolean;
  };
  thresholds: {
    tempC: number;
    wetBulbC: number;
  };
  limit: number;
  hotspots: HotspotCell[];
  gateCells?: HotspotCell[];
};

export type HotspotSnapshot = HotspotScanResponse & {
  snapshot: {
    generatedBy: 'cron' | 'manual';
    source: 'open-meteo';
    expiresAt?: string;
  };
};

export type InhabitedHotspotScanRequest = {
  forecastHours: number;
  tempThresholdC: number;
  wetBulbThresholdC: number;
  minPopulation: number;
  limit: number;
};

export type InhabitedHotspotScanResponse = {
  label: string;
  scan: {
    forecastHours: number;
    candidateCities: number;
    populationQualifiedCities?: number;
    gateCells?: number;
    gateRadiusKm?: number;
    maxCandidateCities?: number;
    citiesScanned: number;
    batchCount: number;
    generatedAt: string;
    cacheHit?: boolean;
  };
  thresholds: {
    tempC: number;
    wetBulbC: number;
  };
  minPopulation: number;
  limit: number;
  hotspots: InhabitedHotspotCell[];
};

export type InhabitedHotspotSnapshot = InhabitedHotspotScanResponse & {
  snapshot: {
    generatedBy: 'cron' | 'manual';
    source: 'open-meteo';
    expiresAt?: string;
  };
};
