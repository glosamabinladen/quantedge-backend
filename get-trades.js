// netlify/functions/get-trades.js
const { getStore } = require("@netlify/blobs");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async function (event, context) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "ok" };
  }

  try {
    const limit = parseInt(
      (event.queryStringParameters && event.queryStringParameters.limit) || "50",
      10
    );

    const siteID = context.site && context.site.id
      ? context.site.id
      : process.env.NETLIFY_SITE_ID || "extraordinary-mandazi-a05e7e";

    const store = getStore({ name: "trades", siteID, token: process.env.NETLIFY_TOKEN });

    let trades = [];
    try {
      const raw = await store.get("trade-journal");
      if (raw) {
        const parsed = JSON.parse(raw);
        trades = Array.isArray(parsed) ? parsed : [];
      }
    } catch (e) {
      console.log("Trade journal empty:", e.message);
      trades = [];
    }

    trades.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const sliced = trades.slice(0, limit);

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
    console.error("get-trades fatal:", err.message);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ trades: [], total: 0, error: err.message }),
    };
  }
};
