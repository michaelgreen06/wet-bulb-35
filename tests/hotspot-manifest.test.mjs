import assert from "node:assert/strict";
import test from "node:test";
import { buildHotspotCityManifest } from "../scripts/build-hotspot-city-manifest.mjs";

test("buildHotspotCityManifest preserves production route identity and coordinates", () => {
  const manifest = buildHotspotCityManifest([
    {
      name: "Springfield",
      resolvedCountryName: "United States",
      resolvedAdmin1Code: "Illinois",
      latitude: 39.798,
      longitude: -89.644,
    },
    {
      name: "Springfield",
      resolvedCountryName: "United States",
      resolvedAdmin1Code: "Massachusetts",
      latitude: 42.102,
      longitude: -72.589,
    },
  ]);

  assert.deepEqual(manifest, [
    {
      path: "/wetbulb-temperature/united-states/illinois/springfield/",
      name: "Springfield",
      state: "Illinois",
      country: "United States",
      latitude: 39.798,
      longitude: -89.644,
    },
    {
      path: "/wetbulb-temperature/united-states/massachusetts/springfield/",
      name: "Springfield",
      state: "Massachusetts",
      country: "United States",
      latitude: 42.102,
      longitude: -72.589,
    },
  ]);
});

test("buildHotspotCityManifest rejects missing route identity or invalid coordinates", () => {
  assert.throws(() => buildHotspotCityManifest([{
    name: "Broken",
    resolvedCountryName: "Country",
    resolvedAdmin1Code: "State",
    latitude: 91,
    longitude: 0,
  }]), /coordinates/);
});
