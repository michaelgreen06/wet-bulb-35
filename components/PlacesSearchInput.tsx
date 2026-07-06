'use client';

import React, { useMemo, useState } from 'react';
import {
  Autocomplete,
  LoadScript,
  type Libraries,
} from '@react-google-maps/api';

interface PlacesSearchInputProps {
  onLocationSelect: (lat: number, lng: number) => void;
}

const libraries: Libraries = ['places'];

export default function PlacesSearchInput({
  onLocationSelect,
}: PlacesSearchInputProps) {
  const [autocomplete, setAutocomplete] =
    useState<google.maps.places.Autocomplete | null>(null);
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY;
  const memoizedLibraries = useMemo(() => libraries, []);

  if (!apiKey) {
    return (
      <div className="w-full max-w-md mx-auto">
        <p className="w-full px-4 py-2 border border-amber-300 rounded-lg text-sm text-amber-900 bg-amber-50">
          Location search is unavailable.
        </p>
      </div>
    );
  }

  const onPlaceChanged = () => {
    if (!autocomplete) {
      return;
    }

    const place = autocomplete.getPlace();
    if (place.geometry?.location) {
      onLocationSelect(
        place.geometry.location.lat(),
        place.geometry.location.lng(),
      );
    }
  };

  return (
    <LoadScript googleMapsApiKey={apiKey} libraries={memoizedLibraries}>
      <div className="w-full max-w-md mx-auto">
        <Autocomplete
          onLoad={setAutocomplete}
          onPlaceChanged={onPlaceChanged}
          options={{
            fields: ['geometry'],
            types: ['(cities)'],
          }}
        >
          <input
            type="text"
            placeholder="Search for a location..."
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </Autocomplete>
      </div>
    </LoadScript>
  );
}
