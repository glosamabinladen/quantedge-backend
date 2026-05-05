// netlify/functions/morning-briefing.js
// SCHEDULED: 9:00 AM EST (14:00 UTC) — Monday through Friday
// Pulls pre-market data, generates Claude AI briefing, pushes to all devices

import { getStore } from "@netlify/blobs";
import webpush from "web-push";

const WATCHLIST = ["SPY", "NVDA", "TSLA", "AAPL", "MSFT", "META", "QQQ", "AMD"];

export const handler = async () => {
  const POLYGON_KEY = process.env.POLYGON_API_KEY;
  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
  const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

  if (!POLYGON_KEY || !CLAUDE_KEY) {
    console.error("Missing API keys");
    return { statusCode: 500, body: "Missing API keys" };
  }

  console.log("🌅 QuantEdge Morning Briefing starting...");

  // 1. Fetch pre-market snapshot for watchlist
  let marketData = {};
  try {
    const tickerList = WATCHLIST.join(",");
    const snapRes = await fetch(
      `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerList}&apiKey=${POLYGON_KEY}`
    );
    const snapData = await snapRes.json();
    
    if (snapData.tickers) {
      snapData.tickers.forEach((t) => {
        marketData[t.ticker] = {
          price: t.day?.c || t.prevDay?.c || 0,
          prevClose: t.prevDay?.c || 0,
          changePercent: t.todaysChangePerc || 0,
          volume: t.day?.v || 0,
          high: t.day?.h || 0,
          low: t.day?.l || 0,
          vwap: t.day?.vw || 0,
        };
      });
    }
  } catch (err) {
    console.error("Polygon fetch failed:", err.message);
  }

  // 2. Fetch yesterday's overall market performance
  let yesterdayNote = "";
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    // Skip weekends
    while (yesterday.getDay() === 0 || yesterday.getDay() === 6) {
      yesterday.setDate(yesterday.getDate() - 1);
    }
    const dateStr = yesterday.toISOString().split("T")[0];
    const spyRes = await fetch(
      `https://api.polygon.io/v1/open-close/SPY/${dateStr}?adjusted=true&apiKey=${POLYGON_KEY}`
    );
    const spyData = await spyRes.json();
    if (spyData.close) {
      const change = ((spyData.close - spyData.open) / spyData.open * 100).toFixed(2);
      yesterdayNote = `Yesterday SPY: Open $${spyData.open}, Close $${spyData.close} (${change > 0 ? "+" : ""}${change}%)`;
    }
  } catch (err) {
    console.log("Yesterday data unavailable");
  }

  // 3. Generate AI Morning Briefing via Claude
  let briefing = { summary: "", topPicks: [], risks: [], bias: "NEUTRAL" };
  try {
    const marketSummary = Object.entries(marketData)
      .map(([t, d]) => `${t}: $${d.price?.toFixed(2)} (${d.changePercent >= 0 ? "+" : ""}${d.changePercent?.toFixed(2)}%)`)
      .join(", ");

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        system: "You are QuantEdge Pro's morning market analyst. Deliver sharp, actionable pre-market briefings for a retail trader doing paper trading. Be direct and money-focused. No disclaimers.",
        messages: [{
          role: "user",
          content: `Generate a morning briefing for today's trading session.

PRE-MARKET DATA:
${marketSummary}
${yesterdayNote}

Respond ONLY with this JSON (no extra text):
{
  "bias": "BULLISH" or "BEARISH" or "NEUTRAL",
  "summary": "<2-3 sentence overall market read for today>",
  "topPicks": [
    {"ticker": "SYMBOL", "direction": "LONG" or "SHORT", "reason": "<1 sentence why>", "keyLevel": <price>},
    {"ticker": "SYMBOL", "direction": "LONG" or "SHORT", "reason": "<1 sentence why>", "keyLevel": <price>}
  ],
  "risks": ["<risk 1>", "<risk 2>"],
  "focusTime": "<best time window to trade today e.g. 9:45-10:30 AM EST>",
  "mantra": "<one sharp trading mantra for the day>"
}`
        }],
      }),
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || "{}";
    try {
      briefing = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    } catch {
      briefing.summary = text;
    }
  } catch (err) {
    console.error("Claude briefing failed:", err.message);
    briefing.summary = "Market data loaded. Check terminal for pre-market conditions.";
  }

  // 4. Store briefing in Netlify Blobs
  try {
    const store = getStore("daily-briefings");
    const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }).replace(/\//g, "-");
    await store.setJSON(`morning-${today}`, {
      type: "morning",
      date: today,
      generatedAt: new Date().toISOString(),
      briefing,
      marketData,
    });
    console.log("✅ Morning briefing stored");
  } catch (err) {
    console.error("Store failed:", err.message);
  }

  // 5. Send push notifications to all subscribed devices
  if (VAPID_PUBLIC && VAPID_PRIVATE) {
    webpush.setVapidDetails(
      "mailto:quantedge@trading.app",
      VAPID_PUBLIC,
      VAPID_PRIVATE
    );

    const biasEmoji = briefing.bias === "BULLISH" ? "📈" : briefing.bias === "BEARISH" ? "📉" : "➡️";
    const topPick = briefing.topPicks?.[0];
    
    const notification = {
      title: `${biasEmoji} QuantEdge Morning Briefing`,
      body: briefing.summary || "Market open in 30 minutes. Check your terminal.",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      tag: "morning-briefing",
      data: {
        url: "https://glosamabinladen.github.io/quantedge-pro",
        type: "morning",
        bias: briefing.bias,
        topPick: topPick?.ticker,
        timestamp: new Date().toISOString(),
      },
      actions: [
        { action: "open", title: "Open Terminal" },
        { action: "journal", title: "Open Journal" },
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
          // Subscription expired — remove it
          if (err.statusCode === 410) {
            await subStore.delete(key);
            console.log(`Removed expired subscription: ${key}`);
          }
        }
      }
      console.log(`✅ Push notifications sent to ${sent} device(s)`);
    } catch (err) {
      console.error("Push notification batch failed:", err.message);
    }
  } else {
    console.log("⚠️ VAPID keys not set — skipping push notifications");
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ 
      success: true, 
      briefing,
      message: "Morning briefing complete" 
    }),
  };
};
