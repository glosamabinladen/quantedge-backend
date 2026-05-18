// netlify/functions/morning-briefing.js
// Scheduled: 9AM EST weekdays (14:00 UTC) via netlify.toml
// Also HTTP-callable for manual trigger

const https = require("https");
const { getStore } = require("@netlify/blobs");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

const WATCHLIST = ["AAPL","NVDA","TSLA","SPY","MSFT","META","AMD","COIN","PLTR","AMZN"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

// ── HTTP HELPERS ──────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { "User-Agent": "QuantEdge/1.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve({}); }
      });
    }).on("error", () => resolve({}));
  });
}

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve({}); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── ROBUST JSON EXTRACTOR ─────────────────────────────────
function extractJSON(text) {
  if (!text) return null;
  // Try direct parse first
  try { return JSON.parse(text); } catch (_) {}
  // Strip markdown fences
  let clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(clean); } catch (_) {}
  // Find first { ... } block
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

// ── MARKET DATA ───────────────────────────────────────────
async function getMarketData() {
  const data = {};

  // Try Finnhub first (higher rate limit)
  if (FINNHUB_API_KEY) {
    await Promise.all(WATCHLIST.map(async (sym) => {
      try {
        const r = await httpsGet(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_API_KEY}`);
        if (r.c > 0) {
          data[sym] = {
            price: r.c.toFixed(2),
            chg: r.pc > 0 ? (((r.c - r.pc) / r.pc) * 100).toFixed(2) : "0.00",
            high: (r.h || r.c).toFixed(2),
            low: (r.l || r.c).toFixed(2),
          };
        }
      } catch (_) {}
    }));
  }

  // Polygon fallback for any missing
  if (POLYGON_API_KEY && Object.keys(data).length < WATCHLIST.length) {
    const missing = WATCHLIST.filter(s => !data[s]).join(",");
    if (missing) {
      const snap = await httpsGet(
        `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${missing}&apiKey=${POLYGON_API_KEY}`
      );
      if (snap.tickers) {
        snap.tickers.forEach((t) => {
          const day = t.day || {};
          const prev = t.prevDay || {};
          const price = (t.lastTrade && t.lastTrade.p) || day.c || prev.c || 0;
          if (price > 0) {
            data[t.ticker] = {
              price: price.toFixed(2),
              chg: prev.c > 0 ? (((price - prev.c) / prev.c) * 100).toFixed(2) : "0.00",
              high: (day.h || price).toFixed(2),
              low: (day.l || price).toFixed(2),
            };
          }
        });
      }
    }
  }

  return data;
}

// ── GENERATE BRIEFING ─────────────────────────────────────
async function generateBriefing(marketData) {
  if (!ANTHROPIC_API_KEY) {
    return {
      bias: "NEUTRAL",
      summary: "ANTHROPIC_API_KEY not set.",
      topPicks: [], avoid: [],
      sectorFocus: "Broad Market",
      riskLevel: "MEDIUM",
      mantra: "No key, no edge.",
    };
  }

  const lines = Object.entries(marketData)
    .map(([sym, d]) => `${sym}: $${d.price} (${parseFloat(d.chg) >= 0 ? "+" : ""}${d.chg}%) H:${d.high} L:${d.low}`)
    .join("\n");

  const prompt = `You are QuantEdge Pro's AI market analyst. Generate a morning briefing for today's trading session.

Early market data:
${lines || "Market data unavailable — use general market knowledge."}

Respond with ONLY a valid JSON object. No markdown, no explanation, no text before or after. Raw JSON only:
{
  "bias": "BULLISH",
  "summary": "2-3 sentence overview of market conditions and key themes",
  "topPicks": [
    {"ticker": "AAPL", "direction": "LONG", "reason": "brief reason", "keyLevel": "$296"},
    {"ticker": "COIN", "direction": "SHORT", "reason": "brief reason", "keyLevel": "$188"},
    {"ticker": "NVDA", "direction": "LONG", "reason": "brief reason", "keyLevel": "$222"}
  ],
  "avoid": [
    {"ticker": "TSLA", "reason": "why to avoid today"}
  ],
  "sectorFocus": "Tech",
  "riskLevel": "MEDIUM",
  "mantra": "Cut losers fast, let winners run."
}`;

  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const options = {
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  try {
    const response = await httpsPost(options, body);
    const rawText = response.content?.[0]?.text || "";
    console.log("Claude raw response:", rawText.slice(0, 300));

    const parsed = extractJSON(rawText);
    if (!parsed || !parsed.bias) {
      console.error("Failed to parse briefing JSON:", rawText.slice(0, 200));
      return {
        bias: "NEUTRAL",
        summary: "Briefing parse failed — trade cautiously.",
        topPicks: [], avoid: [],
        sectorFocus: "Broad Market",
        riskLevel: "HIGH",
        mantra: "When in doubt, stay out.",
      };
    }
    return parsed;
  } catch (e) {
    console.error("Claude API error:", e.message);
    return {
      bias: "NEUTRAL",
      summary: "API error — trade cautiously.",
      topPicks: [], avoid: [],
      sectorFocus: "Broad Market",
      riskLevel: "HIGH",
      mantra: "No signal, no trade.",
    };
  }
}

// ── STORE BRIEFING ────────────────────────────────────────
async function storeBriefing(briefing, context) {
  try {
 const siteID = process.env.NETLIFY_SITE_ID || "extraordinary-mandazi-a05e7e";
    const token = process.env.NETLIFY_TOKEN;
    const storeConfig = token
      ? { name: "briefings", siteID, token }
      : { name: "briefings", siteID };

    const store = getStore(storeConfig);
    await store.set("morning-briefing", JSON.stringify({
      briefing,
      generatedAt: new Date().toISOString(),
      date: new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }),
    }));
    console.log("Briefing stored ✓ bias:", briefing.bias);
    return true;
  } catch (e) {
    console.error("Store error:", e.message);
    return false;
  }
}

// ── HANDLER ───────────────────────────────────────────────
exports.handler = async function (event, context) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "ok" };
  }

  console.log("Morning briefing triggered:", new Date().toISOString());

  try {
    const marketData = await getMarketData();
    console.log("Market data fetched for", Object.keys(marketData).length, "tickers");

    const briefing = await generateBriefing(marketData);
    const stored = await storeBriefing(briefing, context);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        stored,
        briefing,
        generatedAt: new Date().toISOString(),
      }),
    };
  } catch (err) {
    console.error("morning-briefing fatal:", err.message);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};
