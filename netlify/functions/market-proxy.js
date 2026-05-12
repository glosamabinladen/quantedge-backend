// netlify/functions/market-proxy.js
// Secure proxy for Polygon.io — API key stays server-side
export const handler = async (event) => {
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

  // Strip any query string from path before whitelist check
  const cleanPath = path.split("?")[0];

  const allowedPaths = [
    "/v2/aggs/ticker/",
    "/v2/last/trade/",
    "/v1/open-close/",
    "/v2/snapshot/locale/us/markets/stocks",
    "/v3/trades/",
    "/v2/aggs/grouped/locale/us/market/stocks/",
    "/vX/reference/tickers",
  ];
  const isAllowed = allowedPaths.some((allowed) => cleanPath.startsWith(allowed));
  if (!isAllowed) {
    return corsResponse(403, { error: "Endpoint not permitted", path: cleanPath });
  }

  // Build query string — merge params from path and params parameter
  const pathParts = path.split("?");
  const pathQueryString = pathParts[1] || "";
  const extraParams = params || "";
  const allParams = [pathQueryString, extraParams].filter(Boolean).join("&");
  const url = `https://api.polygon.io${cleanPath}?apiKey=${POLYGON_KEY}${allParams ? "&" + allParams : ""}`;

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
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}
