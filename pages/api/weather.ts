import type { NextApiRequest, NextApiResponse } from "next";
import { fetchWeatherData } from "../../lib/utils/weather";
import { createWeatherHandler } from "../../lib/server/weather-api.js";

const handler = createWeatherHandler({ fetchWeatherData });

export default async function nextWeatherHandler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  return handler(req, res);
}
