// Staging-only canonical paths, frozen against the private ranked pilot plan at build time.
export const HISTORICAL_PILOT_PATHS = Object.freeze([
  '/wetbulb-temperature/indonesia/jakarta/jakarta/',
  '/wetbulb-temperature/india/west-bengal/kolkata/',
  '/wetbulb-temperature/thailand/bangkok/bangkok/',
  '/wetbulb-temperature/bangladesh/dhaka-division/dhaka/',
  '/wetbulb-temperature/india/maharashtra/mumbai/',
  '/wetbulb-temperature/pakistan/sindh/karachi/',
  '/wetbulb-temperature/india/delhi/new-delhi/',
  '/wetbulb-temperature/hong-kong/hong-kong/hong-kong/',
  '/wetbulb-temperature/united-arab-emirates/dubai/dubai/',
  '/wetbulb-temperature/pakistan/punjab/lahore/',
] as const);

export function pilotPageAsset(path: string): string | null {
  if (!HISTORICAL_PILOT_PATHS.includes(path as typeof HISTORICAL_PILOT_PATHS[number])) return null;
  return `/preview/pages/${path.split('/').filter(Boolean).slice(1).join('--')}.html`;
}
