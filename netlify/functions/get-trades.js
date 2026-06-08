// netlify/functions/get-trades.js
import { getStore } from "@netlify/blobs";

// Explicit config — don't rely on Netlify auto-injection
const blob = (name) => getStore({
  name,
  siteID: process.env.NETLIFY_SITE_ID,
  token:  process.env.NETLIFY_AUTH_TOKEN,
});

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Surrogate-Control": "no-store",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  try {
    const limit = parseInt(event.queryStringParameters?.limit || "100");
    const store = blob("trade-journal");

    let blobs = [];
    try {
      const result = await store.list();
      blobs = result.blobs || [];
    } catch (e) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ trades: [], total: 0, blobsError: e.message }) };
    }

    if (!blobs.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ trades: [], total: 0 }) };
    }

    const trades = [];
    await Promise.all(blobs.map(async ({ key }) => {
      try {
        const trade = await store.getJSON(key);
        if (trade) trades.push(trade);
      } catch {}
    }));

    trades.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const closed    = trades.filter(t => t.realizedPnl != null);
    const wins      = closed.filter(t => t.realizedPnl > 0);
    const totalPnl  = closed.reduce((s, t) => s + (t.realizedPnl || 0), 0);
    const autoTrades = trades.filter(t => t.source === "auto" || t.automated).length;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        trades: trades.slice(0, limit),
        total: trades.length,
        stats: { totalTrades: trades.length, closedTrades: closed.length, winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0, totalPnl: parseFloat(totalPnl.toFixed(2)), autoTrades },
        fetchedAt: new Date().toISOString(),
      }),
    };
  } catch (e) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ trades: [], total: 0, error: e.message }) };
  }
};
