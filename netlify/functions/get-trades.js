// netlify/functions/get-trades.js
import { getStore } from "@netlify/blobs";

export const handler = async (event) => {
  const CORS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  try {
    const limit = parseInt(event.queryStringParameters?.limit || "50");
    const store = getStore("trade-journal");
    
    let blobs = [];
    try {
      const result = await store.list();
      blobs = result.blobs || [];
    } catch {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ trades: [], total: 0 }) };
    }

    if (!blobs.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ trades: [], total: 0 }) };
    }

    const trades = [];
    for (const { key } of blobs) {
      try {
        const trade = await store.getJSON(key);
        if (trade) trades.push(trade);
      } catch {}
    }

    trades.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ trades: trades.slice(0, limit), total: trades.length }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ trades: [], total: 0, error: e.message }),
    };
  }
};
