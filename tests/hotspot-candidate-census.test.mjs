import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidate = {
  schemaVersion: 1, method: "romps-liquid", methodVersion: "2026-heatindex-0.0.2", discoveryBoundary: "candidate-only",
  model: { source: "ecmwf-ifs-0.25", initialization: "2026-10-18T00:00:00Z", steps: [8], grid: { latitudeCount: 721, longitudeCount: 1440 } },
  selection: { marginC: 1.5, thresholdC: 27, dilationRings: 1 },
  globalLandMaximum: { wetBulbC: 32 },
  cities: [{ path: "/wetbulb-temperature/pakistan/sindh/jacobabad/", name: "Jacobabad", state: "Sindh", country: "Pakistan", latitude: 28.281, longitude: 68.437, gridCell: { latitude: 28.25, longitude: 68.5 } }],
};
const manifest = [
  { path: candidate.cities[0].path, name: "Jacobabad", state: "Sindh", country: "Pakistan", latitude: 28.281, longitude: 68.437 },
  { path: "/wetbulb-temperature/india/west-bengal/kolkata/", name: "Kolkata", state: "West Bengal", country: "India", latitude: 22.5726, longitude: 88.3639 },
];

test("CLI saves an anonymous census artifact before overflow rejection and no snapshot", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "hotspot-census-"));
  try {
    const candidates = path.join(dir, "candidates.json");
    const cities = path.join(dir, "cities.json");
    const output = path.join(dir, "snapshot.json");
    const census = path.join(dir, "census.json");
    fs.writeFileSync(candidates, JSON.stringify(candidate));
    fs.writeFileSync(cities, JSON.stringify(manifest));
    const run = spawnSync(process.execPath, ["--experimental-strip-types", path.join(root, "scripts/generate-inhabited-hotspot-snapshot.ts"),
      "--candidates", candidates, "--city-manifest", cities, "--output", output, "--candidate-census-output", census], {
      cwd: root,
      env: { ...process.env, OPEN_METEO_API_MODE: "public-noncommercial", HOTSPOT_RUN_LOCATION_LIMIT: "1", HOTSPOT_EXCLUDED_SAMPLE_SIZE: "1" },
      encoding: "utf8", timeout: 30_000,
    });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /exceeds the configured per-run/);
    assert.equal(fs.existsSync(output), false);
    const record = JSON.parse(fs.readFileSync(census, "utf8"));
    assert.deepEqual(record, {
      schemaVersion: 1, initialization: "2026-10-18T00:00:00Z", discoveredCandidates: 1, excludedControls: 1,
      totalLocations: 2, locationLimit: 1, selection: { marginC: 1.5, thresholdC: 27, dilationRings: 1 },
    });
    assert.deepEqual(JSON.parse(run.stdout.trim()), { kind: "hotspot-candidate-census", ...record });
    assert.doesNotMatch(JSON.stringify(record), /Jacobabad|Kolkata|latitude|longitude|wetBulbC/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
