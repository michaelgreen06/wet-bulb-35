// Fixed, low-cardinality source categories for weather-budget attribution.
// Never forward a raw user agent, IP, URL, referrer, city label or CF object.
export type WeatherSourceContext = {
  asn: number | null;
  country: string | null;
  ua_family: "chrome" | "edge" | "firefox" | "safari" | "script" | "other";
  ua_major: number | null;
  referrer_class: "city_page" | "site_other" | "external" | "none" | "invalid";
  verified_bot: boolean | null;
};

const families = new Set<WeatherSourceContext["ua_family"]>(["chrome", "edge", "firefox", "safari", "script", "other"]);
const referrers = new Set<WeatherSourceContext["referrer_class"]>(["city_page", "site_other", "external", "none", "invalid"]);
const browsers = new Set<WeatherSourceContext["ua_family"]>(["chrome", "edge", "firefox", "safari"]);
const fallback: WeatherSourceContext = { asn: null, country: null, ua_family: "other", ua_major: null, referrer_class: "invalid", verified_bot: null };

export function sanitizeWeatherSource(value: unknown): WeatherSourceContext {
  try {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const ua_family = families.has(source.ua_family as WeatherSourceContext["ua_family"])
      ? source.ua_family as WeatherSourceContext["ua_family"] : "other";
    return {
      asn: Number.isSafeInteger(source.asn) && (source.asn as number) > 0 && (source.asn as number) <= 4_294_967_295 ? source.asn as number : null,
      country: typeof source.country === "string" && /^[A-Z0-9]{2}$/.test(source.country) ? source.country : null,
      ua_family,
      ua_major: browsers.has(ua_family) && Number.isSafeInteger(source.ua_major) && (source.ua_major as number) >= 1 && (source.ua_major as number) <= 400 ? source.ua_major as number : null,
      referrer_class: referrers.has(source.referrer_class as WeatherSourceContext["referrer_class"])
        ? source.referrer_class as WeatherSourceContext["referrer_class"] : "invalid",
      verified_bot: typeof source.verified_bot === "boolean" ? source.verified_bot : null,
    };
  } catch { return { ...fallback }; }
}

function agentFamily(userAgent: string): { ua_family: WeatherSourceContext["ua_family"]; ua_major: number | null } {
  const ua = userAgent.slice(0, 512);
  let ua_family: WeatherSourceContext["ua_family"] = "other";
  let major: string | undefined;
  if (/curl\/|python-requests|httpx\/|wget\/|go-http-client|node-fetch|postman/i.test(ua)) ua_family = "script";
  else if (/Edg\//i.test(ua)) { ua_family = "edge"; major = /Edg\/(\d+)/i.exec(ua)?.[1]; }
  else if (/Chrome\/|CriOS\//i.test(ua)) { ua_family = "chrome"; major = /(?:Chrome|CriOS)\/(\d+)/i.exec(ua)?.[1]; }
  else if (/Firefox\/|FxiOS\//i.test(ua)) { ua_family = "firefox"; major = /(?:Firefox|FxiOS)\/(\d+)/i.exec(ua)?.[1]; }
  else if (/Safari\//i.test(ua)) { ua_family = "safari"; major = /Version\/(\d+)/i.exec(ua)?.[1]; }
  const number = major ? Number(major) : null;
  return { ua_family, ua_major: number && Number.isSafeInteger(number) && number <= 400 ? number : null };
}

function referrerClass(referrer: string | null): WeatherSourceContext["referrer_class"] {
  if (!referrer) return "none";
  try {
    const url = new URL(referrer);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "invalid";
    if (url.protocol !== "https:" || !["www.wetbulb35.com", "wetbulb35.com"].includes(url.hostname)) return "external";
    return url.pathname.startsWith("/wetbulb-temperature/") ? "city_page" : "site_other";
  } catch { return "invalid"; }
}

export function sourceFromRequest(request: Request): WeatherSourceContext {
  try {
    const cf = (request as Request & { cf?: { asn?: unknown; country?: unknown; botManagement?: { verifiedBot?: unknown } } }).cf;
    const family = agentFamily(request.headers.get("user-agent") || "");
    return sanitizeWeatherSource({
      asn: cf?.asn,
      country: cf?.country,
      ...family,
      referrer_class: referrerClass(request.headers.get("referer")),
      verified_bot: cf?.botManagement?.verifiedBot,
    });
  } catch { return { ...fallback }; }
}
