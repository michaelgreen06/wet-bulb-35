export const KNOWN_BOT_PATTERN =
  /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|applebot|petalbot|semrushbot|ahrefsbot|mj12bot|dotbot|bytespider|crawler|spider|bot)/i;

export function isBlockedBot(userAgent) {
  if (!userAgent) {
    return false;
  }

  return KNOWN_BOT_PATTERN.test(userAgent);
}

export function parseCoordinates(source) {
  const lat = Number(source.lat);
  const lon = Number(source.lon);

  return { lat, lon };
}

function setJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function createWeatherHandler({ fetchWeatherData }) {
  return async function handleWeather(req, res) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      setJson(res, 405, { error: "Method not allowed." });
      return;
    }

    if (isBlockedBot(req.headers?.["user-agent"])) {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url || "http://localhost/api/weather", "http://localhost");
    const { lat, lon } = parseCoordinates({
      lat: req.query?.lat ?? url.searchParams.get("lat"),
      lon: req.query?.lon ?? url.searchParams.get("lon"),
    });

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setJson(res, 400, { error: "Valid lat and lon are required." });
      return;
    }

    try {
      const weatherData = await fetchWeatherData(lat, lon);
      res.setHeader(
        "Cache-Control",
        "private, no-store, no-cache, max-age=0, must-revalidate",
      );
      setJson(res, 200, weatherData);
    } catch (error) {
      setJson(res, 500, {
        error:
          error instanceof Error
            ? error.message
            : "Failed to refresh weather data.",
      });
    }
  };
}
