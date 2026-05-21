import type { NextApiRequest, NextApiResponse } from "next";
import { fetchWeatherData } from "../../lib/utils/weather";

const KNOWN_BOT_PATTERN =
  /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|applebot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|bytespider|crawler|spider|bot)/i;

function isBlockedBot(userAgent: string | undefined): boolean {
  if (!userAgent) {
    return false;
  }

  return KNOWN_BOT_PATTERN.test(userAgent);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (isBlockedBot(req.headers["user-agent"])) {
    return res.status(204).end();
  }

  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "Valid lat and lon are required." });
  }

  try {
    const weatherData = await fetchWeatherData(lat, lon);

    res.setHeader(
      "Cache-Control",
      "private, no-store, no-cache, max-age=0, must-revalidate",
    );

    return res.status(200).json(weatherData);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to refresh weather data.";

    return res.status(500).json({ error: message });
  }
}
