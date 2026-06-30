// netlify/functions/morning-briefing.js
// Scheduled: 9AM EDT weekdays (13:00 UTC) via netlify.toml
// Also HTTP-callable: ?force=1 bypasses schedule check

import { getStore } from "@netlify/blobs";

const WATCHLIST = ["AAPL","NVDA","TSLA","SPY","MSFT","META","AMD","COIN","PLTR","AMZN"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
  "Netlify-CDN-Cache-Control": "no-store",
};

// ── BLOBS (explicit auth required outside scheduled context) ──────────────────
const blob = (name) => getStore({
  name,
  siteID: process.env.NETLIFY_SITE_ID,
  token:  process.env.NETLIFY_AUTH_TOKEN,
});

// ── HTTP HELPERS ──────────────────────────────────────────────────────────────
async function httpGet(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "QuantEdge/1.0" } });
    return await r.json();
  } catch (_) { return {}; }
}

async function httpPost(url, headers, body) {
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return r.json();
}

// ── ROBUST JSON EXTRACTOR ─────────────────────────────────────────────────────
function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(clean); } catch (_) {}
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

// ── MARKET DATA ───────────────────────────────────────────────────────────────
async function getMarketData() {
  const data = {};
  const FINNHUB_API_KEY  = process.env.FINNHUB_API_KEY;
  const POLYGON_API_KEY  = process.env.POLYGON_API_KEY;

  if (FINNHUB_API_KEY) {
    await Promise.all(WATCHLIST.map(async (sym) => {
      try {
        const r = await httpGet(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_API_KEY}`);
        if (r.c > 0) {
          data[sym] = {
            price: r.c.toFixed(2),
            chg:   r.pc > 0 ? (((r.c - r.pc) / r.pc) * 100).toFixed(2) : "0.00",
            high:  (r.h || r.c).toFixed(2),
            low:   (r.l || r.c).toFixed(2),
          };
        }
      } catch (_) {}
    }));
  }

  if (POLYGON_API_KEY && Object.keys(data).length < WATCHLIST.length) {
    const missing = WATCHLIST.filter(s => !data[s]).join(",");
    if (missing) {
      const snap = await httpGet(
        `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${missing}&apiKey=${POLYGON_API_KEY}`
      );
      if (snap.tickers) {
        snap.tickers.forEach((t) => {
          const day  = t.day    || {};
          const prev = t.prevDay || {};
          const price = (t.lastTrade?.p) || day.c || prev.c || 0;
          if (price > 0) {
            data[t.ticker] = {
              price: price.toFixed(2),
              chg:   prev.c > 0 ? (((price - prev.c) / prev.c) * 100).toFixed(2) : "0.00",
              high:  (day.h || price).toFixed(2),
              low:   (day.l || price).toFixed(2),
            };
          }
        });
      }
    }
  }

  return data;
}

// ── GENERATE BRIEFING ─────────────────────────────────────────────────────────
async function generateBriefing(marketData) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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

  try {
    const response = await httpPost(
      "https://api.anthropic.com/v1/messages",
      {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      {
        model:      "claude-sonnet-4-6",
        max_tokens: 1000,
        messages:   [{ role: "user", content: prompt }],
      }
    );

    const rawText = response.content?.[0]?.text || "";
    console.log("Claude raw response:", rawText.slice(0, 300));

    const parsed = extractJSON(rawText);
    if (!parsed || !parsed.bias) {
      console.error("Failed to parse briefing JSON:", rawText.slice(0, 200));
      return {
        bias: "NEUTRAL",
        summary: "Briefing generation failed — trade cautiously.",
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

// ── HANDLER ───────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "ok" };
  }

  console.log("Morning briefing triggered:", new Date().toISOString());

  try {
    const marketData = await getMarketData();
    console.log("Market data fetched for", Object.keys(marketData).length, "tickers");

    const briefing    = await generateBriefing(marketData);
    const generatedAt = new Date().toISOString();

    let stored = false;
    try {
      const store = blob("briefings");
      await store.set("morning-briefing", JSON.stringify({
        briefing,
        generatedAt,
        date: new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }),
      }));
      console.log("Briefing stored ✓ bias:", briefing.bias);
      stored = true;
    } catch (e) {
      console.error("Store error:", e.message);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, stored, briefing, generatedAt }),
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
