import { fetchWeatherData } from "../lib/utils/weather";
import { createWeatherHandler } from "../lib/server/weather-api.js";

export default createWeatherHandler({ fetchWeatherData });
