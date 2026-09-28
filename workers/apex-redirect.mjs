const APEX_HOST = "wetbulb35.com";
const CANONICAL_ORIGIN = "https://www.wetbulb35.com";
const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
};

export function apexRedirect(request) {
  const url = new URL(request.url);
  if (url.hostname !== APEX_HOST) {
    return new Response("Misdirected request", {
      status: 421,
      headers: { ...SECURITY_HEADERS, "cache-control": "no-store" },
    });
  }
  return new Response(null, {
    status: 308,
    headers: {
      ...SECURITY_HEADERS,
      "cache-control": "public, max-age=3600, s-maxage=86400",
      location: `${CANONICAL_ORIGIN}${url.pathname}${url.search}`,
    },
  });
}

export default { fetch: apexRedirect };
