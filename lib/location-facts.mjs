/** Build-time only GeoNames-derived city facts; never imported in Worker runtime. */
import fs from 'node:fs';

export const LOCATION_FACTS_SHA256 = '0ba3eedb8b7c04f2b0fa9396e8c5f8746c432c76c4f247f63cc9fd63f39ceec5';

export function validateLocationFacts(artifact, canonicalPaths) {
  if (!artifact || artifact.v !== 1 || !artifact.source
    || artifact.source.dataset !== 'GeoNames cities1000'
    || artifact.source.sha256 !== LOCATION_FACTS_SHA256
    || !/^\d{4}-\d{2}-\d{2}$/.test(artifact.source.snapshot)
    || artifact.source.populationReferenceYear !== null
    || !artifact.byPath || typeof artifact.byPath !== 'object' || Array.isArray(artifact.byPath)) {
    throw new Error('Invalid location-facts provenance or schema');
  }
  const paths = new Set(canonicalPaths);
  if (paths.size !== canonicalPaths.length || Object.keys(artifact.byPath).length !== paths.size) {
    throw new Error('Location-facts route count does not match the canonical inventory');
  }
  const ids = new Set();
  const checkedZones = new Set();
  for (const [path, facts] of Object.entries(artifact.byPath)) {
    if (!paths.has(path)) throw new Error('Unexpected location-facts route');
    if (facts === null) continue;
    if (!Array.isArray(facts) || facts.length !== 5) throw new Error('Invalid location-facts row');
    const [id, population, timezone, elevation, source] = facts;
    if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)
      || (population !== null && (!Number.isSafeInteger(population) || population <= 0))
      || typeof timezone !== 'string' || !timezone || timezone.length > 80
      || (elevation !== null && (!Number.isInteger(elevation) || elevation < -1000 || elevation > 9000))
      || (elevation === null ? source !== null : !['elevation', 'dem'].includes(source))) {
      throw new Error('Invalid or ambiguous location-facts row');
    }
    if (!checkedZones.has(timezone)) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
      catch { throw new Error('Unsupported location-facts timezone'); }
      checkedZones.add(timezone);
    }
    ids.add(id);
  }
  return artifact;
}

export function loadLocationFacts(file = 'data/location-facts.v1.json') {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
