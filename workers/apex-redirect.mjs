const APEX_HOST = "wetbulb35.com";
const CANONICAL_HOST = "www.wetbulb35.com";
const HSTS = "max-age=63072000";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname !== APEX_HOST) {
      return new Response("Not Found", {
        status: 404,
        headers: { "strict-transport-security": HSTS },
      });
    }

    url.protocol = "https:";
    url.hostname = CANONICAL_HOST;
    url.port = "";

    return new Response(null, {
      status: 308,
      headers: {
        location: url.toString(),
        "cache-control": "public, max-age=14400, must-revalidate",
        "strict-transport-security": HSTS,
      },
    });
  },
};
