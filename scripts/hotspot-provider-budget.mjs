#!/usr/bin/env node
/** Conservative account-wide Open-Meteo public endpoint envelope for one daily run. */
export function calculateDailyBudget({ locations, refinementAttempts = 3, pinnedLocations = 50, pinnedAttempts = 3, forecastAttempts = 2000 }) {
  const values = { locations, refinementAttempts, pinnedLocations, pinnedAttempts, forecastAttempts };
  if (Object.values(values).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new TypeError("Budget inputs must be nonnegative integers");
  return locations * refinementAttempts + pinnedLocations * pinnedAttempts + forecastAttempts;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const mode = process.env.OPEN_METEO_API_MODE;
  if (mode !== "public-noncommercial" && mode !== "customer-commercial") throw new Error("Explicit Open-Meteo mode required");
  const locations = Number(process.env.HOTSPOT_RUN_LOCATION_LIMIT);
  const total = calculateDailyBudget({ locations });
  console.log(JSON.stringify({ mode, scheduledRunsPerDay: 1, locations, refinementAttempts: 3, pinnedLocations: 50, pinnedAttempts: 3, forecastAttempts: 2000, locationAttemptEnvelope: total }));
  // Public API requires fewer than 10,000 calls/day. Hold 1,000 for other use,
  // metadata, and measurement uncertainty; manual reruns are NOT budgeted here.
  if (mode === "public-noncommercial" && total > 9000) throw new Error("Daily public endpoint envelope exceeds 9,000 location attempts; refuse provider work");
}
