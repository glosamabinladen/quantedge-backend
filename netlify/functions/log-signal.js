// netlify/functions/log-signal.js
import { getStore } from "@netlify/blobs";

const blob = (name) => getStore({
  name,
  siteID: process.env.NETLIFY_SITE_ID,
  token:  process.env.NETLIFY_AUTH_TOKEN,
});

function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":"GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":"Content-Type",
    },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return corsResponse(200, {});

  // POST — log a new signal
  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return corsResponse(400, { error: "Invalid JSON" });
    }

    const { ticker, action, confidence, price, stopLoss, target, rsi, setupType, reasoning, keyRisk, timeOfDay } = body;
    if (!ticker || !action) return corsResponse(400, { error: "Missing required fields: ticker, action" });

    const signal = {
      id:        `${Date.now()}-${ticker}`,
      ticker:    ticker.toUpperCase(),
      action:    action.toUpperCase(),
      confidence: confidence || 0,
      price:      price || 0,
      stopLoss:   stopLoss || null,
      target:     target || null,
      rsi:        rsi || null,
      setupType:  setupType || "Manual",
      reasoning:  reasoning || "",
      keyRisk:    keyRisk || "",
      timeOfDay:  timeOfDay || "Market Hours",
      timestamp:  new Date().toISOString(),
      source:     "terminal",
    };

    try {
      const store = blob("signal-log");
      await store.setJSON(signal.id, signal);
      return corsResponse(200, { success: true, signalId: signal.id, signal });
    } catch (err) {
      return corsResponse(500, { error: "Failed to log signal", detail: err.message });
    }
  }

  // GET — retrieve recent signals
  if (event.httpMethod === "GET") {
    const { limit } = event.queryStringParameters || {};
    try {
      const store = blob("signal-log");
      const { blobs } = await store.list();

      const recent = blobs
        .sort((a, b) => b.key.localeCompare(a.key))
        .slice(0, parseInt(limit) || 50);

      const signals = await Promise.all(
        recent.map(async ({ key }) => {
          try { return await store.getJSON(key); } catch { return null; }
        })
      );

      const filtered = signals.filter(Boolean).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      return corsResponse(200, { signals: filtered, count: filtered.length });
    } catch (err) {
      return corsResponse(500, { error: "Failed to retrieve signals", detail: err.message });
    }
  }

  return corsResponse(405, { error: "Method not allowed" });
};
