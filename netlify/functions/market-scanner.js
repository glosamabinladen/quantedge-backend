// netlify/functions/market-scanner.js
// SCHEDULED: every 30 min 9:00AM-4PM EDT Mon-Fri via netlify.toml
// Function enforces the 9:30AM market open gate internally

import { getStore } from "@netlify/blobs";
import webpush from "web-push";

// ── BLOBS (explicit auth required) ───────────────────────────────────────────
const blob = (name) => getStore({
  name,
  siteID: process.env.NETLIFY_SITE_ID,
  token:  process.env.NETLIFY_AUTH_TOKEN,
});

const POLYGON_KEY  = () => process.env.POLYGON_API_KEY;
const ALPACA_KEY   = () => process.env.ALPACA_API_KEY;
const ALPACA_SEC   = () => process.env.ALPACA_API_SECRET;
const CLAUDE_KEY   = () => process.env.ANTHROPIC_API_KEY;
const VAPID_PUBLIC = () => process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE= () => process.env.VAPID_PRIVATE_KEY;

const ALPACA_HEADERS = () => ({
  "APCA-API-KEY-ID":     ALPACA_KEY(),
  "APCA-API-SECRET-KEY": ALPACA_SEC(),
  "Content-Type":        "application/json",
});

// Broad watchlist
const WATCHLIST = [
  "SPY","QQQ","AAPL","NVDA","TSLA","MSFT","META","AMZN","GOOGL","AMD",
  "NFLX","CRM","PLTR","RIVN","SOFI","COIN","MSTR","ARM","SMCI","HOOD",
  "F","GM","UBER","LYFT","SNAP","RBLX","U","SHOP","SQ","PYPL"
];

// ── LOG SCAN EVENT to signal-log store ───────────────────────────────────────
async function logScanEvent(data) {
  try {
    const store = blob("signal-log");
    const key   = `${Date.now()}-SCAN`;
    await store.set(key, JSON.stringify({
      type:      "scan_event",
      timestamp: new Date().toISOString(),
      ...data,
    }));
    console.log("[scanner] Scan event logged:", key);
  } catch (e) {
    console.error("[scanner] logScanEvent failed:", e.message);
  }
}

