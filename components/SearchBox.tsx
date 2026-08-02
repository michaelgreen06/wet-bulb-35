'use client';

import React, { lazy, Suspense, useState } from 'react';

interface SearchBoxProps {
  onLocationSelect: (lat: number, lng: number) => void;
}

const PlacesSearchInput = lazy(() => import('./PlacesSearchInput'));

export default function SearchBox({ onLocationSelect }: SearchBoxProps) {
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  if (!isSearchOpen) {
    return (
      <div className="w-full max-w-md mx-auto">
        <button
          type="button"
          onClick={() => setIsSearchOpen(true)}
          className="w-full px-4 py-2 border border-gray-300 rounded-lg text-left text-gray-500 bg-white transition hover:border-blue-400 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        >
          Search for a location...
        </button>
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="w-full max-w-md mx-auto">
          <div className="w-full px-4 py-2 border border-gray-300 rounded-lg text-gray-500 bg-white">
            Loading location search...
          </div>
        </div>
      }
    >
      <PlacesSearchInput onLocationSelect={onLocationSelect} />
    </Suspense>
  );
}
