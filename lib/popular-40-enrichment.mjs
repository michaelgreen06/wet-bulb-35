import popular40Enrichment from "../data/popular-40-enrichment.v1.json" with { type: "json" };
import reviewedPopular40 from "../scripts/popular-40-geonames-map.json" with { type: "json" };
import tier1Manifest from "../scripts/tier1-city-manifest.json" with { type: "json" };

export const POPULAR_40_COUNT = 40;
const EXPECTED_POPULAR_PATHS = new Set(tier1Manifest.cities.filter((city) => city.popular).map((city) => city.path));
const EXPECTED_REVIEWED = new Map(reviewedPopular40.cities.map((city) => [city.path, city]));
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

function validPowerUrl(value, reviewed) {
  try {
    const url = new URL(value);
    const expected = new Map([
      ["parameters", "T2MWET"], ["community", "RE"],
      ["longitude", reviewed.longitude.toFixed(5)], ["latitude", reviewed.latitude.toFixed(5)],
      ["format", "JSON"], ["start", "1991"], ["end", "2020"],
    ]);
    return url.protocol === "https:" && url.hostname === "power.larc.nasa.gov"
      && url.pathname === "/api/temporal/climatology/point" && !url.hash && !url.username && !url.password
      && url.searchParams.size === expected.size
      && [...expected].every(([key, expectedValue]) => url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === expectedValue);
  } catch { return false; }
}

