// netlify/functions/get-trades.js
// GET /api/get-trades — returns recent automated trades from journal
// GET /api/get-trades?limit=20 — returns last N trades

import { getStore } from "@netlify/blobs";

const CORS = {
  "Content-Type":                "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods":"GET, OPTIONS",
  "Access-Control-Allow-Headers":"Content-Type",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  try {
    const limit = parseInt(event.queryStringParameters?.limit || "50");
    const store = getStore("trade-journal");
    const { blobs } = await store.list();

    const trades = [];
    for (const { key } of blobs) {
      try {
        const trade = await store.getJSON(key);
        if (trade) trades.push(trade);
      } catch {}
    }

    // Sort newest first
    trades.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        trades: trades.slice(0, limit),
        total:  trades.length,
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: e.message, trades: [] }),
    };
  }
};

Claude
Claude
Hey — I'm Claude. I can see this page and I'm ready to help.

Use the quick buttons above or just ask me anything.
Claude Sonnet · Tampermonkey
