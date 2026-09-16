import popular40Enrichment from "../data/popular-40-enrichment.v1.json" with { type: "json" };
import reviewedPopular40 from "../scripts/popular-40-geonames-map.json" with { type: "json" };
import tier1Manifest from "../scripts/tier1-city-manifest.json" with { type: "json" };

export const POPULAR_40_COUNT = 40;
const EXPECTED_POPULAR_PATHS = new Set(tier1Manifest.cities.filter((city) => city.popular).map((city) => city.path));
const EXPECTED_REVIEWED_IDS = new Map(reviewedPopular40.cities.map((city) => [city.path, city.geonameId]));
const EXPECTED_REVIEW_COHORT = new Set(reviewedPopular40.reviewCohort);
const PATH_RE = /^\/wetbulb-temperature\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/$/;
const KOPPEN_RE = /^(?:A[fmw]|BW[hk]|BS[hk]|C[fsw][abc]|D[fsw][abcd]|E[TF])$/;

function requiredKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`Invalid ${label} keys`);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Fail closed before static or Worker rendering can consume enrichment data. */
export function validatePopular40Enrichment(value) {
  if (reviewedPopular40.schemaVersion !== 1 || EXPECTED_REVIEWED_IDS.size !== POPULAR_40_COUNT || EXPECTED_REVIEW_COHORT.size !== 10 || EXPECTED_POPULAR_PATHS.size !== POPULAR_40_COUNT || [...EXPECTED_REVIEWED_IDS.keys()].some((path) => !EXPECTED_POPULAR_PATHS.has(path)) || [...EXPECTED_REVIEW_COHORT].some((path) => !EXPECTED_POPULAR_PATHS.has(path))) throw new Error("Invalid reviewed Popular-40 map");
  if (!value || value.schemaVersion !== 1 || value.dataVersion !== "popular-40-2026-09-16" || !Array.isArray(value.cities)) throw new Error("Invalid Popular-40 enrichment manifest");
  requiredKeys(value, ["schemaVersion", "dataVersion", "provenance", "reviewCohort", "cities"], "Popular-40 manifest");
  if (!Array.isArray(value.reviewCohort) || value.reviewCohort.length !== 10 || new Set(value.reviewCohort).size !== 10 || value.reviewCohort.some((path) => !EXPECTED_REVIEW_COHORT.has(path))) throw new Error("Invalid Popular-40 review cohort");
  if (value.cities.length !== POPULAR_40_COUNT) throw new Error("Popular-40 enrichment must contain exactly 40 cities");
  if (!value.provenance || value.provenance.geonames?.sha256 !== "b0d39ebf8d1935d425f3efc1d90c881bdc83d7567ca6db1232973eaebc51e2e2" || value.provenance.beck?.sha256 !== "bb84453d4541f1a0bc5a804ead83f483c19ce70f16a5197f6d3a7b6a63e65562") throw new Error("Invalid Popular-40 provenance");
  const index = new Map();
  for (const city of value.cities) {
    requiredKeys(city, ["path", "geonames", "koppenGeiger", "nasaPower"], "Popular-40 city");
    if (typeof city.path !== "string" || !PATH_RE.test(city.path) || index.has(city.path) || !EXPECTED_REVIEWED_IDS.has(city.path)) throw new Error("Invalid Popular-40 path");
    requiredKeys(city.geonames, ["id", "timezone", "elevationM", "elevationSource"], "GeoNames enrichment");
    if (!Number.isSafeInteger(city.geonames.id) || city.geonames.id !== EXPECTED_REVIEWED_IDS.get(city.path) || typeof city.geonames.timezone !== "string" || !city.geonames.timezone || !(city.geonames.elevationM === null || Number.isSafeInteger(city.geonames.elevationM)) || !(city.geonames.elevationSource === null || city.geonames.elevationSource === "elevation" || city.geonames.elevationSource === "dem") || (city.geonames.elevationM === null) !== (city.geonames.elevationSource === null)) throw new Error("Invalid GeoNames enrichment");
    requiredKeys(city.koppenGeiger, ["code", "label", "modalCode", "modalShare"], "Köppen-Geiger enrichment");
    if (!KOPPEN_RE.test(city.koppenGeiger.code) || !KOPPEN_RE.test(city.koppenGeiger.modalCode) || city.koppenGeiger.code !== city.koppenGeiger.modalCode || typeof city.koppenGeiger.label !== "string" || !city.koppenGeiger.label || !finiteNumber(city.koppenGeiger.modalShare) || city.koppenGeiger.modalShare < 0.67 || city.koppenGeiger.modalShare > 1) throw new Error("Invalid Köppen-Geiger enrichment");
    requiredKeys(city.nasaPower, ["monthlyC", "peakMonths", "requestUrl", "responseSha256"], "NASA POWER enrichment");
    if (!Array.isArray(city.nasaPower.monthlyC) || city.nasaPower.monthlyC.length !== 12 || city.nasaPower.monthlyC.some((month) => !finiteNumber(month) || month < -100 || month > 60 || Math.abs(month * 10 - Math.round(month * 10)) > 1e-9) || !Array.isArray(city.nasaPower.peakMonths) || !city.nasaPower.peakMonths.length || city.nasaPower.peakMonths.some((month) => !Number.isInteger(month) || month < 1 || month > 12) || !/^https:\/\/power\.larc\.nasa\.gov\/api\/temporal\/climatology\/point\?/.test(city.nasaPower.requestUrl) || !/^[a-f0-9]{64}$/.test(city.nasaPower.responseSha256)) throw new Error("Invalid NASA POWER monthlyC or peakMonths");
    const peak = Math.max(...city.nasaPower.monthlyC);
    if (city.nasaPower.peakMonths.some((month) => city.nasaPower.monthlyC[month - 1] !== peak)) throw new Error("Invalid NASA POWER peakMonths");
    index.set(city.path, city);
  }
  return index;
}

export const popular40EnrichmentByPath = validatePopular40Enrichment(popular40Enrichment);
export { popular40Enrichment };
