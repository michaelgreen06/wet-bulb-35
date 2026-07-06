/**
 * @vitest-environment jsdom
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchBox from '../../components/SearchBox';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const googleMapsMock = vi.hoisted(() => {
  const autocompleteInstance = {
    getPlace: vi.fn(() => ({
      geometry: {
        location: {
          lat: () => 12.34,
          lng: () => 56.78,
        },
      },
    })),
  };

  return {
    autocompleteInstance,
    Autocomplete: vi.fn(),
    LoadScript: vi.fn(),
  };
});

vi.mock('@react-google-maps/api', async () => {
  const React = await import('react');

  googleMapsMock.LoadScript.mockImplementation(({ children }) =>
    React.createElement('div', { 'data-testid': 'load-script' }, children),
  );

  googleMapsMock.Autocomplete.mockImplementation(
    ({ children, onLoad, onPlaceChanged }) => {
      React.useEffect(() => {
        onLoad?.(googleMapsMock.autocompleteInstance);
      }, [onLoad]);

      return React.createElement(
        'div',
        {
          'data-testid': 'autocomplete',
          onBlur: onPlaceChanged,
        },
        children,
      );
    },
  );

  return {
    Autocomplete: googleMapsMock.Autocomplete,
    LoadScript: googleMapsMock.LoadScript,
  };
});

async function waitFor(assertion: () => void) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  throw lastError;
}

describe('SearchBox', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY = 'test-key';
    googleMapsMock.LoadScript.mockReset();
    googleMapsMock.LoadScript.mockImplementation(({ children }) => (
      <div data-testid="load-script">{children}</div>
    ));

    googleMapsMock.Autocomplete.mockReset();
    googleMapsMock.Autocomplete.mockImplementation(
      ({ children, onLoad, onPlaceChanged }) => {
        React.useEffect(() => {
          onLoad?.(googleMapsMock.autocompleteInstance);
        }, [onLoad]);

        return (
          <div data-testid="autocomplete" onBlur={onPlaceChanged}>
            {children}
          </div>
        );
      },
    );

    googleMapsMock.autocompleteInstance.getPlace.mockClear();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY;
  });

  it('does not load Google Places on initial render', async () => {
    await act(async () => {
      root.render(<SearchBox onLocationSelect={vi.fn()} />);
    });

    expect(container.textContent).toContain('Search for a location');
    expect(container.querySelector('input')).toBeNull();
    expect(googleMapsMock.LoadScript).not.toHaveBeenCalled();
  });

  it('loads the Places input after explicit search intent', async () => {
    await act(async () => {
      root.render(<SearchBox onLocationSelect={vi.fn()} />);
    });

    await act(async () => {
      container
        .querySelector('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitFor(() => {
      expect(container.querySelector('input')).not.toBeNull();
    });

    expect(googleMapsMock.LoadScript).toHaveBeenCalledWith(
      expect.objectContaining({
        googleMapsApiKey: 'test-key',
        libraries: ['places'],
      }),
      undefined,
    );
  });

  it('limits autocomplete requests to city geometry', async () => {
    await act(async () => {
      root.render(<SearchBox onLocationSelect={vi.fn()} />);
    });

    await act(async () => {
      container
        .querySelector('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitFor(() => {
      expect(googleMapsMock.Autocomplete).toHaveBeenCalled();
    });

    expect(googleMapsMock.Autocomplete).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: {
          fields: ['geometry'],
          types: ['(cities)'],
        },
      }),
      undefined,
    );
  });

  it('does not require a Places API key for the initial render', async () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY;

    await act(async () => {
      root.render(<SearchBox onLocationSelect={vi.fn()} />);
    });

    expect(container.textContent).toContain('Search for a location');
    expect(googleMapsMock.LoadScript).not.toHaveBeenCalled();
  });

  it('shows an inline unavailable state after opening search without a key', async () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY;

    await act(async () => {
      root.render(<SearchBox onLocationSelect={vi.fn()} />);
    });

    await act(async () => {
      container
        .querySelector('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Location search is unavailable.');
    });

    expect(googleMapsMock.LoadScript).not.toHaveBeenCalled();
  });
});
