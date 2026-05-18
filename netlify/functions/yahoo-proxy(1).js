// netlify/functions/yahoo-proxy.js
// Fetches ticker snapshots via Polygon.io (replaces broken Yahoo Finance)
// GET ?symbols=AAPL,NVDA,TSLA  → returns price snapshot for all symbols
// Uses POLYGON_API_KEY env var (already set on this site)

const https = require("https");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "ok" };
  }

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: "POLYGON_API_KEY not set" }),
    };
  }

  const symsParam =
    (event.queryStringParameters && event.queryStringParameters.symbols) || "AAPL";
  const syms = symsParam
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 20);

  // Use Polygon /v2/snapshot/locale/us/markets/stocks/tickers bulk endpoint
  const tickerList = syms.join(",");
  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerList}&apiKey=${apiKey}`;

  try {
    const data = await httpsGet(url);

    const snapshot = {};

    // Initialize all syms to null first
    syms.forEach((s) => { snapshot[s] = null; });

    if (data.tickers && Array.isArray(data.tickers)) {
      data.tickers.forEach((t) => {
        const sym = t.ticker;
        const day = t.day || {};
        const prevDay = t.prevDay || {};
        const lastTrade = t.lastTrade || {};
        const lastQuote = t.lastQuote || {};

        // Current price: prefer last trade, fallback to day close, fallback to prevDay close
        const price = lastTrade.p || day.c || prevDay.c || 0;
        const prev = prevDay.c || 0;
        const open = day.o || prev || 0;
        const high = day.h || price || 0;
        const low = day.l || price || 0;
        const vol = day.v || 0;
        const vwap = day.vw || price || 0;
        const chg = prev > 0 ? ((price - prev) / prev) * 100 : 0;

        if (price > 0) {
          snapshot[sym] = { price, open, high, low, vol, vwap, chg, prev };
        }
      });
    }

    // Fallback: if bulk snapshot returned nothing (free tier may not support it),
    // try individual prev-close endpoint for each symbol
    const nullSyms = syms.filter((s) => !snapshot[s]);
    if (nullSyms.length > 0) {
      await Promise.all(
        nullSyms.map(async (sym) => {
          try {
            const prevUrl = `https://api.polygon.io/v2/aggs/ticker/${sym}/prev?adjusted=true&apiKey=${apiKey}`;
            const prev = await httpsGet(prevUrl);
            if (prev.results && prev.results[0]) {
              const r = prev.results[0];
              const price = r.c || 0;
              const prevClose = r.o || price; // use open as rough prev if no prev
              snapshot[sym] = {
                price,
                open: r.o || price,
                high: r.h || price,
                low: r.l || price,
                vol: r.v || 0,
                vwap: r.vw || price,
                chg: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
                prev: prevClose,
              };
            }
          } catch (_) {
            // leave as null
          }
        })
      );
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ snapshot, fetchedAt: new Date().toISOString() }),
    };
  } catch (err) {
    console.error("yahoo-proxy (polygon) error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
