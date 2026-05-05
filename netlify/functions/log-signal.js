// netlify/functions/log-signal.js
// Auto-logs AI signals from the terminal into persistent storage
// Journal.html reads from this store to display signal history

import { getStore } from "@netlify/blobs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return corsResponse(200, {});
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return corsResponse(400, { error: "Invalid JSON" });
    }

    const { ticker, action, confidence, price, stopLoss, target, rsi, setupType, reasoning, keyRisk, timeOfDay } = body;

    if (!ticker || !action) {
      return corsResponse(400, { error: "Missing required fields: ticker, action" });
    }

    const signal = {
      id: `${Date.now()}-${ticker}`,
      ticker: ticker.toUpperCase(),
      action: action.toUpperCase(),
      confidence: confidence || 0,
      price: price || 0,
      stopLoss: stopLoss || null,
      target: target || null,
      rsi: rsi || null,
      setupType: setupType || "Manual Signal",
      reasoning: reasoning || "",
      keyRisk: keyRisk || "",
      timeOfDay: timeOfDay || "Market Hours",
      timestamp: new Date().toISOString(),
      date: new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }),
      source: "QuantEdge Terminal",
    };

    try {
      const store = getStore("signal-log");
      await store.setJSON(signal.id, signal);

      // Also update daily summary
      const dateKey = `daily-${signal.date.replace(/\//g, "-")}`;
      let daily;
      try {
        daily = await store.getJSON(dateKey) || { date: signal.date, signals: [], count: 0 };
      } catch {
        daily = { date: signal.date, signals: [], count: 0 };
      }
      daily.signals.push(signal.id);
      daily.count = daily.signals.length;
      daily.lastUpdated = new Date().toISOString();
      await store.setJSON(dateKey, daily);

      return corsResponse(200, { success: true, signalId: signal.id, signal });
    } catch (err) {
      return corsResponse(500, { error: "Failed to log signal", detail: err.message });
    }
  }

  if (event.httpMethod === "GET") {
    // Retrieve signals — supports ?date=MM-DD-YYYY or ?limit=N or ?all=true
    const { date, limit, all } = event.queryStringParameters || {};

    try {
      const store = getStore("signal-log");

      if (date) {
        // Get signals for a specific date
        const dateKey = `daily-${date}`;
        let daily;
        try {
          daily = await store.getJSON(dateKey);
        } catch {
          return corsResponse(200, { signals: [], date, count: 0 });
        }
        if (!daily) return corsResponse(200, { signals: [], date, count: 0 });

        const signals = await Promise.all(
          (daily.signals || []).map(async (id) => {
            try { return await store.getJSON(id); } catch { return null; }
          })
        );
        return corsResponse(200, { 
          signals: signals.filter(Boolean).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)), 
          date, 
          count: signals.filter(Boolean).length 
        });
      }

      // Get recent signals
      const { blobs } = await store.list();
      const signalBlobs = blobs.filter(b => !b.key.startsWith("daily-"));
      const recent = signalBlobs
        .sort((a, b) => b.key.localeCompare(a.key))
        .slice(0, parseInt(limit) || 50);

      const signals = await Promise.all(
        recent.map(async ({ key }) => {
          try { return await store.getJSON(key); } catch { return null; }
        })
      );

      return corsResponse(200, { 
        signals: signals.filter(Boolean).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
        count: signals.filter(Boolean).length
      });
    } catch (err) {
      return corsResponse(500, { error: "Failed to retrieve signals", detail: err.message });
    }
  }

  return corsResponse(405, { error: "Method not allowed" });
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
