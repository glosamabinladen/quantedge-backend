// netlify/functions/yahoo-proxy.js
// Proxies Yahoo Finance chart requests server-side (no CORS issues)
// GET ?symbols=AAPL,NVDA,TSLA  → returns price snapshot for all symbols

const https = require("https");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

function fetchYahoo(sym) {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
      },
    };

    https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const meta = json?.chart?.result?.[0]?.meta;
          if (!meta) return resolve({ sym, data: null });
          resolve({
            sym,
            data: {
              price: meta.regularMarketPrice || 0,
              open: meta.regularMarketOpen || 0,
              high: meta.regularMarketDayHigh || 0,
              low: meta.regularMarketDayLow || 0,
              vol: meta.regularMarketVolume || 0,
              vwap: meta.regularMarketPrice || 0,
              chg: meta.previousClose > 0
                ? ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose * 100)
                : 0,
              prev: meta.previousClose || 0,
            },
          });
        } catch (e) {
          resolve({ sym, data: null });
        }
      });
    }).on("error", () => resolve({ sym, data: null }));
  });
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "ok" };
  }

  try {
    const symsParam = (event.queryStringParameters && event.queryStringParameters.symbols) || "AAPL";
    const syms = symsParam.split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);

    const results = await Promise.all(syms.map(fetchYahoo));

    const snapshot = {};
    results.forEach(({ sym, data }) => {
      snapshot[sym] = data;
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ snapshot, fetchedAt: new Date().toISOString() }),
    };
  } catch (err) {
    console.error("yahoo-proxy error:", err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
