// netlify/functions/morning-briefing.js
// Scheduled: 9AM EST weekdays (14:00 UTC) | HTTP-callable for manual trigger

import { getStore } from "@netlify/blobs";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const POLYGON_KEY   = process.env.POLYGON_API_KEY;
const FINNHUB_KEY   = process.env.FINNHUB_API_KEY;

const WATCHLIST = ["AAPL","NVDA","TSLA","SPY","QQQ","MSFT","META","AMD","COIN","PLTR","AMZN","GOOGL"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

const blob = (name) => getStore({
  name,
  siteID: process.env.NETLIFY_SITE_ID,
  token:  process.env.NETLIFY_AUTH_TOKEN,
});

function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(clean); } catch {}
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} }
  return null;
}

async function getMarketData() {
  const data = {};

  if (FINNHUB_KEY) {
    await Promise.all(WATCHLIST.map(async (sym) => {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`);
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

  if (POLYGON_KEY && Object.keys(data).length < WATCHLIST.length) {
    const missing = WATCHLIST.filter(s => !data[s]).join(",");
    if (missing) {
      try {
        const r = await fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${missing}&apiKey=${POLYGON_KEY}`);
        const snap = await r.json();
        if (snap.tickers) {
          snap.tickers.forEach(t => {
            const day = t.day || {}, prev = t.prevDay || {};
            const price = t.lastTrade?.p || day.c || prev.c || 0;
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

async function generateBriefing(marketData) {
  if (!ANTHROPIC_KEY) return { bias: "NEUTRAL", summary: "ANTHROPIC_API_KEY not set.", topPicks: [], avoid: [], mantra: "No key, no edge." };

  const hasData = Object.keys(marketData).length > 0;
  const lines = hasData
    ? Object.entries(marketData).map(([sym, d]) => {
        const chg = parseFloat(d.chg);
        return `${sym}: $${d.price} (${chg >= 0 ? "+" : ""}${d.chg}%) | O:$${d.open} H:$${d.high} L:$${d.low} | Prev:$${d.prev}`;
      }).join("\n")
    : "Market data unavailable (outside market hours) — use recent market knowledge.";

  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" });

  const prompt = `You are QuantEdge Pro's head analyst. Generate a morning briefing for ${dateStr}.

${hasData ? "Pre-market / early session data:" : "Note: Market is currently closed. Base analysis on recent trends and known catalysts."}
${lines}

Identify 3 high-conviction trades for today's session. Be specific with levels.

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "bias": "BULLISH",
  "summary": "2-3 sentence market read with specific levels",
  "topPicks": [
    { "ticker": "NVDA", "direction": "LONG", "entry": "$XXX", "stop": "$XXX", "target": "$XXX", "reason": "specific catalyst", "setupType": "pattern" }
  ],
  "avoid": [{ "ticker": "TSLA", "reason": "specific risk" }],
  "keyLevels": { "SPY": { "support": "$XXX", "resistance": "$XXX" } },
  "sectorFocus": "Tech",
  "riskLevel": "MEDIUM",
  "mantra": "single trading rule for today"
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json();
    const rawText = data.content?.[0]?.text || "";
    console.log("Claude briefing raw:", rawText.slice(0, 300));
    const parsed = extractJSON(rawText);
    if (!parsed?.bias) {
      console.error("Parse failed:", rawText.slice(0, 300));
      return { bias: "NEUTRAL", summary: "Briefing generation failed — trade cautiously.", topPicks: [], avoid: [], mantra: "When in doubt, stay out." };
    }
    return parsed;
  } catch (e) {
    console.error("Claude error:", e.message);
    return { bias: "NEUTRAL", summary: "API error — trade cautiously.", topPicks: [], avoid: [], mantra: "No signal, no trade." };
  }
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "ok" };

  console.log("Morning briefing triggered:", new Date().toISOString());

  const marketData = await getMarketData();
  console.log("Market data:", Object.keys(marketData).length, "tickers");

  const briefing = await generateBriefing(marketData);

  let stored = false;
  try {
    const store = blob("briefings");
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
};
