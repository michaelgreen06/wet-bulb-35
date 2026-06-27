'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
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
      <Link
        href="/hotspots"
        className="mx-auto block max-w-2xl rounded-2xl border border-orange-200 bg-orange-50 p-4 text-center font-semibold text-orange-900 shadow-sm transition hover:-translate-y-0.5 hover:bg-orange-100"
      >
        View global forecast hotspots
      </Link>

      <SearchBox onLocationSelect={handleLocationSelect} />
      
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
