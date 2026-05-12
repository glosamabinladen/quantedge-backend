// netlify/functions/get-trades.js
// Returns trade journal from Netlify Blobs
// GET ?limit=50  → last N trades
// Handles empty/missing store gracefully

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);

    const store = getStore("trades");

    let trades = [];
    try {
      const raw = await store.get("trade-journal");
      trades = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(trades)) trades = [];
    } catch (_) {
      trades = []; // store not initialized yet — return empty, not 500
    }

    // Sort newest first, apply limit
    trades.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const sliced = trades.slice(0, limit);

    // Compute quick stats
    const closed = trades.filter(t => t.realizedPnl != null);
    const wins = closed.filter(t => t.realizedPnl > 0);
    const totalPnl = closed.reduce((s, t) => s + (t.realizedPnl || 0), 0);

    return new Response(
      JSON.stringify({
        trades: sliced,
        total: trades.length,
        stats: {
          totalTrades: trades.length,
          closedTrades: closed.length,
          winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
          totalPnl: parseFloat(totalPnl.toFixed(2)),
          autoTrades: trades.filter(t => t.source === 'auto' || t.automated).length,
        },
        fetchedAt: new Date().toISOString(),
      }),
      { status: 200, headers: CORS }
    );
  } catch (err) {
    console.error("get-trades error:", err);
    return new Response(
      JSON.stringify({ trades: [], total: 0, error: err.message }),
      { status: 200, headers: CORS } // 200 with empty so frontend doesn't crash
    );
  }
};

export const config = { path: "/get-trades" };
