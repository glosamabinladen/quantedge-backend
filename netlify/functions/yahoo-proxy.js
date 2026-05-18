// netlify/functions/yahoo-proxy.js
// Uses Finnhub API — 60 calls/min on free tier, no rate limit issues
// GET ?symbols=AAPL,NVDA,TSLA → returns price snapshot

const https = require("https");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

function httpsGet(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { "User-Agent": "QuantEdge/1.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, body: {} }); }
      });
    }).on("error", () => resolve({ status: 0, body: {} }));
  });
}

async function getFinnhubQuote(sym, token) {
  const res = await httpsGet(
    `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${token}`
  );
  if (res.status === 200 && res.body.c > 0) {
    const { c: price, o: open, h: high, l: low, pc: prev } = res.body;
    return {
      price,
      open,
      high,
      low,
      vol: 0, // Finnhub quote doesn't include vol — acceptable
      vwap: price,
      chg: prev > 0 ? ((price - prev) / prev) * 100 : 0,
      prev,
    };
  }
  return null;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "ok" };
  }

  const token = process.env.FINNHUB_API_KEY;
  if (!token) {
    // Fallback to Polygon if no Finnhub key
    return fallbackToPolygon(event);
  }

  const symsParam = (event.queryStringParameters && event.queryStringParameters.symbols) || "AAPL";
  const syms = symsParam.split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);

  // Finnhub: fetch all in parallel — 60 calls/min limit, well within budget
  const results = await Promise.all(
    syms.map(async sym => {
      try {
        const data = await getFinnhubQuote(sym, token);
        return { sym, data };
      } catch (_) {
        return { sym, data: null };
      }
    })
  );

  const snapshot = {};
  results.forEach(({ sym, data }) => { snapshot[sym] = data; });

  const hits = results.filter(r => r.data).length;

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      snapshot,
      meta: { hit: hits, miss: syms.length - hits, total: syms.length, source: "finnhub" },
      fetchedAt: new Date().toISOString(),
    }),
  };
};

// ── POLYGON FALLBACK (if no Finnhub key set) ──────────────
async function fallbackToPolygon(event) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ snapshot: {}, error: "No API keys configured (FINNHUB_API_KEY or POLYGON_API_KEY)" }),
    };
  }

  const symsParam = (event.queryStringParameters && event.queryStringParameters.symbols) || "AAPL";
  const syms = symsParam.split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);
  const tickerList = syms.join(",");

  const snapshot = {};
  syms.forEach(s => { snapshot[s] = null; });

  try {
    const res = await new Promise((resolve) => {
      https.get(
        `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerList}&apiKey=${apiKey}`,
        { headers: { "User-Agent": "QuantEdge/1.0" } },
        (r) => {
          let d = "";
          r.on("data", c => d += c);
          r.on("end", () => { try { resolve(JSON.parse(d)); } catch (_) { resolve({}); } });
        }
      ).on("error", () => resolve({}));
    });

    if (res.tickers) {
      res.tickers.forEach(t => {
        const day = t.day || {};
        const prevDay = t.prevDay || {};
        const price = (t.lastTrade && t.lastTrade.p) || day.c || prevDay.c || 0;
        const prev = prevDay.c || 0;
        if (price > 0) {
          snapshot[t.ticker] = {
            price, open: day.o || prev, high: day.h || price,
            low: day.l || price, vol: day.v || 0, vwap: day.vw || price,
            chg: prev > 0 ? ((price - prev) / prev) * 100 : 0, prev,
          };
        }
      });
    }
  } catch (_) {}

  return {
    statusCode: 200,
    headers: { ...CORS },
    body: JSON.stringify({ snapshot, meta: { source: "polygon" }, fetchedAt: new Date().toISOString() }),
  };
}
