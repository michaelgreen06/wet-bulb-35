import { describe, expect, it } from "vitest";
import {
  buildHotspotOpenMeteoUrl,
  normalizeHotspotOpenMeteoResponse,
  refineHotspotCandidates,
} from "../lib/hotspots/open-meteo";
import { calculateRompsLiquidSaturationVaporPressurePa, calculateRompsWetBulbFromVaporPressureKelvin } from "../lib/forecast/romps";

const candidates = [
  {
    path: "/wetbulb-temperature/pakistan/sindh/jacobabad/",
    name: "Jacobabad",
    state: "Sindh",
    country: "Pakistan",
    latitude: 28.281,
    longitude: 68.437,
    selectionReason: "discovery",
    grid: { cellId: "28.2500:68.5000", latitude: 28.25, longitude: 68.5 },
  },
  {
    path: "/wetbulb-temperature/india/west-bengal/kolkata/",
    name: "Kolkata",
    state: "West Bengal",
    country: "India",
    latitude: 22.5726,
    longitude: 88.3639,
    selectionReason: "discovery",
    grid: { cellId: "22.5000:88.2500", latitude: 22.5, longitude: 88.25 },
  },
] as const;

function payloadFor(candidateIndex: number) {
  const time: string[] = [];
  const temperature_2m: number[] = [];
  const dew_point_2m: number[] = [];
  const surface_pressure: number[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    time.push(`2026-09-22T${String(hour).padStart(2, "0")}:00`);
    temperature_2m.push(hour === 15 ? 38 - candidateIndex : 30);
    dew_point_2m.push(hour === 15 ? 28 - candidateIndex : 24);
    surface_pressure.push(1000);
  }
  return {
    latitude: candidates[candidateIndex].latitude,
    longitude: candidates[candidateIndex].longitude,
    elevation: 50 + candidateIndex,
    timezone: "GMT",
    utc_offset_seconds: 0,
    hourly_units: {
      time: "iso8601",
      temperature_2m: "°C",
      dew_point_2m: "°C",
      surface_pressure: "hPa",
    },
    hourly: { time, temperature_2m, dew_point_2m, surface_pressure },
  };
}

describe("hotspot Open-Meteo refinement", () => {
  it("uses the fixed UTC 24-hour ECMWF request contract and supports customer credentials", () => {
    const url = buildHotspotOpenMeteoUrl(candidates, {
      baseUrl: "https://customer-api.open-meteo.com/v1/forecast",
      apiKey: "placeholder-value",
    });
    expect(url.origin + url.pathname).toBe("https://customer-api.open-meteo.com/v1/forecast");
    expect(url.searchParams.get("latitude")).toBe("28.281,22.5726");
    expect(url.searchParams.get("longitude")).toBe("68.437,88.3639");
    expect(url.searchParams.get("hourly")).toBe("temperature_2m,dew_point_2m,surface_pressure");
    expect(url.searchParams.get("forecast_hours")).toBe("24");
    expect(url.searchParams.get("timezone")).toBe("UTC");
    expect(url.searchParams.get("models")).toBe("ecmwf_ifs025");
    expect(url.searchParams.get("apikey")).toBe("placeholder-value");
    expect(() => buildHotspotOpenMeteoUrl(candidates, {
      baseUrl: "https://example.test/v1/forecast",
      apiKey: "placeholder-value"
    })).toThrow(/not approved/);
  });

  it("pins Single Runs refinement to the exact ECMWF initialization and filters its wider response", async () => {
    const options = {
      baseUrl: "https://single-runs-api.open-meteo.com/v1/forecast",
      modelInitialization: "2026-09-22T06:00:00Z",
      startHour: "2026-09-22T14:00",
      endHour: "2026-09-23T13:00",
    };
    const url = buildHotspotOpenMeteoUrl([candidates[0]], options);
    expect(url.searchParams.get("run")).toBe("2026-09-22T06:00");
    expect(url.searchParams.get("forecast_hours")).toBe("32");
    expect(url.searchParams.has("start_hour")).toBe(false);

    const wider = payloadFor(0);
    wider.hourly.time = Array.from({ length: 32 }, (_, hour) => new Date(Date.parse("2026-09-22T06:00:00Z") + hour * 3_600_000).toISOString().slice(0, 16));
    wider.hourly.temperature_2m = wider.hourly.time.map((_, hour) => hour === 15 ? 38 : 30);
    wider.hourly.dew_point_2m = wider.hourly.time.map((_, hour) => hour === 15 ? 28 : 24);
    wider.hourly.surface_pressure = wider.hourly.time.map(() => 1000);
    const result = await refineHotspotCandidates([candidates[0]], async () => new Response(JSON.stringify(wider)), options);
    expect(result[0].validFrom).toBe("2026-09-22T14:00:00Z");
    expect(result[0].validTo).toBe("2026-09-23T14:00:00Z");
  });

  it("maps ordered multi-location rows to trusted candidates and calculates hourly Romps maxima", () => {
    const refinements = normalizeHotspotOpenMeteoResponse([payloadFor(0), payloadFor(1)], candidates);
    expect(refinements).toHaveLength(2);
    expect(refinements[0].candidate).toEqual(candidates[0]);
    expect(refinements[0].modelCell).toEqual({ cellId: "28.2810:68.4370", latitude: 28.281, longitude: 68.437, elevationM: 50 });
    expect(refinements[0].peakTime).toBe("2026-09-22T15:00:00Z");
    expect(refinements[0].airTemperatureC).toBe(38);
    expect(refinements[0].dewPointC).toBe(28);
    expect(refinements[0].surfacePressureHpa).toBe(1000);
    expect(refinements[0].maximumWetBulbC).toBeCloseTo(calculateRompsWetBulbFromVaporPressureKelvin({
      pressurePa: 100_000,
      airTemperatureK: 311.15,
      vaporPressurePa: calculateRompsLiquidSaturationVaporPressurePa(301.15),
    }) - 273.15, 10);
  });

  it("fails closed for count/order coverage, resolved-cell, or unit failures", () => {
    expect(() => normalizeHotspotOpenMeteoResponse([payloadFor(0)], candidates)).toThrow(/count/);

    const outOfOrder = [payloadFor(0), payloadFor(1)];
    outOfOrder[1].hourly.time[3] = "2026-09-22T05:00";
    expect(() => normalizeHotspotOpenMeteoResponse(outOfOrder, candidates)).toThrow(/order/);

    const badUnits = payloadFor(0);
    badUnits.hourly_units.surface_pressure = "Pa";
    expect(() => normalizeHotspotOpenMeteoResponse(badUnits, [candidates[0]])).toThrow(/unit/);

    const farCell: ReturnType<typeof payloadFor> & { latitude: number } = payloadFor(0);
    farCell.latitude = 40;
    expect(() => normalizeHotspotOpenMeteoResponse(farCell, [candidates[0]])).toThrow(/far/);
  });

  it("uses the supplied fetch implementation and refuses failed responses", async () => {
    const fetchImpl = async (input: string | URL) => {
      expect(String(input)).toContain("models=ecmwf_ifs025");
      return new Response(JSON.stringify([payloadFor(0), payloadFor(1)]), { status: 200 });
    };
    await expect(refineHotspotCandidates(candidates, fetchImpl)).resolves.toHaveLength(2);
    await expect(refineHotspotCandidates(candidates, async () => new Response("no", { status: 503 }))).rejects.toThrow(/503/);
  });
});
