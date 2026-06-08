// netlify/functions/alpaca-proxy.js
// Secure proxy for Alpaca paper trading — keys stay server-side

const ALPACA_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SEC = process.env.ALPACA_API_SECRET;
const BASE_URL   = "https://paper-api.alpaca.markets";

const ALLOWED_ENDPOINTS = [
  "/v2/account",
  "/v2/positions",
  "/v2/orders",
  "/v2/portfolio/history",
  "/v2/assets",
  "/v2/clock",
  "/v2/calendar",
];

function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":"GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":"Content-Type",
    },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return corsResponse(200, {});

  if (!ALPACA_KEY || !ALPACA_SEC) return corsResponse(500, { error: "Alpaca keys not configured" });

  const { endpoint } = event.queryStringParameters || {};
  if (!endpoint) return corsResponse(400, { error: "Missing 'endpoint' query parameter" });

  const allowed = ALLOWED_ENDPOINTS.some(e => endpoint.startsWith(e));
  if (!allowed) return corsResponse(403, { error: "Endpoint not permitted" });

  const headers = {
    "APCA-API-KEY-ID":     ALPACA_KEY,
    "APCA-API-SECRET-KEY": ALPACA_SEC,
    "Content-Type":        "application/json",
  };

  try {
    const options = { method: event.httpMethod, headers };

    if ((event.httpMethod === "POST") && event.body) {
      const orderBody = JSON.parse(event.body);
      const allowed = ["symbol","qty","side","type","time_in_force","limit_price","stop_price","notional"];
      const sanitized = {};
      allowed.forEach(k => { if (orderBody[k] !== undefined) sanitized[k] = orderBody[k]; });
      options.body = JSON.stringify(sanitized);
    }

    const res  = await fetch(`${BASE_URL}${endpoint}`, options);
    const data = await res.json();
    return corsResponse(res.status, data);
  } catch (err) {
    return corsResponse(502, { error: "Alpaca request failed", detail: err.message });
  }
};
