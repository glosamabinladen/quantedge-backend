// netlify/functions/get-trades.js
// CommonJS — matches Netlify default Node runtime
// GET ?limit=50 → returns trade journal from Netlify Blobs

const { getStore } = require("@netlify/blobs");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "ok" };
  }

  try {
    const limit = parseInt(
      (event.queryStringParameters && event.queryStringParameters.limit) || "50",
      10
    );

    const store = getStore("trades");

    let trades = [];
    try {
      const raw = await store.get("trade-journal");
      if (raw) {
        const parsed = JSON.parse(raw);
        trades = Array.isArray(parsed) ? parsed : [];
      }
    } catch (e) {
      console.log("Trade journal empty or missing:", e.message);
      trades = [];
    }

    // Sort newest first
    trades.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const sliced = trades.slice(0, limit);

    // Quick stats
    const closed = trades.filter((t) => t.realizedPnl != null);
    const wins = closed.filter((t) => t.realizedPnl > 0);
    const totalPnl = closed.reduce((s, t) => s + (t.realizedPnl || 0), 0);
    const autoTrades = trades.filter((t) => t.source === "auto" || t.automated).length;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        trades: sliced,
        total: trades.length,
        stats: {
          totalTrades: trades.length,
          closedTrades: closed.length,
          winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
          totalPnl: parseFloat(totalPnl.toFixed(2)),
          autoTrades,
        },
        fetchedAt: new Date().toISOString(),
      }),
    };

  } catch (err) {
    console.error("get-trades fatal:", err);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ trades: [], total: 0, error: err.message }),
    };
  }
};
