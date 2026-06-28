import { calculateWetBulb, kelvinToCelsius } from './wetbulb';
import { z } from 'zod';

export const WeatherDataSchema = z.object({
  location: z.object({
    name: z.string(),
    lat: z.number(),
    lng: z.number(),
  }),
  weather: z.object({
    wetBulb: z.number(),
    temperature: z.number(),
    humidity: z.number(),
    timestamp: z.number(),
  }),
});

const OpenWeatherDataSchema = z.object({
  name: z.string(),
  coord: z.object({
    lat: z.number(),
    lon: z.number(),
  }),
  main: z.object({
    temp: z.number(),
    humidity: z.number(),
  }),
  dt: z.number(),
});

export const WeatherErrorSchema = z.object({
  error: z.string(),
});

export type WeatherData = z.infer<typeof WeatherDataSchema>;

export async function fetchWeatherData(lat: number, lon: number): Promise<WeatherData> {
  const apiKey =
    process.env.OPENWEATHER_API_KEY || process.env.NEXT_PUBLIC_OPENWEATHER_API_KEY;
  if (!apiKey) {
    throw new Error('OpenWeather API key is not configured. Please check your environment variables.');
  }

  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const statusText = response.statusText || '';
      if (response.status === 401) {
        throw new Error('Invalid API key. Please check your OpenWeather API key configuration.');
      } else if (response.status === 404) {
        throw new Error('Weather data not found for this location. Please try a different location.');
      } else if (response.status === 429) {
        throw new Error('Too many requests to weather service. Please try again later.');
      } else {
        throw new Error(`Weather service error (${response.status}${statusText ? ': ' + statusText : ''}). Please try again later.`);
      }
    }

    const data = OpenWeatherDataSchema.parse(await response.json());
    
    return {
      location: {
        name: data.name,
        lat: data.coord.lat,
        lng: data.coord.lon,
      },
      weather: {
        temperature: kelvinToCelsius(data.main.temp),
        humidity: data.main.humidity,
        wetBulb: calculateWetBulb(
          kelvinToCelsius(data.main.temp),
          data.main.humidity,
        ),
        timestamp: data.dt * 1000, // Convert to milliseconds
      },
    };
  } catch (error) {
    if (error instanceof Error) {
      // If we already created a specific error message, pass it through
      throw error;
    } else {
      // For unexpected errors
      throw new Error('Failed to fetch weather data. Please check your internet connection and try again.');
    }
  }
}

export function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not supported by your browser'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      resolve, 
      (error) => {
        // Provide more detailed error messages based on the error code
        switch(error.code) {
          case error.PERMISSION_DENIED:
            reject(new Error('Location access denied. To enable: click the lock/location icon in your browser\'s address bar, select "Allow", and refresh the page.'));
            break;
          case error.POSITION_UNAVAILABLE:
            reject(new Error('Location information is unavailable. Please try again later.'));
            break;
          case error.TIMEOUT:
            reject(new Error('Location request timed out. Please check your connection and try again.'));
            break;
          default:
            reject(new Error(`Geolocation error: ${error.message}`));
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 0
      }
    );
  });
}