/** Fail closed before static or Worker rendering can consume enrichment data. */
export function validatePopular40Enrichment(value) {
  if (reviewedPopular40.schemaVersion !== 1 || EXPECTED_REVIEWED.size !== POPULAR_40_COUNT || EXPECTED_REVIEW_COHORT.size !== 10 || EXPECTED_POPULAR_PATHS.size !== POPULAR_40_COUNT || [...EXPECTED_REVIEWED.keys()].some((path) => !EXPECTED_POPULAR_PATHS.has(path)) || [...EXPECTED_REVIEW_COHORT].some((path) => !EXPECTED_POPULAR_PATHS.has(path))) throw new Error("Invalid reviewed Popular-40 map");
  if (!value || value.schemaVersion !== 1 || value.dataVersion !== "popular-40-2026-09-16" || !Array.isArray(value.cities)) throw new Error("Invalid Popular-40 enrichment manifest");
  requiredKeys(value, ["schemaVersion", "dataVersion", "provenance", "reviewCohort", "cities"], "Popular-40 manifest");
  if (!Array.isArray(value.reviewCohort) || value.reviewCohort.length !== 10 || new Set(value.reviewCohort).size !== 10 || value.reviewCohort.some((path) => !EXPECTED_REVIEW_COHORT.has(path))) throw new Error("Invalid Popular-40 review cohort");
  if (value.cities.length !== POPULAR_40_COUNT) throw new Error("Popular-40 enrichment must contain exactly 40 cities");
  requiredKeys(value.provenance, ["geonames", "beck", "nasaPower"], "Popular-40 provenance");
  requiredKeys(value.provenance.geonames, ["snapshot", "file", "sha256", "license", "url"], "GeoNames provenance");
  requiredKeys(value.provenance.beck, ["version", "period", "file", "sha256", "rasterSha256", "legendSha256", "method", "license", "url"], "Beck provenance");
  requiredKeys(value.provenance.nasaPower, ["accessedDate", "apiVersion", "parameter", "period", "timeStandard", "sourceLockSha256"], "NASA POWER provenance");
  if (value.provenance.geonames.snapshot !== "2026-09-16" || value.provenance.geonames.file !== "cities1000.zip" || value.provenance.geonames.sha256 !== "b0d39ebf8d1935d425f3efc1d90c881bdc83d7567ca6db1232973eaebc51e2e2" || value.provenance.geonames.license !== "CC BY 4.0" || value.provenance.geonames.url !== "https://download.geonames.org/export/dump/cities1000.zip"
      || value.provenance.beck.version !== "v3" || value.provenance.beck.period !== "1991-2020" || value.provenance.beck.file !== "koppen_geiger_tif.zip" || value.provenance.beck.sha256 !== "bb84453d4541f1a0bc5a804ead83f483c19ce70f16a5197f6d3a7b6a63e65562" || value.provenance.beck.rasterSha256 !== "2130f0071dfb2904947d8ec3a0d807fac71004df76e769262004f1602e4d6a13" || value.provenance.beck.legendSha256 !== "2ede2ad270a036cc11c31705a2c1dbf0314a8cf011fc972cd4a9665e3339e5e5" || value.provenance.beck.method !== "center plus 3x3 modal share" || value.provenance.beck.license !== "CC BY 4.0" || value.provenance.beck.url !== "https://doi.org/10.6084/m9.figshare.21789074.v3"
      || !/^\d{4}-\d{2}-\d{2}$/.test(value.provenance.nasaPower.accessedDate) || value.provenance.nasaPower.apiVersion !== "v2.9.7" || value.provenance.nasaPower.parameter !== "T2MWET" || value.provenance.nasaPower.period !== "1991-2020" || value.provenance.nasaPower.timeStandard !== "LST" || !/^[a-f0-9]{64}$/.test(value.provenance.nasaPower.sourceLockSha256)) throw new Error("Invalid Popular-40 provenance");
  const index = new Map();
  for (const city of value.cities) {
    requiredKeys(city, ["path", "geonames", "koppenGeiger", "nasaPower"], "Popular-40 city");
    const reviewed = EXPECTED_REVIEWED.get(city.path);
    if (typeof city.path !== "string" || !PATH_RE.test(city.path) || index.has(city.path) || !reviewed) throw new Error("Invalid Popular-40 path");
    requiredKeys(city.geonames, ["id", "timezone", "elevationM", "elevationSource"], "GeoNames enrichment");
    if (!Number.isSafeInteger(city.geonames.id) || city.geonames.id !== reviewed.geonameId || typeof city.geonames.timezone !== "string" || !city.geonames.timezone || !(city.geonames.elevationM === null || Number.isSafeInteger(city.geonames.elevationM)) || !(city.geonames.elevationSource === null || city.geonames.elevationSource === "elevation" || city.geonames.elevationSource === "dem") || (city.geonames.elevationM === null) !== (city.geonames.elevationSource === null)) throw new Error("Invalid GeoNames enrichment");
    requiredKeys(city.koppenGeiger, ["code", "label", "modalCode", "modalShare"], "Köppen-Geiger enrichment");
    if (!KOPPEN_RE.test(city.koppenGeiger.code) || !KOPPEN_RE.test(city.koppenGeiger.modalCode) || city.koppenGeiger.code !== city.koppenGeiger.modalCode || typeof city.koppenGeiger.label !== "string" || !city.koppenGeiger.label || !finiteNumber(city.koppenGeiger.modalShare) || city.koppenGeiger.modalShare < 0.67 || city.koppenGeiger.modalShare > 1) throw new Error("Invalid Köppen-Geiger enrichment");
    requiredKeys(city.nasaPower, ["monthlyC", "peakMonths", "requestUrl", "responseSha256"], "NASA POWER enrichment");
    if (!Array.isArray(city.nasaPower.monthlyC) || city.nasaPower.monthlyC.length !== 12 || city.nasaPower.monthlyC.some((month) => !finiteNumber(month) || month < -100 || month > 60 || Math.abs(month * 10 - Math.round(month * 10)) > 1e-9) || !Array.isArray(city.nasaPower.peakMonths) || !city.nasaPower.peakMonths.length || city.nasaPower.peakMonths.some((month) => !Number.isInteger(month) || month < 1 || month > 12) || !validPowerUrl(city.nasaPower.requestUrl, reviewed) || !/^[a-f0-9]{64}$/.test(city.nasaPower.responseSha256)) throw new Error("Invalid NASA POWER monthlyC, peakMonths, or provenance");
    const peak = Math.max(...city.nasaPower.monthlyC);
    if (city.nasaPower.peakMonths.some((month) => city.nasaPower.monthlyC[month - 1] !== peak)) throw new Error("Invalid NASA POWER peakMonths");
    index.set(city.path, city);
  }
  return index;
}

export const popular40EnrichmentByPath = validatePopular40Enrichment(popular40Enrichment);
export { popular40Enrichment };
