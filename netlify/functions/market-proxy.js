// netlify/functions/market-proxy.js
// Secure proxy for Polygon.io — API key stays server-side
// Called by: GitHub Pages frontend instead of hitting Polygon directly

export const handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return corsResponse(200, {});
  }

  const POLYGON_KEY = process.env.POLYGON_API_KEY;
  if (!POLYGON_KEY) {
    return corsResponse(500, { error: "Polygon API key not configured" });
  }

  const { path, params } = event.queryStringParameters || {};

  if (!path) {
    return corsResponse(400, { error: "Missing 'path' query parameter" });
  }

  // Whitelist allowed Polygon endpoints
  const allowedPaths = [
    "/v2/aggs/ticker/",
    "/v2/last/trade/",
    "/v1/open-close/",
    "/v2/snapshot/locale/us/markets/stocks/tickers",
    "/v2/snapshot/locale/us/markets/stocks/tickers/",
    "/v3/trades/",
    "/v2/aggs/grouped/locale/us/market/stocks/",
    "/vX/reference/tickers",
  ];

  const isAllowed = allowedPaths.some((allowed) => path.startsWith(allowed));
  if (!isAllowed) {
    return corsResponse(403, { error: "Endpoint not permitted" });
  }

  const queryString = params ? `&${params}` : "";
  const url = `https://api.polygon.io${path}?apiKey=${POLYGON_KEY}${queryString}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    return corsResponse(response.status, data);
  } catch (err) {
    return corsResponse(502, { error: "Polygon.io request failed", detail: err.message });
  }
};

function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "https://glosamabinladen.github.io",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}
