// netlify/functions/log-signal.js
// GET  → returns logged signals (last 100)
// POST → logs a new signal from Claude
// Handles empty/missing Blobs gracefully

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const store = getStore("signals");

  // ── GET: return signal history ─────────────────────────
  if (req.method === "GET") {
    try {
      let signals = [];
      try {
        const raw = await store.get("signal-log");
        signals = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(signals)) signals = [];
      } catch (_) {
        signals = []; // store not initialized yet
      }
      return new Response(
        JSON.stringify({ signals, count: signals.length }),
        { status: 200, headers: CORS }
      );
    } catch (err) {
      console.error("log-signal GET error:", err);
      return new Response(
        JSON.stringify({ signals: [], error: err.message }),
        { status: 200, headers: CORS }
      );
    }
  }

  // ── POST: append a new signal ──────────────────────────
  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (!body || !body.symbol) {
        return new Response(
          JSON.stringify({ error: "Missing required field: symbol" }),
          { status: 400, headers: CORS }
        );
      }

      // Read existing log
      let signals = [];
      try {
        const raw = await store.get("signal-log");
        signals = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(signals)) signals = [];
      } catch (_) {
        signals = [];
      }

      // Append new signal
      const newSignal = {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        symbol: body.symbol,
        action: body.action || "HOLD",
        confidence: body.confidence || null,
        setupType: body.setupType || null,
        reasoning: body.reasoning || null,
        keyRisk: body.keyRisk || null,
        price: body.price || null,
        rsi: body.rsi || null,
        executed: body.executed || false,
        orderId: body.orderId || null,
      };

      signals.unshift(newSignal);
      if (signals.length > 200) signals = signals.slice(0, 200); // cap at 200

      await store.set("signal-log", JSON.stringify(signals));

      return new Response(
        JSON.stringify({ success: true, signal: newSignal }),
        { status: 200, headers: CORS }
      );
    } catch (err) {
      console.error("log-signal POST error:", err);
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: CORS }
      );
    }
  }

  return new Response(
    JSON.stringify({ error: "Method not allowed" }),
    { status: 405, headers: CORS }
  );
};

export const config = { path: "/log-signal" };
