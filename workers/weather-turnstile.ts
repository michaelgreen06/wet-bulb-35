// Shared provider-refresh verification for current conditions and city forecasts.
export const TURNSTILE_TOKEN_HEADER = "x-weather-turnstile";
const ACTION = "weather_refresh";
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const PASS_COOKIE = "wb35_weather_pass";
const PASS_SECONDS = 86_400;

export interface TurnstileEnvironment {
  WEATHER_TURNSTILE_MODE?: string;
  WEATHER_TURNSTILE_SITE_KEY?: string;
  WEATHER_TURNSTILE_SECRET_KEY?: string;
  WEATHER_TURNSTILE_HOSTNAME?: string;
}

export function turnstileMode(env: TurnstileEnvironment): "off" | "enforce" | "misconfigured" {
  if (env.WEATHER_TURNSTILE_MODE === undefined || env.WEATHER_TURNSTILE_MODE === "off") return "off";
  return env.WEATHER_TURNSTILE_MODE === "enforce" ? "enforce" : "misconfigured";
}

export function turnstileReady(env: TurnstileEnvironment): boolean {
  return typeof env.WEATHER_TURNSTILE_SITE_KEY === "string" && env.WEATHER_TURNSTILE_SITE_KEY.trim() !== ""
    && typeof env.WEATHER_TURNSTILE_SECRET_KEY === "string" && env.WEATHER_TURNSTILE_SECRET_KEY.trim() !== ""
    && typeof env.WEATHER_TURNSTILE_HOSTNAME === "string" && /^[a-z0-9.-]+$/.test(env.WEATHER_TURNSTILE_HOSTNAME);
}

export async function verifyWeatherToken(token: string | null, env: TurnstileEnvironment): Promise<boolean> {
  if (!turnstileReady(env) || typeof token !== "string" || token.length < 1 || token.length > 2048) return false;
  try {
    const response = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: env.WEATHER_TURNSTILE_SECRET_KEY, response: token }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return false;
    const result = await response.json() as { success?: boolean; hostname?: string; action?: string };
    return result?.success === true && result.hostname === env.WEATHER_TURNSTILE_HOSTNAME && result.action === ACTION;
  } catch { return false; }
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A verified browser gets one signed 24-hour pass for both /api/weather and /api/forecast. */
export async function issuePass(env: TurnstileEnvironment): Promise<string> {
  if (!turnstileReady(env)) throw new Error("Weather verification is unavailable.");
  const expires = Math.floor(Date.now() / 1_000) + PASS_SECONDS;
  const signature = await hmacHex(env.WEATHER_TURNSTILE_SECRET_KEY!, String(expires));
  return `${PASS_COOKIE}=${expires}.${signature}; Max-Age=${PASS_SECONDS}; Path=/api; Secure; HttpOnly; SameSite=Lax`;
}

export async function hasPass(request: Request, env: TurnstileEnvironment): Promise<boolean> {
  if (!turnstileReady(env)) return false;
  // Migration from Path=/api/weather can send two cookies with the same name.
  const matches = request.headers.get("cookie")?.matchAll(new RegExp(`(?:^|;\\s*)${PASS_COOKIE}=(\\d{1,12})\\.([a-f0-9]{64})(?=;|$)`, "g"));
  if (!matches) return false;
  for (const match of matches) {
    if (Number(match[1]) * 1_000 < Date.now()) continue;
    try { if (await hmacHex(env.WEATHER_TURNSTILE_SECRET_KEY!, match[1]) === match[2]) return true; } catch { /* fail closed */ }
  }
  return false;
}
