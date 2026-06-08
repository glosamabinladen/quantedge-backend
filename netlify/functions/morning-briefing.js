// netlify/functions/morning-briefing.js
// Scheduled: 9AM EST weekdays (14:00 UTC) via netlify.toml
// Also HTTP-callable for manual trigger

import { getStore } from "@netlify/blobs";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const POLYGON_API_KEY   = process.env.POLYGON_API_KEY;
const FINNHUB_API_KEY   = process.env.FINNHUB_API_KEY;

const WATCHLIST = ["AAPL","NVDA","TSLA","SPY","QQQ","MSFT","META","AMD","COIN","PLTR","AMZN","GOOGL"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

// ── MARKET DATA ───────────────────────────────────────────
async function getMarketData() {
  const data = {};

  // Finnhub first (higher rate limit)
  if (FINNHUB_API_KEY) {
    await Promise.all(WATCHLIST.map(async (sym) => {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_API_KEY}`);
        const d = await r.json();
        if (d.c > 0) {
          data[sym] = {
            price: d.c.toFixed(2),
            chg:   d.pc > 0 ? (((d.c - d.pc) / d.pc) * 100).toFixed(2) : "0.00",
            high:  (d.h || d.c).toFixed(2),
            low:   (d.l || d.c).toFixed(2),
            open:  (d.o || d.c).toFixed(2),
            prev:  (d.pc || d.c).toFixed(2),
          };
        }
      } catch {}
    }));
  }

  // Polygon fallback for any missing
  if (POLYGON_API_KEY && Object.keys(data).length < WATCHLIST.length) {
    const missing = WATCHLIST.filter(s => !data[s]).join(",");
    if (missing) {
      try {
        const r = await fetch(
          `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${missing}&apiKey=${POLYGON_API_KEY}`
        );
        const snap = await r.json();
        if (snap.tickers) {
          snap.tickers.forEach((t) => {
            const day = t.day || {};
            const prev = t.prevDay || {};
            const price = (t.lastTrade?.p) || day.c || prev.c || 0;
            if (price > 0) {
              data[t.ticker] = {
                price: price.toFixed(2),
                chg:   prev.c > 0 ? (((price - prev.c) / prev.c) * 100).toFixed(2) : "0.00",
                high:  (day.h || price).toFixed(2),
                low:   (day.l || price).toFixed(2),
                open:  (day.o || price).toFixed(2),
                prev:  (prev.c || price).toFixed(2),
              };
            }
          });
        }
      } catch {}
    }
  }

  return data;
}

// ── EXTRACT JSON ──────────────────────────────────────────
function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(clean); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

// ── GENERATE BRIEFING ─────────────────────────────────────
async function generateBriefing(marketData) {
  if (!ANTHROPIC_API_KEY) {
    return { bias: "NEUTRAL", summary: "ANTHROPIC_API_KEY not set.", topPicks: [], avoid: [], mantra: "No key, no edge." };
  }

  const lines = Object.entries(marketData)
    .map(([sym, d]) => {
      const chgNum = parseFloat(d.chg);
      const rangeHigh = ((parseFloat(d.high) - parseFloat(d.low)) / parseFloat(d.low) * 100).toFixed(1);
      return `${sym}: $${d.price} (${chgNum >= 0 ? "+" : ""}${d.chg}%) | O:$${d.open} H:$${d.high} L:$${d.low} | DayRange:${rangeHigh}%`;
    })
    .join("\n");

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" });

  const prompt = `You are QuantEdge Pro's head analyst. Generate a high-conviction morning briefing for ${dateStr}.

Pre-market / early session data:
${lines || "Market data unavailable — use general market knowledge."}

Focus on: momentum plays, breakout setups, volume anomalies, sector rotation, and macro catalysts.
Identify 3 specific trades with clear entry levels, stops, and targets.
Be direct and opinionated — traders need conviction, not hedging.

Respond with ONLY valid JSON, no markdown:
{
  "bias": "BULLISH" | "BEARISH" | "NEUTRAL",
  "summary": "2-3 sentence market read with specific levels and reasoning",
  "topPicks": [
    {
      "ticker": "NVDA",
      "direction": "LONG",
      "entry": "$XXX",
      "stop": "$XXX",
      "target": "$XXX",
      "reason": "specific technical/fundamental catalyst",
      "setupType": "pattern name"
    }
  ],
  "avoid": [
    { "ticker": "TSLA", "reason": "specific risk today" }
  ],
  "keyLevels": {
    "SPY": { "support": "$XXX", "resistance": "$XXX" },
    "QQQ": { "support": "$XXX", "resistance": "$XXX" }
  },
  "sectorFocus": "sector name",
  "riskLevel": "LOW" | "MEDIUM" | "HIGH",
  "mantra": "single motivational trading rule for today"
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 1200,
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();
    const rawText = data.content?.[0]?.text || "";
    console.log("Claude briefing raw:", rawText.slice(0, 200));

    const parsed = extractJSON(rawText);
    if (!parsed?.bias) {
      console.error("Briefing parse failed:", rawText.slice(0, 200));
      return { bias: "NEUTRAL", summary: "Briefing parse error — trade cautiously.", topPicks: [], avoid: [], mantra: "When in doubt, stay out." };
    }
    return parsed;
  } catch (e) {
    console.error("Claude API error:", e.message);
    return { bias: "NEUTRAL", summary: "API error — trade cautiously.", topPicks: [], avoid: [], mantra: "No signal, no trade." };
  }
}

// ── HANDLER ───────────────────────────────────────────────
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "ok" };

  console.log("Morning briefing triggered:", new Date().toISOString());

  try {
    const marketData = await getMarketData();
    console.log("Market data fetched for", Object.keys(marketData).length, "tickers");

    const briefing = await generateBriefing(marketData);

    // Store in Blobs — simple auto-context, no manual token needed
    let stored = false;
    try {
      const store = getStore("briefings");
      await store.setJSON("morning-briefing", {
        briefing,
        generatedAt: new Date().toISOString(),
        date: new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }),
      });
      stored = true;
      console.log("Briefing stored ✓ bias:", briefing.bias);
    } catch (e) {
      console.error("Store error:", e.message);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, stored, briefing, generatedAt: new Date().toISOString() }),
    };
  } catch (err) {
    console.error("morning-briefing fatal:", err.message);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
