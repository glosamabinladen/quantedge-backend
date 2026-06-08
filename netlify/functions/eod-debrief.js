// netlify/functions/eod-debrief.js
// SCHEDULED: 4:05 PM EST (21:05 UTC) — Monday through Friday

import { getStore } from "@netlify/blobs";

const blob = (name) => getStore({
  name,
  siteID: process.env.NETLIFY_SITE_ID,
  token:  process.env.NETLIFY_AUTH_TOKEN,
});

const ALPACA_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_SEC    = process.env.ALPACA_API_SECRET;
const CLAUDE_KEY    = process.env.ANTHROPIC_API_KEY;

const ALPACA_HEADERS = {
  "APCA-API-KEY-ID":     ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SEC,
  "Content-Type":        "application/json",
};

export const handler = async () => {
  if (!ALPACA_KEY || !CLAUDE_KEY) {
    console.error("Missing API keys");
    return { statusCode: 500, body: "Missing API keys" };
  }

  console.log("EOD Debrief starting:", new Date().toISOString());

  // 1. Pull account snapshot
  let account = {};
  try {
    const r = await fetch("https://paper-api.alpaca.markets/v2/account", { headers: ALPACA_HEADERS });
    account = await r.json();
    console.log(`Portfolio value: $${account.portfolio_value}`);
  } catch (err) {
    console.error("Alpaca account fetch failed:", err.message);
  }

  // 2. Pull today's orders
  let orders = [];
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const r = await fetch(
      `https://paper-api.alpaca.markets/v2/orders?status=all&limit=50&after=${today.toISOString()}`,
      { headers: ALPACA_HEADERS }
    );
    orders = await r.json();
    if (!Array.isArray(orders)) orders = [];
  } catch (err) {
    console.error("Alpaca orders fetch failed:", err.message);
  }

  // 3. Pull open positions
  let positions = [];
  try {
    const r = await fetch("https://paper-api.alpaca.markets/v2/positions", { headers: ALPACA_HEADERS });
    positions = await r.json();
    if (!Array.isArray(positions)) positions = [];
  } catch (err) {
    console.error("Alpaca positions fetch failed:", err.message);
  }

  // 4. Compute day P&L
  const equity = parseFloat(account.equity || 0);
  const lastEquity = parseFloat(account.last_equity || 0);
  const dayPnl = equity - lastEquity;

  const orderSummary = orders.length
    ? orders.map(o => `${o.symbol} ${o.side.toUpperCase()} ${o.qty}x @ $${o.filled_avg_price ?? "pending"} [${o.status}]`).join("\n")
    : "No orders executed today";

  const positionSummary = positions.length
    ? positions.map(p => `${p.symbol}: ${p.qty} shares, unrealized P&L $${parseFloat(p.unrealized_pl).toFixed(2)} (${(parseFloat(p.unrealized_plpc) * 100).toFixed(2)}%)`).join("\n")
    : "No open positions";

  // 5. Generate Claude EOD debrief
  let debrief = { grade: "N/A", summary: "No data available.", improvements: [], overnightRisk: "Unknown", tomorrowFocus: "Review open positions" };

  try {
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York",
    });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 800,
        system:     "You are QuantEdge Pro's EOD performance analyst. Be direct, specific, and honest — call out mistakes and praise good decisions. The trader is paper trading and building real skills. No disclaimers, no hedging.",
        messages: [{
          role: "user",
          content: `End-of-day debrief for ${today}.

ACCOUNT SUMMARY:
Portfolio Value: $${parseFloat(account.portfolio_value || 0).toLocaleString()}
Cash Available: $${parseFloat(account.cash || 0).toLocaleString()}
Day P&L: ${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(2)}

TODAY'S ORDERS:
${orderSummary}

OPEN POSITIONS:
${positionSummary}

Grade this trading day and provide honest feedback. What went right, what went wrong, what to fix tomorrow.

Respond ONLY with this JSON (no extra text):
{
  "grade": "A" | "B" | "C" | "D" | "F",
  "dayPnl": "${dayPnl >= 0 ? "+" : ""}$${Math.abs(dayPnl).toFixed(2)}",
  "summary": "2-3 sentence honest performance assessment with specific trade references",
  "wentWell": "what worked today, be specific",
  "improvements": ["specific improvement 1", "specific improvement 2"],
  "bestTrade": "best trade today and why it worked, or N/A",
  "worstTrade": "worst trade or mistake and what to learn, or N/A",
  "overnightRisk": "risk assessment for open positions overnight",
  "tomorrowFocus": "single most important thing to improve or focus on tomorrow"
}`,
        }],
      }),
    });

    const data = await res.json();
    const text = data.content?.[0]?.text || "{}";
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { debrief = JSON.parse(match[0]); } catch {}
    }
    console.log("EOD debrief grade:", debrief.grade);
  } catch (err) {
    console.error("Claude debrief failed:", err.message);
  }

  // 6. Store debrief in Blobs — SAME store as get-briefing reads ("briefings"), key "eod-debrief"
  try {
    const store = blob("briefings");
    await store.setJSON("eod-debrief", {
      debrief,
      generatedAt: new Date().toISOString(),
      date: new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }),
      account: {
        portfolioValue: account.portfolio_value,
        cash:           account.cash,
        equity:         account.equity,
        dayPnl:         dayPnl.toFixed(2),
      },
      ordersCount: orders.length,
    });
    console.log("EOD debrief stored ✓");
  } catch (err) {
    console.error("Blob store failed:", err.message);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, debrief, dayPnl: dayPnl.toFixed(2) }),
  };
};
