export type ForecastCoord = {
  lat: number;
  lon: number;
};

export type ForecastPoint = {
  latitude: number;
  longitude: number;
  hourly: {
    time: string[];
    temperature_2m: number[];
    relative_humidity_2m: number[];
  };
};

type FetchOpenMeteoBatchArgs = {
  coords: ForecastCoord[];
  forecastHours: number;
  landFocused?: boolean;
};

const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const OPEN_METEO_RATE_LIMIT_RETRY_MS = 90_000;

export class OpenMeteoRateLimitError extends Error {
  limitKind: 'hourly' | 'minutely' | 'unknown';
  retryAfterMs: number;
  responseBody: string;
  retryAfterHeader: string | null;
  status: number;
  statusText: string;

  constructor(args: {
    message: string;
    responseBody: string;
    retryAfterHeader: string | null;
    retryAfterMs?: number;
    status: number;
    statusText: string;
    limitKind?: 'hourly' | 'minutely' | 'unknown';
  }) {
    const {
      limitKind = 'unknown',
      message,
      responseBody,
      retryAfterHeader,
      retryAfterMs = OPEN_METEO_RATE_LIMIT_RETRY_MS,
      status,
      statusText,
    } = args;

    super(message);
    this.name = 'OpenMeteoRateLimitError';
    this.limitKind = limitKind;
    this.retryAfterMs = retryAfterMs;
    this.responseBody = responseBody;
    this.retryAfterHeader = retryAfterHeader;
    this.status = status;
    this.statusText = statusText;
  }
}

export function buildOpenMeteoForecastUrl({
  coords,
  forecastHours,
  landFocused = false,
}: FetchOpenMeteoBatchArgs): string {
  const url = new URL(OPEN_METEO_FORECAST_URL);
  url.searchParams.set('latitude', coords.map((coord) => coord.lat).join(','));
  url.searchParams.set('longitude', coords.map((coord) => coord.lon).join(','));
  url.searchParams.set('hourly', 'temperature_2m,relative_humidity_2m');
  url.searchParams.set('timezone', 'GMT');
  url.searchParams.set('forecast_hours', String(forecastHours));

  if (landFocused) {
    url.searchParams.set('cell_selection', 'land');
  }

  return url.toString();
}

function normalizeForecastPayload(payload: unknown): ForecastPoint[] {
  const points = Array.isArray(payload) ? payload : [payload];

  return points.map((point) => {
    const candidate = point as ForecastPoint;

    if (
      typeof candidate.latitude !== 'number' ||
      typeof candidate.longitude !== 'number' ||
      !candidate.hourly ||
      !Array.isArray(candidate.hourly.time) ||
      !Array.isArray(candidate.hourly.temperature_2m) ||
      !Array.isArray(candidate.hourly.relative_humidity_2m)
    ) {
      throw new Error('Open-Meteo response did not include expected hourly forecast arrays.');
    }

    return candidate;
  });
}

export async function fetchOpenMeteoBatch(
  args: FetchOpenMeteoBatchArgs,
): Promise<ForecastPoint[]> {
  if (args.coords.length === 0) {
    return [];
  }

  const url = buildOpenMeteoForecastUrl(args);

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (response.ok) {
    return normalizeForecastPayload(await response.json());
  }

  const body = await response.text().catch(() => '');

  if (response.status === 429) {
    const lowerBody = body.toLowerCase();
    const limitKind = lowerBody.includes('hourly')
      ? 'hourly'
      : lowerBody.includes('minutely')
        ? 'minutely'
        : 'unknown';
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSeconds = Number(retryAfterHeader);
    const retryAfterMs = Number.isFinite(retryAfterSeconds)
      ? Math.max(OPEN_METEO_RATE_LIMIT_RETRY_MS, retryAfterSeconds * 1000)
      : OPEN_METEO_RATE_LIMIT_RETRY_MS;

    throw new OpenMeteoRateLimitError({
      message: `Open-Meteo forecast request failed (${response.status} ${response.statusText})${body ? `: ${body}` : ''}`,
      responseBody: body,
      retryAfterHeader,
      retryAfterMs,
      status: response.status,
      statusText: response.statusText,
      limitKind,
    });
  }

  throw new Error(
    `Open-Meteo forecast request failed (${response.status} ${response.statusText})${body ? `: ${body}` : ''}`,
  );
}
