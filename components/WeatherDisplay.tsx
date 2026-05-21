'use client';

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { calculateWetBulb } from '../lib/utils/wetbulb';
import {
  parseWeatherData,
  readWeatherError,
  type WeatherData,
} from '../lib/utils/weather';

type WeatherDisplayProps =
  | {
      source: 'weather-data';
      data: WeatherData;
    }
  | {
      source: 'coordinates';
      locationName: string;
      lat: number;
      lng: number;
    };

export default function WeatherDisplay(props: WeatherDisplayProps) {
  const initialData = props.source === 'weather-data' ? props.data : null;

  const [data, setData] = useState<WeatherData | null>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(initialData == null);

  const locationName = props.source === 'weather-data'
    ? props.data.location.name
    : props.locationName;
  const lat = props.source === 'weather-data' ? props.data.location.lat : props.lat;
  const lng = props.source === 'weather-data' ? props.data.location.lng : props.lng;

  useEffect(() => {
    if (initialData != null) {
      setData(initialData);
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    async function loadWeather() {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`,
          {
            method: 'GET',
            headers: {
              Accept: 'application/json',
            },
          },
        );

        if (response.status === 204) {
          if (isMounted) {
            setData(null);
          }
          return;
        }

        const payload: unknown = await response.json();

        if (!response.ok) {
          throw new Error(
            readWeatherError(payload) || 'Failed to refresh weather data.',
          );
        }

        if (isMounted) {
          setData(parseWeatherData(payload));
        }
      } catch (err) {
        if (isMounted) {
          setError(
            err instanceof Error
              ? err.message
              : 'Failed to refresh weather data.',
          );
          setData(null);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadWeather();

    return () => {
      isMounted = false;
    };
  }, [initialData, lat, lng]);

  const wetBulb =
    data == null
      ? null
      : calculateWetBulb(data.weather.temperature, data.weather.humidity);

  return (
    <div className="bg-white p-6 rounded-lg shadow-lg max-w-2xl mx-auto">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800">{locationName}</h2>
        <p className="text-sm text-gray-600">
          {lat.toFixed(4)}°N, {lng.toFixed(4)}°E
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-blue-50 p-4 rounded-lg">
            <h3 className="text-lg font-semibold text-blue-800 mb-2">
              Wet Bulb Temperature
            </h3>
            <p className="text-3xl font-bold text-blue-600">
              {isLoading || wetBulb == null ? '--' : `${wetBulb.toFixed(2)}°C`}
            </p>
          </div>

          <div className="bg-gray-50 p-4 rounded-lg">
            <h3 className="text-lg font-semibold text-gray-800 mb-2">
              Air Temperature
            </h3>
            <p className="text-3xl font-bold text-gray-600">
              {isLoading || data == null
                ? '--'
                : `${data.weather.temperature.toFixed(2)}°C`}
            </p>
          </div>

          <div className="bg-gray-50 p-4 rounded-lg">
            <h3 className="text-lg font-semibold text-gray-800 mb-2">
              Relative Humidity
            </h3>
            <p className="text-3xl font-bold text-gray-600">
              {isLoading || data == null
                ? '--'
                : `${data.weather.humidity.toFixed(2)}%`}
            </p>
          </div>

          <div className="bg-gray-50 p-4 rounded-lg">
            <h3 className="text-lg font-semibold text-gray-800 mb-2">
              Last Updated
            </h3>
            <p className="text-lg text-gray-600">
              {isLoading || data == null
                ? 'Fetching latest weather...'
                : format(data.weather.timestamp, 'MMM d, yyyy HH:mm:ss')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