export const handler = async (event) => {
  const now = new Date();

  // ── Market hours gate ─────────────────────────────────────────────────────
  const etFmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "numeric", hour12: false, timeZone: "America/New_York",
  });
  const [estHour, estMin] = etFmt.format(now).split(":").map(Number);
  const day = now.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" });

  const isWeekday    = !["Sat","Sun"].includes(day);
  // Market opens at 9:30 AM ET, closes at 4:00 PM ET
  const isMarketHours = isWeekday && (
    (estHour === 9 && estMin >= 30) ||
    (estHour >= 10 && estHour < 16)
  );

  if (!isMarketHours) {
    console.log(`[scanner] Outside market hours (${estHour}:${String(estMin).padStart(2,"0")} ET) — skipping`);
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: "outside_market_hours" }) };
  }

  console.log("[scanner] Starting market scan...");

  // 1. Fetch broad market snapshot from Polygon
  let marketData = {};
  try {
    const tickerStr = WATCHLIST.join(",");
    const r = await fetch(
      `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerStr}&apiKey=${POLYGON_KEY()}`
    );
    const d = await r.json();
    if (d.tickers) {
      d.tickers.forEach(t => {
        marketData[t.ticker] = {
          price:      t.day?.c || t.prevDay?.c || 0,
          open:       t.day?.o || 0,
          high:       t.day?.h || 0,
          low:        t.day?.l || 0,
          volume:     t.day?.v || 0,
          vwap:       t.day?.vw || 0,
          changePerc: t.todaysChangePerc || 0,
          prevClose:  t.prevDay?.c || 0,
        };
      });
    }
    console.log(`[scanner] Got data for ${Object.keys(marketData).length} tickers`);
  } catch (e) {
    console.error("[scanner] Polygon snapshot failed:", e.message);
  }

  // 2. Find top movers
  const movers = Object.entries(marketData)
    .filter(([, d]) => d.price > 5 && d.volume > 500000)
    .sort((a, b) => Math.abs(b[1].changePerc) - Math.abs(a[1].changePerc))
    .slice(0, 12);

  // 3. Fetch news for top movers
  const newsItems = [];
  try {
    const rssUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${movers.slice(0,5).map(([s])=>s).join(",")}&region=US&lang=en-US`;
    const rssRes = await fetch(rssUrl, { headers: { "User-Agent": "QuantEdge/1.0" } });
    const rssText = await rssRes.text();
    const titles  = [...rssText.matchAll(/<title><!\[CDATA\[(.+?)\]\]><\/title>/g)].map(m => m[1]).slice(0, 10);
    const links   = [...rssText.matchAll(/<link>(.+?)<\/link>/g)].map(m => m[1]).slice(0, 10);
    titles.forEach((t, i) => newsItems.push({ title: t, url: links[i] || "" }));
  } catch (e) {
    console.warn("[scanner] News fetch failed:", e.message);
  }

  // 4. Fetch StockTwits sentiment
  const sentiment = {};
  for (const [sym] of movers.slice(0, 5)) {
    try {
      const r = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${sym}.json`);
      const d = await r.json();
      if (d.messages) {
        const bulls = d.messages.filter(m => m.entities?.sentiment?.basic === "Bullish").length;
        const bears = d.messages.filter(m => m.entities?.sentiment?.basic === "Bearish").length;
        const total = bulls + bears;
        sentiment[sym] = { bullPct: total > 0 ? Math.round((bulls / total) * 100) : 50, msgCount: d.messages.length };
      }
    } catch (_) {
      sentiment[sym] = { bullPct: 50, msgCount: 0 };
    }
  }

  // 5. Fetch Alpaca account state
  let account = { portfolio_value: 100000, cash: 100000 };
  let existingPositions = [];
  try {
    const [accRes, posRes] = await Promise.all([
      fetch("https://paper-api.alpaca.markets/v2/account",   { headers: ALPACA_HEADERS() }),
      fetch("https://paper-api.alpaca.markets/v2/positions", { headers: ALPACA_HEADERS() }),
    ]);
    account           = await accRes.json();
    existingPositions = await posRes.json();
  } catch (e) {
    console.warn("[scanner] Alpaca account fetch failed:", e.message);
  }

  const cash            = parseFloat(account.cash || 100000);
  const portfolioValue  = parseFloat(account.portfolio_value || 100000);
  const existingSymbols = existingPositions.map(p => p.symbol);

  // 6. Build market summary for Claude
  const moverSummary = movers.map(([sym, d]) => {
    const sent    = sentiment[sym] ? ` | Sentiment: ${sentiment[sym].bullPct}% bullish` : "";
    const rsiNote = d.vwap > 0 ? ` | Price vs VWAP: ${d.price > d.vwap ? "ABOVE" : "BELOW"}` : "";
    return `${sym}: $${d.price.toFixed(2)} (${d.changePerc >= 0 ? "+" : ""}${d.changePerc.toFixed(2)}%) Vol: ${(d.volume/1e6).toFixed(1)}M${rsiNote}${sent}`;
  }).join("\n");

  const newsSummary = newsItems.length
    ? newsItems.map(n => `• ${n.title}`).join("\n")
    : "No news available";

  const positionSummary = existingPositions.length
    ? existingPositions.map(p => `${p.symbol}: ${p.qty} shares, P&L $${parseFloat(p.unrealized_pl).toFixed(2)}`).join(", ")
    : "None";

  // 7. Ask Claude for trade decisions
  let trades     = [];
  let parsedScan = {};
  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         CLAUDE_KEY(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 1200,
        system: `You are QuantEdge Pro's autonomous trading AI. You analyze real market data, news, and sentiment to make precise trading decisions for a paper trading account. You are bold, data-driven, and focused on finding high-probability setups. You never place trades with >40% statistical probability of loss.`,
        messages: [{
          role: "user",
          content: `Current time: ${now.toLocaleTimeString("en-US", { timeZone: "America/New_York" })} EST
Portfolio value: $${portfolioValue.toLocaleString()}
Available cash: $${cash.toLocaleString()}
Current positions: ${positionSummary}

TOP MARKET MOVERS:
${moverSummary}

LATEST NEWS:
${newsSummary}

Based on this data, identify the 1-3 BEST trading opportunities right now. For each trade:
- Confidence must be based on technical + sentiment + news confluence
- Skip any trade with >40% statistical probability of loss
- Position size scales with confidence (90%+ conf = up to 25% of cash, 70-89% = 10-15%, 60-69% = 5%)
- Prefer limit orders; use market orders only for high momentum plays
- Do NOT trade symbols already in positions: ${existingSymbols.join(", ") || "none"}

Respond ONLY with this JSON (no extra text):
{
  "trades": [
    {
      "symbol": "TICKER",
      "side": "buy" or "sell",
      "orderType": "limit" or "market",
      "confidence": 0-100,
      "lossProbability": 0-100,
      "cashPercent": 5-25,
      "limitPrice": null or number,
      "stopLoss": number,
      "target": number,
      "reasoning": "concise 1-2 sentence rationale",
      "catalysts": ["news/sentiment/technical factor 1", "factor 2"],
      "setupType": "pattern name e.g. Momentum Breakout, VWAP Reclaim, RSI Oversold"
    }
  ],
  "marketBias": "BULLISH" or "BEARISH" or "NEUTRAL",
  "scanSummary": "1 sentence overall market read",
  "skippedReasons": ["any high-probability setups skipped and why"]
}`,
        }],
      }),
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || "{}";
    parsedScan = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    trades     = parsedScan.trades || [];

    // Store scan result
    const scanStore = blob("scan-results");
    const scanKey   = `scan-${now.toISOString().replace(/[:.]/g, "-")}`;
    await scanStore.set(scanKey, JSON.stringify({
      timestamp:     now.toISOString(),
      marketBias:    parsedScan.marketBias,
      scanSummary:   parsedScan.scanSummary,
      movers:        movers.map(([s, d]) => ({ symbol: s, ...d })),
      tradesPlanned: trades.length,
      skippedReasons: parsedScan.skippedReasons || [],
    }));

    // Log scan event to signal-log so journal AUTO tab can display it
    await logScanEvent({
      marketBias:   parsedScan.marketBias,
      scanSummary:  parsedScan.scanSummary,
      moverCount:   movers.length,
      tradesPlanned: trades.length,
      topMovers:    movers.slice(0, 5).map(([s]) => s),
    });

    console.log(`[scanner] Claude identified ${trades.length} trade(s). Bias: ${parsedScan.marketBias}`);
  } catch (e) {
    console.error("[scanner] Claude analysis failed:", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }

  // 8. Execute trades on Alpaca
  const executedTrades = [];
  for (const trade of trades) {
    if (trade.lossProbability > 40) {
      console.log(`[scanner] SKIPPED ${trade.symbol} — loss probability ${trade.lossProbability}% > 40%`);
      continue;
    }
    if (trade.confidence < 60) {
      console.log(`[scanner] SKIPPED ${trade.symbol} — confidence ${trade.confidence}% below threshold`);
      continue;
    }

    try {
      const tradeAmt = cash * (trade.cashPercent / 100);
      const price    = marketData[trade.symbol]?.price || trade.limitPrice || 100;
      const qty      = Math.max(1, Math.floor(tradeAmt / price));

      const orderBody = {
        symbol:        trade.symbol,
        qty,
        side:          trade.side,
        type:          trade.orderType,
        time_in_force: "day",
      };

      if (trade.orderType === "limit" && trade.limitPrice) {
        orderBody.limit_price = parseFloat(trade.limitPrice.toFixed(2));
      }

      const orderRes = await fetch("https://paper-api.alpaca.markets/v2/orders", {
        method:  "POST",
        headers: ALPACA_HEADERS(),
        body:    JSON.stringify(orderBody),
      });
      const order = await orderRes.json();

      if (order.id) {
        const executed = {
          orderId:         order.id,
          symbol:          trade.symbol,
          side:            trade.side,
          qty,
          orderType:       trade.orderType,
          price,
          limitPrice:      trade.limitPrice,
          stopLoss:        trade.stopLoss,
          target:          trade.target,
          confidence:      trade.confidence,
          lossProbability: trade.lossProbability,
          reasoning:       trade.reasoning,
          catalysts:       trade.catalysts,
          setupType:       trade.setupType,
          cashDeployed:    tradeAmt,
          timestamp:       new Date().toISOString(),
          status:          order.status,
        };
        executedTrades.push(executed);

        // Log to trade-journal store
        const journalStore = blob("trade-journal");
        await journalStore.set(`trade-${order.id}`, JSON.stringify(executed));

        // Log to signal-log store
        const signalStore = blob("signal-log");
        await signalStore.set(`${Date.now()}-${trade.symbol}`, JSON.stringify({
          type:      "trade",
          timestamp: new Date().toISOString(),
          ...executed,
        }));

        console.log(`[scanner] EXECUTED ${trade.side.toUpperCase()} ${qty} ${trade.symbol} @ $${price.toFixed(2)} (${trade.confidence}% conf)`);
      } else {
        console.warn(`[scanner] Order failed for ${trade.symbol}:`, order.message);
      }
    } catch (e) {
      console.error(`[scanner] Trade execution error for ${trade.symbol}:`, e.message);
    }
  }

  // 9. Push notifications for executed trades
  if (executedTrades.length > 0 && VAPID_PUBLIC() && VAPID_PRIVATE()) {
    webpush.setVapidDetails("mailto:quantedge@trading.app", VAPID_PUBLIC(), VAPID_PRIVATE());
    const tradeList = executedTrades.map(t =>
      `${t.side.toUpperCase()} ${t.qty} ${t.symbol} @ $${t.price.toFixed(2)} (${t.confidence}% conf)`
    ).join("\n");

    try {
      const subStore = blob("push-subscriptions");
      const { blobs } = await subStore.list();
      for (const { key } of blobs) {
        const sub = await subStore.getJSON(key).catch(() => null);
        if (sub?.subscription) {
          await webpush.sendNotification(sub.subscription, JSON.stringify({
            title: `◈ ${executedTrades.length} Trade${executedTrades.length > 1 ? "s" : ""} Executed`,
            body:  tradeList,
            tag:   "auto-trade",
            data:  { url: "https://glosamabinladen.github.io/quantedge-pro", type: "trade" },
          })).catch(() => {});
        }
      }
    } catch (e) {
      console.warn("[scanner] Push notification failed:", e.message);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success:        true,
      scanned:        Object.keys(marketData).length,
      tradesExecuted: executedTrades.length,
      trades:         executedTrades,
    }),
  };
};
