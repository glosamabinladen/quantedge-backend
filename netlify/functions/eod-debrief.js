// netlify/functions/eod-debrief.js
// SCHEDULED: 4:00 PM EST (21:00 UTC) — Monday through Friday
// Pulls today's signals from log, generates EOD debrief via Claude, pushes to devices

import { getStore } from "@netlify/blobs";
import webpush from "web-push";

export const handler = async () => {
  const POLYGON_KEY = process.env.POLYGON_API_KEY;
  const ALPACA_KEY = process.env.ALPACA_API_KEY;
  const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;
  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
  const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

  console.log("🌆 QuantEdge EOD Debrief starting...");

  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }).replace(/\//g, "-");

  // 1. Pull today's signals from signal-log store
  let todaySignals = [];
  try {
    const signalStore = getStore("signal-log");
    const dateKey = `daily-${today}`;
    let daily;
    try {
      daily = await signalStore.getJSON(dateKey);
    } catch {
      daily = null;
    }
    
    if (daily?.signals?.length) {
      const fetched = await Promise.all(
        daily.signals.map(async (id) => {
          try { return await signalStore.getJSON(id); } catch { return null; }
        })
      );
      todaySignals = fetched.filter(Boolean);
    }
  } catch (err) {
    console.error("Signal fetch failed:", err.message);
  }

  // 2. Pull Alpaca portfolio performance
  let portfolioData = { equity: 0, pnl: 0, pnlPercent: 0 };
  if (ALPACA_KEY && ALPACA_SECRET) {
    try {
      const [accountRes, historyRes] = await Promise.all([
        fetch("https://paper-api.alpaca.markets/v2/account", {
          headers: {
            "APCA-API-KEY-ID": ALPACA_KEY,
            "APCA-API-SECRET-KEY": ALPACA_SECRET,
          },
        }),
        fetch("https://paper-api.alpaca.markets/v2/portfolio/history?period=1D&timeframe=1H", {
          headers: {
            "APCA-API-KEY-ID": ALPACA_KEY,
            "APCA-API-SECRET-KEY": ALPACA_SECRET,
          },
        }),
      ]);

      const account = await accountRes.json();
      const history = await historyRes.json();

      portfolioData.equity = parseFloat(account.equity) || 0;
      portfolioData.cash = parseFloat(account.cash) || 0;
      
      if (history.profit_loss_pct) {
        const pcts = history.profit_loss_pct;
        portfolioData.pnlPercent = (pcts[pcts.length - 1] * 100).toFixed(2);
      }
      if (history.profit_loss) {
        const pnls = history.profit_loss;
        portfolioData.pnl = pnls[pnls.length - 1]?.toFixed(2) || 0;
      }
    } catch (err) {
      console.error("Alpaca fetch failed:", err.message);
    }
  }

  // 3. Pull SPY EOD data for context
  let spyEOD = null;
  if (POLYGON_KEY) {
    try {
      const todayFormatted = new Date().toISOString().split("T")[0];
      const res = await fetch(
        `https://api.polygon.io/v1/open-close/SPY/${todayFormatted}?adjusted=true&apiKey=${POLYGON_KEY}`
      );
      spyEOD = await res.json();
    } catch (err) {
      console.log("SPY EOD data unavailable");
    }
  }

  // 4. Generate EOD debrief via Claude
  let debrief = { grade: "B", summary: "", lessons: [], tomorrowSetups: [], psychNote: "" };
  try {
    const signalSummary = todaySignals.length
      ? todaySignals.map(s => 
          `${s.ticker} ${s.action} @ $${s.price} | Confidence: ${s.confidence}% | Setup: ${s.setupType}`
        ).join("\n")
      : "No signals logged today";

    const spyNote = spyEOD?.close
      ? `SPY: Open $${spyEOD.open} → Close $${spyEOD.close} (${((spyEOD.close - spyEOD.open) / spyEOD.open * 100).toFixed(2)}%)`
      : "SPY data unavailable";

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
        system: "You are QuantEdge Pro's EOD performance coach. Review the day's trading activity and deliver a sharp, honest debrief to help the trader grow. Be direct and constructive.",
        messages: [{
          role: "user",
          content: `Generate an EOD trading debrief.

TODAY'S SIGNALS:
${signalSummary}

MARKET PERFORMANCE:
${spyNote}

PORTFOLIO:
Equity: $${portfolioData.equity}
Today P&L: $${portfolioData.pnl} (${portfolioData.pnlPercent}%)

Respond ONLY with this JSON:
{
  "grade": "A+" or "A" or "B+" or "B" or "C" or "D" or "N/A",
  "summary": "<2-3 sentence honest day assessment>",
  "lessons": ["<lesson 1>", "<lesson 2>"],
  "tomorrowSetups": [
    {"ticker": "SYMBOL", "watchFor": "<what to look for tomorrow>", "direction": "LONG or SHORT"}
  ],
  "psychNote": "<1 sentence mental game coaching tip for tomorrow>",
  "signalCount": ${todaySignals.length},
  "dayType": "TRENDING" or "CHOPPY" or "LOW_VOLUME" or "HIGH_VOLATILITY" or "UNKNOWN"
}`
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
    debrief.summary = `Day complete. ${todaySignals.length} signals logged. Check journal for review.`;
  }

  // 5. Store EOD debrief
  try {
    const store = getStore("daily-briefings");
    await store.setJSON(`eod-${today}`, {
      type: "eod",
      date: today,
      generatedAt: new Date().toISOString(),
      debrief,
      portfolioData,
      signalCount: todaySignals.length,
      spyEOD,
    });
    console.log("✅ EOD debrief stored");
  } catch (err) {
    console.error("Store failed:", err.message);
  }

  // 6. Send push notifications
  if (VAPID_PUBLIC && VAPID_PRIVATE) {
    webpush.setVapidDetails(
      "mailto:quantedge@trading.app",
      VAPID_PUBLIC,
      VAPID_PRIVATE
    );

    const gradeEmoji = { "A+": "🏆", "A": "🌟", "B+": "✅", "B": "👍", "C": "⚠️", "D": "🔴", "N/A": "📋" };
    const emoji = gradeEmoji[debrief.grade] || "📊";
    const pnlStr = portfolioData.pnl >= 0 ? `+$${portfolioData.pnl}` : `-$${Math.abs(portfolioData.pnl)}`;

    const notification = {
      title: `${emoji} EOD Debrief — Grade: ${debrief.grade}`,
      body: `${debrief.summary || "Day complete."} P&L: ${pnlStr} | ${todaySignals.length} signals logged.`,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      tag: "eod-debrief",
      data: {
        url: "https://glosamabinladen.github.io/quantedge-pro/journal.html",
        type: "eod",
        grade: debrief.grade,
        pnl: portfolioData.pnl,
        timestamp: new Date().toISOString(),
      },
      actions: [
        { action: "journal", title: "Open Journal" },
        { action: "open", title: "Open Terminal" },
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
          }
        }
      }
      console.log(`✅ EOD push sent to ${sent} device(s)`);
    } catch (err) {
      console.error("Push batch failed:", err.message);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, debrief, signalCount: todaySignals.length }),
  };
};
