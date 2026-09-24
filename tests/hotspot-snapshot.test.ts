import { describe, expect, it } from "vitest";
import type { HotspotCandidate, HotspotRefinement } from "../lib/hotspots/open-meteo";
import { createHotspotSnapshot, isHotspotSnapshot, validateHotspotSnapshot } from "../lib/hotspots/snapshot";

const base: HotspotCandidate = {
  path: "/wetbulb-temperature/pakistan/sindh/jacobabad/",
  name: "Jacobabad",
  state: "Sindh",
  country: "Pakistan",
  latitude: 28.281,
  longitude: 68.437,
  selectionReason: "discovery",
  grid: { cellId: "28.2500:68.5000", latitude: 28.25, longitude: 68.5 },
};
const discovery = {
  source: "ecmwf-ifs-0.25",
  initialization: "2026-09-22T00:00:00Z",
  steps: [0, 3, 6, 9, 12, 15, 18, 21, 24],
  marginC: 2,
  thresholdC: 26,
  dilationRings: 1,
  globalLandMaximumC: 34.4,
};

function refinement({ candidate = base, maximumWetBulbC = 33.2, peakTime = "2026-09-22T17:00:00Z", modelCellId = "28.2500:68.5000" }: { candidate?: HotspotCandidate; maximumWetBulbC?: number; peakTime?: string; modelCellId?: string } = {}): HotspotRefinement {
  return {
    candidate,
    modelCell: { cellId: modelCellId, latitude: candidate.latitude, longitude: candidate.longitude, elevationM: 50 },
    maximumWetBulbC,
    peakTime,
    airTemperatureC: 39,
    dewPointC: 28,
    surfacePressureHpa: 1000,
    validFrom: "2026-09-22T01:00:00Z",
    validTo: "2026-09-23T01:00:00Z",
  };
}

describe("global hotspot snapshot", () => {
  it("ranks deterministically and emits at most one city for each refined model cell", () => {
    const snapshot = createHotspotSnapshot({
      generatedAt: "2026-09-22T00:30:00Z",
      refinements: [
        refinement({ candidate: { ...base, path: "/wetbulb-temperature/pakistan/sindh/a/", name: "A" }, maximumWetBulbC: 33.2 }),
        refinement({ candidate: { ...base, path: "/wetbulb-temperature/pakistan/sindh/b/", name: "B" }, maximumWetBulbC: 34.1 }),
        refinement({ candidate: { ...base, path: "/wetbulb-temperature/india/west-bengal/kolkata/", name: "Kolkata", state: "West Bengal", country: "India", latitude: 22.5726, longitude: 88.3639, grid: { cellId: "22.5000:88.2500", latitude: 22.5, longitude: 88.25 } }, maximumWetBulbC: 34.1, peakTime: "2026-09-22T15:00:00Z", modelCellId: "22.5000:88.2500" }),
      ],
      corpusCount: 130_686,
      discovery,
    });

    expect(snapshot.hotspots).toHaveLength(2);
    expect(snapshot.hotspots.map((entry) => entry.path)).toEqual([
      "/wetbulb-temperature/india/west-bengal/kolkata/",
      "/wetbulb-temperature/pakistan/sindh/b/",
    ]);
    expect(snapshot.hotspots.map((entry) => entry.rank)).toEqual([1, 2]);
    expect(snapshot.counts).toEqual({
      corpus: 130_686,
      candidates: 3,
      discoveredCandidates: 3,
      excludedControls: 0,
      refined: 3,
      uniqueModelCells: 2,
      published: 2,
    });
    expect(snapshot.validation).toEqual({ excludedControlSample: 0, controlsInTop20: 0, maxExcludedControlWetBulbC: null, recallWarning: false });
    expect(isHotspotSnapshot(snapshot)).toBe(true);
  });

  it("raises a recall warning when an excluded control enters the top 20", () => {
    const control: HotspotCandidate = {
      ...base,
      path: "/wetbulb-temperature/control/example/",
      name: "Control",
      selectionReason: "excluded-control",
      grid: null,
    };
    const snapshot = createHotspotSnapshot({
      generatedAt: "2026-09-22T00:30:00Z",
      refinements: [refinement(), refinement({ candidate: control, maximumWetBulbC: 35, modelCellId: "control-cell" })],
      corpusCount: 130_686,
      discovery,
    });
    expect(snapshot.validation).toEqual({ excludedControlSample: 1, controlsInTop20: 1, maxExcludedControlWetBulbC: 35, recallWarning: true });
  });

  it("rejects an invalid, non-ranked, or duplicate-cell snapshot", () => {
    const snapshot = createHotspotSnapshot({ generatedAt: "2026-09-22T00:30:00Z", refinements: [refinement()], corpusCount: 130_686, discovery });
    const duplicate = structuredClone(snapshot);
    duplicate.hotspots.push({ ...duplicate.hotspots[0], rank: 2 });
    duplicate.counts.published = 2;
    duplicate.counts.uniqueModelCells = 2;
    expect(validateHotspotSnapshot(duplicate).success).toBe(false);

    const malformed = structuredClone(snapshot);
    malformed.hotspots[0].rank = 2;
    expect(isHotspotSnapshot(malformed)).toBe(false);

    const noLongerFutureOnly = structuredClone(snapshot);
    noLongerFutureOnly.generatedAt = noLongerFutureOnly.validFrom;
    expect(validateHotspotSnapshot(noLongerFutureOnly).success).toBe(false);
  });
});
