// netlify/functions/eod-debrief.js
// SCHEDULED: 4:00 PM EST (21:00 UTC) — Monday through Friday
// Pulls EOD portfolio data, grades the day, stores in Blobs, pushes notification

import { getStore } from "@netlify/blobs";
import webpush from "web-push";

export const handler = async () => {
  const ALPACA_KEY    = process.env.ALPACA_API_KEY;
  const ALPACA_SEC    = process.env.ALPACA_API_SECRET;
  const CLAUDE_KEY    = process.env.ANTHROPIC_API_KEY;
  const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

  if (!ALPACA_KEY || !CLAUDE_KEY) {
    console.error("Missing API keys");
    return { statusCode: 500, body: "Missing API keys" };
  }

  console.log("🌆 QuantEdge EOD Debrief starting...");

  const alpacaHeaders = {
    "APCA-API-KEY-ID":     ALPACA_KEY,
    "APCA-API-SECRET-KEY": ALPACA_SEC,
    "Content-Type":        "application/json",
  };

  // 1. Pull account snapshot
  let account = {};
  try {
    const r = await fetch("https://paper-api.alpaca.markets/v2/account", { headers: alpacaHeaders });
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
      { headers: alpacaHeaders }
    );
    orders = await r.json();
  } catch (err) {
    console.error("Alpaca orders fetch failed:", err.message);
  }

  // 3. Pull open positions
  let positions = [];
  try {
    const r = await fetch("https://paper-api.alpaca.markets/v2/positions", { headers: alpacaHeaders });
    positions = await r.json();
  } catch (err) {
    console.error("Alpaca positions fetch failed:", err.message);
  }

  // 4. Generate Claude EOD debrief
  let debrief = { grade: "N/A", summary: "", improvements: [], overnightRisk: "", tomorrowFocus: "" };

  const orderSummary = orders.length
    ? orders.map((o) => `${o.symbol} ${o.side.toUpperCase()} ${o.qty} @ $${o.filled_avg_price ?? "pending"} [${o.status}]`).join("\n")
    : "No orders today";

  const positionSummary = positions.length
    ? positions.map((p) =>
        `${p.symbol}: ${p.qty} shares, P&L $${Number(p.unrealized_pl).toFixed(2)} (${(p.unrealized_plpc * 100).toFixed(2)}%)`
      ).join("\n")
    : "No open positions";

  try {
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York",
    });

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        system: "You are QuantEdge Pro's EOD performance analyst. Be direct and honest — praise what worked, call out what didn't. The trader is paper trading and building real money skills. No disclaimers.",
        messages: [{
          role: "user",
          content: `Generate an end-of-day debrief for ${today}.

ACCOUNT:
Portfolio Value: $${Number(account.portfolio_value || 0).toLocaleString()}
Cash: $${Number(account.cash || 0).toLocaleString()}
Day P&L: $${Number(account.equity || 0) - Number(account.last_equity || 0) > 0 ? "+" : ""}${(Number(account.equity || 0) - Number(account.last_equity || 0)).toFixed(2)}

TODAY'S ORDERS:
${orderSummary}

OPEN POSITIONS:
${positionSummary}

Respond ONLY with this JSON (no extra text):
{
  "grade": "A" or "B" or "C" or "D" or "F",
  "summary": "<2-3 sentence honest performance read>",
  "wentWell": "<what worked today, 1 sentence>",
  "improvements": ["<improvement 1>", "<improvement 2>"],
  "overnightRisk": "<risk assessment for open positions, 1 sentence>",
  "tomorrowFocus": "<single most important thing to focus on tomorrow>",
  "dayPnl": "<formatted P&L string e.g. +$142.50>"
}`,
        }],
      }),
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || "{}";
    try {
      debrief = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    } catch {
      debrief.summary = text;
    }
  } catch (err) {
    console.error("Claude debrief failed:", err.message);
    debrief.summary = "EOD data loaded. Review your trades in the journal.";
  }

  // 5. Store debrief in Netlify Blobs
  try {
    const store = getStore("daily-briefings");
    const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }).replace(/\//g, "-");
    await store.setJSON(`eod-${today}`, {
      type: "eod",
      date: today,
      generatedAt: new Date().toISOString(),
      debrief,
      account: {
        portfolioValue: account.portfolio_value,
        cash: account.cash,
        equity: account.equity,
      },
      ordersCount: orders.length,
      positions: positionSummary,
    });
    console.log("✅ EOD debrief stored");
  } catch (err) {
    console.error("Blob store failed:", err.message);
  }

  // 6. Push notification to all devices
  if (VAPID_PUBLIC && VAPID_PRIVATE) {
    webpush.setVapidDetails("mailto:quantedge@trading.app", VAPID_PUBLIC, VAPID_PRIVATE);

    const gradeEmoji = { A: "🏆", B: "✅", C: "⚠️", D: "📉", F: "🚨" }[debrief.grade] ?? "📊";

    const notification = {
      title: `${gradeEmoji} EOD Debrief — Grade: ${debrief.grade}`,
      body: debrief.summary || "Market closed. Review your journal.",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      tag: "eod-debrief",
      data: {
        url: "https://glosamabinladen.github.io/quantedge-pro/journal.html",
        type: "eod",
        grade: debrief.grade,
        timestamp: new Date().toISOString(),
      },
      actions: [
        { action: "journal", title: "Open Journal" },
        { action: "open",    title: "Open Terminal" },
      ],
    };

    try {
      const subStore = getStore("push-subscriptions");
      const { blobs } = await subStore.list();
      let sent = 0;
      for (const { key } of blobs) {
        try {
          const sub = await subStore.getJSON(key);
          if (sub?.subscription) {
            await webpush.sendNotification(sub.subscription, JSON.stringify(notification));
            sent++;
          }
        } catch (err) {
          if (err.statusCode === 410) {
            await subStore.delete(key);
            console.log(`Removed expired subscription: ${key}`);
          }
        }
      }
      console.log(`✅ EOD push sent to ${sent} device(s)`);
    } catch (err) {
      console.error("Push batch failed:", err.message);
    }
  } else {
    console.log("⚠️ VAPID keys not set — skipping push notifications");
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, debrief, message: "EOD debrief complete" }),
  };
};
