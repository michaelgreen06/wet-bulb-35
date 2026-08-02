'use client';

import { useEffect, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import SearchBox from '../components/SearchBox';
import WeatherDisplay from '../components/WeatherDisplay';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorDisplay from '../components/ErrorDisplay';
import Header from '../components/Header';
import CurrentLocationButton from '../components/CurrentLocationButton';
import Disclaimer from '../components/Disclaimer';
import type { WeatherLocation } from '../lib/types/weather';
import { getCurrentPosition } from '../lib/utils/weather';

// Create a client component that uses useSearchParams
function HomeContent() {
  const [weatherLocation, setWeatherLocation] = useState<WeatherLocation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchParams = useSearchParams();

  const handleLocationSelect = (lat: number, lng: number) => {
    setError(null);
    setWeatherLocation({
      locationName: 'Selected Location',
      lat,
      lng,
    });
  };

  const getCurrentLocationWeather = async () => {
    setLoading(true);
    setError(null);
    try {
      const position = await getCurrentPosition();
      setWeatherLocation({
        locationName: 'Current Location',
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      });
    } catch (err) {
      console.error('Geolocation error:', err);
      setError(err instanceof Error ? err.message : 'Failed to get current location');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Check if lat and lng are provided in URL
    if (searchParams) {
      const lat = searchParams.get('lat');
      const lng = searchParams.get('lng');
      
      if (lat && lng) {
        handleLocationSelect(parseFloat(lat), parseFloat(lng));
      } else {
        getCurrentLocationWeather();
      }
    } else {
      getCurrentLocationWeather();
    }
  }, [searchParams]);

  return (
    <div className="space-y-6">
      <SearchBox onLocationSelect={handleLocationSelect} />

      <div className="text-center">
        <Link
          href="/inhabited-hotspots/"
          className="inline-block rounded-lg border border-blue-200 bg-white px-4 py-2 font-semibold text-blue-700 transition-colors hover:bg-blue-50"
        >
          Forecast inhabited hotspots
        </Link>
      </div>
      
      <CurrentLocationButton onClick={getCurrentLocationWeather} />

      {loading && <LoadingSpinner />}
      {error && <ErrorDisplay error={error} onRetry={getCurrentLocationWeather} />}
      {weatherLocation && <WeatherDisplay {...weatherLocation} />}

      <Disclaimer />
    </div>
  );
}

// Main page component with Suspense boundary
export default function Home() {
  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <Header />
      
      <Suspense fallback={<LoadingSpinner />}>
        <HomeContent />
      </Suspense>
    </div>
  );
}
