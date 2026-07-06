'use client';

import { useState, useMemo } from 'react';
import { LoadScript, Autocomplete } from '@react-google-maps/api';

interface SearchBoxProps {
  onLocationSelect: (lat: number, lng: number) => void;
}

const libraries: ["places"] = ["places"];

export default function SearchBox({ onLocationSelect }: SearchBoxProps) {
  const [autocomplete, setAutocomplete] = useState<google.maps.places.Autocomplete | null>(null);

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('Google Places API key is not configured');
  }

  // Memoize the libraries array to prevent unnecessary re-renders
  const memoizedLibraries = useMemo(() => libraries, []);

  const onLoad = (autocomplete: google.maps.places.Autocomplete) => {
    setAutocomplete(autocomplete);
  };

  const onPlaceChanged = () => {
    if (autocomplete) {
      const place = autocomplete.getPlace();
      if (place.geometry?.location) {
        onLocationSelect(
          place.geometry.location.lat(),
          place.geometry.location.lng()
        );
      }
    }
  };

  return (
    <LoadScript
      googleMapsApiKey={apiKey}
      libraries={memoizedLibraries}
    >
      <div className="w-full max-w-md mx-auto">
        <Autocomplete
          onLoad={onLoad}
          onPlaceChanged={onPlaceChanged}
          options={{
            types: ['(cities)']
          }}
        >
          <input
            type="text"
            placeholder="Search for a location..."
            data-search-input
            className="w-full px-4 py-2 border border-gray-300 rounded-lg bg-white text-black placeholder-gray-700 caret-black focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </Autocomplete>
      </div>
    </LoadScript>
  );
}
