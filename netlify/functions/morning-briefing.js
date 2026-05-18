// netlify/functions/morning-briefing.js
// Scheduled: runs at 9AM EST on weekdays (14:00 UTC)
// Generates AI market briefing and stores in Netlify Blobs

const https = require("https");
const { getStore } = require("@netlify/blobs");

// ── CONFIG ────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;

const WATCHLIST = ["AAPL","NVDA","TSLA","SPY","MSFT","META","AMD","COIN","PLTR","AMZN","GOOGL","NFLX","QQQ","SOFI","HOOD"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

// ── HELPERS ───────────────────────────────────────────────
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

// ── FETCH MARKET SNAPSHOT ─────────────────────────────────
async function getMarketData() {
  if (!POLYGON_API_KEY) return {};

  const tickerList = WATCHLIST.join(",");
  const snap = await httpsGet(
    `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerList}&apiKey=${POLYGON_API_KEY}`
  );

  const data = {};
  if (snap.tickers) {
    snap.tickers.forEach((t) => {
      const day = t.day || {};
      const prevDay = t.prevDay || {};
      const price = (t.lastTrade && t.lastTrade.p) || day.c || prevDay.c || 0;
      const prev = prevDay.c || 0;
      data[t.ticker] = {
        price: price.toFixed(2),
        chg: prev > 0 ? (((price - prev) / prev) * 100).toFixed(2) : "0.00",
        vol: day.v || 0,
        high: (day.h || price).toFixed(2),
        low: (day.l || price).toFixed(2),
      };
    });
  }
  return data;
}

// ── GENERATE BRIEFING VIA CLAUDE ──────────────────────────
async function generateBriefing(marketData) {
  if (!ANTHROPIC_API_KEY) {
    return {
      bias: "NEUTRAL",
      summary: "API key not configured — briefing unavailable.",
      topPicks: [],
      avoid: [],
      mantra: "No edge found, no trade placed.",
    };
  }

  const marketSummary = Object.entries(marketData)
    .map(([sym, d]) => `${sym}: $${d.price} (${d.chg > 0 ? "+" : ""}${d.chg}%) Vol:${(d.vol/1e6).toFixed(1)}M`)
    .join("\n");

  const prompt = `You are QuantEdge Pro's market analyst. It is 9AM EST market open.

Current pre-market / early data:
${marketSummary || "No market data available yet."}

Generate a concise morning briefing in this EXACT JSON format (no markdown, no explanation, raw JSON only):
{
  "bias": "BULLISH" | "BEARISH" | "NEUTRAL" | "VOLATILE",
  "summary": "2-3 sentence market overview covering macro context, sector strength/weakness, and key risks today",
  "topPicks": [
    {"ticker": "SYM", "direction": "LONG" | "SHORT", "reason": "one sentence reason", "keyLevel": "$XXX"},
    {"ticker": "SYM", "direction": "LONG" | "SHORT", "reason": "one sentence reason", "keyLevel": "$XXX"},
    {"ticker": "SYM", "direction": "LONG" | "SHORT", "reason": "one sentence reason", "keyLevel": "$XXX"}
  ],
  "avoid": [
    {"ticker": "SYM", "reason": "one sentence why to avoid today"}
  ],
  "sectorFocus": "Tech | Energy | Financials | Healthcare | Consumer | Crypto | Broad Market",
  "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "EXTREME",
  "mantra": "one punchy trading mantra for today (max 10 words)"
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
    const text = response.content?.[0]?.text || "{}";
    // Strip any markdown fences
    const clean = text.replace(/```json\n?|\n?```/g, "").trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error("Claude briefing parse error:", e.message);
    return {
      bias: "NEUTRAL",
      summary: "Briefing generation failed — trade with caution.",
      topPicks: [],
      avoid: [],
      mantra: "When in doubt, stay out.",
    };
  }
}

// ── STORE BRIEFING ────────────────────────────────────────
async function storeBriefing(briefing, context) {
  try {
    const siteID =
      (context && context.site && context.site.id) ||
      process.env.NETLIFY_SITE_ID ||
      "extraordinary-mandazi-a05e7e";
    const token = process.env.NETLIFY_TOKEN;
    const storeConfig = token
      ? { name: "briefings", siteID, token }
      : { name: "briefings", siteID };

    const store = getStore(storeConfig);
    const payload = JSON.stringify({
      briefing,
      generatedAt: new Date().toISOString(),
      date: new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }),
    });
    await store.set("morning-briefing", payload);
    console.log("Morning briefing stored ✓");
  } catch (e) {
    console.error("Failed to store briefing:", e.message);
  }
}

// ── HANDLER ───────────────────────────────────────────────
exports.handler = async function (event, context) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "ok" };
  }

  console.log("Morning briefing triggered at", new Date().toISOString());

  try {
    const marketData = await getMarketData();
    const briefing = await generateBriefing(marketData);
    await storeBriefing(briefing, context);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
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
