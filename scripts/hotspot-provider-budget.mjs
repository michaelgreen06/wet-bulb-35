#!/usr/bin/env node
/** Conservative envelope, not actual provider usage or provider-side weighted billing. */
export function calculateDailyBudget({ locations, refinementAttempts = 3, forecastAttempts = 2000 }) {
  const values = { locations, refinementAttempts, forecastAttempts };
  if (Object.values(values).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new TypeError("Budget inputs must be nonnegative integers");
  return locations * refinementAttempts + forecastAttempts;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const mode = process.env.OPEN_METEO_API_MODE;
  if (mode !== "public-noncommercial" && mode !== "customer-commercial") throw new Error("Explicit Open-Meteo mode required");
  const locations = Number(process.env.HOTSPOT_RUN_LOCATION_LIMIT);
  const refinementAttempts = 3;
  const forecastAttempts = 2000;
  const batchSize = 100;
  const locationAttemptEnvelope = calculateDailyBudget({ locations, refinementAttempts, forecastAttempts });
  // Refinement is batched; forecast views each request one canonical location.
  const httpRequestEnvelope = Math.ceil(locations / batchSize) * refinementAttempts + forecastAttempts;
  console.log(JSON.stringify({ mode, scheduledRunsPerDay: 1, globalGridRetrievals: 1, refinementBatchSize: batchSize,
    locations, refinementAttempts, forecastAttempts, refinementHttpRequestEnvelope: Math.ceil(locations / batchSize) * refinementAttempts,
    onViewForecastHttpRequestEnvelope: forecastAttempts, httpRequestEnvelope, locationAttemptEnvelope,
    note: "Worst-case ceilings, not measured usage or verified provider-side weighted equivalents; no five-day publication prefetch." }));
  // Provider equivalence and competing traffic still need verification before enabling.
  if (mode === "public-noncommercial" && locationAttemptEnvelope > 9000) throw new Error("Daily public endpoint envelope exceeds 9,000 location attempts; refuse provider work");
}
