// netlify/functions/log-signal.js
// CommonJS — matches Netlify default Node runtime
// GET  → returns signal history (last 100)
// POST → appends a new Claude signal to the log

const { getStore } = require("@netlify/blobs");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "ok" };
  }

  const store = getStore("signals");

  // ── GET: return signal history ──────────────────────────
  if (event.httpMethod === "GET") {
    try {
      let signals = [];
      try {
        const raw = await store.get("signal-log");
        if (raw) {
          const parsed = JSON.parse(raw);
          signals = Array.isArray(parsed) ? parsed : [];
        }
      } catch (e) {
        console.log("Signal log empty or missing:", e.message);
        signals = [];
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ signals, count: signals.length }),
      };
    } catch (err) {
      console.error("log-signal GET error:", err);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ signals: [], count: 0, error: err.message }),
      };
    }
  }

  // ── POST: append a new signal ───────────────────────────
  if (event.httpMethod === "POST") {
    try {
      let body = {};
      try {
        body = JSON.parse(event.body || "{}");
      } catch (_) {
        body = {};
      }

      if (!body.symbol) {
        return {
          statusCode: 400,
          headers: CORS,
          body: JSON.stringify({ error: "Missing required field: symbol" }),
        };
      }

      // Read existing log
      let signals = [];
      try {
        const raw = await store.get("signal-log");
        if (raw) {
          const parsed = JSON.parse(raw);
          signals = Array.isArray(parsed) ? parsed : [];
        }
      } catch (_) {
        signals = [];
      }

      // Build new signal entry
      const newSignal = {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        symbol: body.symbol,
        action: body.action || "HOLD",
        confidence: body.confidence != null ? body.confidence : null,
        setupType: body.setupType || null,
        reasoning: body.reasoning || null,
        keyRisk: body.keyRisk || null,
        stopLoss: body.stopLoss || null,
        target: body.target || null,
        price: body.price || null,
        rsi: body.rsi || null,
        executed: body.executed || false,
        orderId: body.orderId || null,
      };

      signals.unshift(newSignal);
      if (signals.length > 200) signals = signals.slice(0, 200);

      await store.set("signal-log", JSON.stringify(signals));

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, signal: newSignal }),
      };

    } catch (err) {
      console.error("log-signal POST error:", err);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: err.message }),
      };
    }
  }

  return {
    statusCode: 405,
    headers: CORS,
    body: JSON.stringify({ error: "Method not allowed" }),
  };
};
