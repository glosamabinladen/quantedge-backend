// netlify/functions/yahoo-proxy.js
// Fetches ticker snapshots via Polygon.io
// Tries snapshot → prev aggs → last trade in sequence per ticker

const https = require("https");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "QuantEdge/1.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: {} }); }
      });
    }).on("error", (e) => resolve({ status: 0, body: {}, err: e.message }));
  });
}

async function getTickerData(sym, apiKey) {
  // Strategy 1: snapshot (works for stocks on free tier)
  const snap = await httpsGet(
    `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${sym}?apiKey=${apiKey}`
  );
  if (snap.status === 200 && snap.body.ticker) {
    const t = snap.body.ticker;
    const day = t.day || {};
    const prevDay = t.prevDay || {};
    const price = t.lastTrade?.p || day.c || prevDay.c || 0;
    const prev = prevDay.c || 0;
    if (price > 0) {
      return {
        price,
        open: day.o || prev,
        high: day.h || price,
        low: day.l || price,
        vol: day.v || 0,
        vwap: day.vw || price,
        chg: prev > 0 ? ((price - prev) / prev) * 100 : 0,
        prev,
      };
    }
  }

  // Strategy 2: previous day aggs (works for ETFs like SPY)
  const agg = await httpsGet(
    `https://api.polygon.io/v2/aggs/ticker/${sym}/prev?adjusted=true&apiKey=${apiKey}`
  );
  if (agg.status === 200 && agg.body.results?.[0]) {
    const r = agg.body.results[0];
    if (r.c > 0) {
      return {
        price: r.c,
        open: r.o,
        high: r.h,
        low: r.l,
        vol: r.v || 0,
        vwap: r.vw || r.c,
        chg: r.o > 0 ? ((r.c - r.o) / r.o) * 100 : 0,
        prev: r.o,
      };
    }
  }

  // Strategy 3: last trade
  const last = await httpsGet(
    `https://api.polygon.io/v2/last/trade/${sym}?apiKey=${apiKey}`
  );
  if (last.status === 200 && last.body.results?.p > 0) {
    const p = last.body.results.p;
    return { price: p, open: p, high: p, low: p, vol: 0, vwap: p, chg: 0, prev: p };
  }

  return null;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "ok" };
  }

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "POLYGON_API_KEY not set" }) };
  }

  const symsParam = (event.queryStringParameters?.symbols) || "AAPL";
  const syms = symsParam.split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);

  // Fetch all tickers in parallel
  const results = await Promise.all(syms.map(async (sym) => {
    try {
      const data = await getTickerData(sym, apiKey);
      return { sym, data };
    } catch (e) {
      return { sym, data: null };
    }
  }));

  const snapshot = {};
  results.forEach(({ sym, data }) => { snapshot[sym] = data; });

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ snapshot, fetchedAt: new Date().toISOString() }),
  };
};
