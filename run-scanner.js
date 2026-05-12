// netlify/functions/run-scanner.js
// HTTP-callable autonomous trading scanner
// Screens FULL MARKET via Yahoo Finance screener + Polygon data
// Claude analyzes top movers and executes qualifying trades on Alpaca

import { getStore } from "@netlify/blobs";
import webpush from "web-push";

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ── Yahoo Finance screener URLs (free, no key needed) ─────────────────────────
const SCREENER_URLS = [
  // Top gainers
  "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=day_gainers&count=25",
  // Most active by volume
  "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=most_actives&count=25",
  // Top losers (short opportunities)
  "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=day_losers&count=25",
];

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "POST only" }) };

  const now = new Date();
  console.log(`[scanner] Starting full market scan at ${now.toLocaleTimeString("en-US", { timeZone: "America/New_York" })} EST`);

  try {
    // ── STEP 1: Screen full market via Yahoo Finance ──────────────────────────
    const allTickers = new Map(); // symbol → yahoo data

    for (const url of SCREENER_URLS) {
      try {
        const r = await fetch(url, { headers: YAHOO_HEADERS });
        const d = await r.json();
        const quotes = d?.finance?.result?.[0]?.quotes || [];
        quotes.forEach(q => {
          if (q.symbol && q.regularMarketPrice > 2 && q.regularMarketVolume > 100000) {
            allTickers.set(q.symbol, {
              price:      q.regularMarketPrice || 0,
              change:     q.regularMarketChangePercent || 0,
              volume:     q.regularMarketVolume || 0,
              avgVolume:  q.averageDailyVolume3Month || 0,
              high:       q.regularMarketDayHigh || 0,
              low:        q.regularMarketDayLow || 0,
              open:       q.regularMarketOpen || 0,
              prevClose:  q.regularMarketPreviousClose || 0,
              marketCap:  q.marketCap || 0,
              name:       q.shortName || q.symbol,
              peRatio:    q.trailingPE || null,
              sector:     q.sector || "Unknown",
            });
          }
        });
        console.log(`[scanner] Yahoo screener returned ${quotes.length} tickers`);
      } catch (e) {
        console.warn(`[scanner] Yahoo screener failed: ${e.message}`);
      }
    }

    // ── STEP 2: Fetch news headlines via Yahoo Finance RSS ────────────────────
    const newsItems = [];
    try {
      const topSyms = [...allTickers.keys()].slice(0, 8).join(",");
      const rssRes = await fetch(
        `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${topSyms}&region=US&lang=en-US`,
        { headers: YAHOO_HEADERS }
      );
      const rssText = await rssRes.text();
      const titles = [...rssText.matchAll(/<title><!\[CDATA\[(.+?)\]\]><\/title>/g)]
        .map(m => m[1]).slice(1, 12);
      newsItems.push(...titles);
      console.log(`[scanner] Got ${newsItems.length} news headlines`);
    } catch (e) {
      console.warn(`[scanner] News fetch failed: ${e.message}`);
    }

    // ── STEP 3: Fetch StockTwits sentiment for top movers ─────────────────────
    const sentiment = {};
    const topMovers = [...allTickers.entries()]
      .sort((a, b) => Math.abs(b[1].change) - Math.abs(a[1].change))
      .slice(0, 6);

    for (const [sym] of topMovers) {
      try {
        const r = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${sym}.json`);
        const d = await r.json();
        if (d.messages) {
          const bulls = d.messages.filter(m => m.entities?.sentiment?.basic === "Bullish").length;
          const bears = d.messages.filter(m => m.entities?.sentiment?.basic === "Bearish").length;
          const total = bulls + bears;
          sentiment[sym] = {
            bullPct: total > 0 ? Math.round((bulls / total) * 100) : 50,
            msgCount: d.messages.length,
          };
        }
      } catch { sentiment[sym] = { bullPct: 50, msgCount: 0 }; }
    }

    // ── STEP 4: Get Alpaca account state ──────────────────────────────────────
    const alpacaHeaders = {
      "APCA-API-KEY-ID":     process.env.ALPACA_API_KEY,
      "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET,
      "Content-Type":        "application/json",
    };

    let account = { portfolio_value: 100000, cash: 100000 };
    let existingPositions = [];
    try {
      const [accRes, posRes] = await Promise.all([
        fetch("https://paper-api.alpaca.markets/v2/account", { headers: alpacaHeaders }),
        fetch("https://paper-api.alpaca.markets/v2/positions", { headers: alpacaHeaders }),
      ]);
      account = await accRes.json();
      existingPositions = await posRes.json();
    } catch (e) { console.warn("[scanner] Alpaca fetch failed:", e.message); }

    const cash = parseFloat(account.cash || 100000);
    const portfolioValue = parseFloat(account.portfolio_value || 100000);
    const existingSymbols = Array.isArray(existingPositions) ? existingPositions.map(p => p.symbol) : [];

    // ── STEP 5: Build market summary for Claude ───────────────────────────────
    const moverSummary = [...allTickers.entries()]
      .sort((a, b) => Math.abs(b[1].change) - Math.abs(a[1].change))
      .slice(0, 20)
      .map(([sym, d]) => {
        const sent = sentiment[sym] ? ` | Sentiment: ${sentiment[sym].bullPct}% bull` : "";
        const volSpike = d.avgVolume > 0 ? ` | VolSpike: ${(d.volume / d.avgVolume).toFixed(1)}x` : "";
        return `${sym} (${d.name}): $${d.price.toFixed(2)} ${d.change >= 0 ? "+" : ""}${d.change.toFixed(2)}% Vol:${(d.volume / 1e6).toFixed(1)}M${volSpike}${sent}`;
      }).join("\n");

    const newsSummary = newsItems.length
      ? newsItems.map(n => `• ${n}`).join("\n")
      : "No news available";

    const positionSummary = existingPositions.length
      ? existingPositions.map(p =>
          `${p.symbol}: ${p.qty} shares, P&L $${parseFloat(p.unrealized_pl).toFixed(2)}`
        ).join(", ")
      : "None";

    console.log(`[scanner] Analyzing ${allTickers.size} tickers from full market screen`);

    // ── STEP 6: Claude AI trade decisions ─────────────────────────────────────
    let trades = [];
    let marketBias = "NEUTRAL";
    let scanSummary = "";

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-20250514",
        max_tokens: 1200,
        system: `You are QuantEdge Pro's autonomous trading AI. You scan the full market for high-probability setups. You are bold, precise, and focused on finding edge. RULES: Never trade with >40% statistical loss probability. Size positions by confidence. Prefer limit orders for precision, market orders for momentum plays.`,
        messages: [{
          role: "user",
          content: `Time: ${now.toLocaleTimeString("en-US", { timeZone: "America/New_York" })} EST
Portfolio: $${portfolioValue.toLocaleString()} | Cash: $${cash.toLocaleString()}
Current positions: ${positionSummary}
Skip symbols: ${existingSymbols.join(", ") || "none"}

FULL MARKET SCREEN — TOP MOVERS TODAY:
${moverSummary}

LATEST MARKET NEWS:
${newsSummary}

Find the 1-3 BEST trading opportunities from this full market scan.
- Use volume spikes, momentum, news catalysts, and sentiment confluence
- Skip any trade with >40% loss probability
- Position sizing: 90%+ conf = 25% of cash, 75-89% = 15%, 60-74% = 8%
- Limit orders preferred; market orders for strong momentum only

Respond ONLY with this JSON:
{
  "trades": [
    {
      "symbol": "TICKER",
      "side": "buy",
      "orderType": "limit",
      "confidence": 85,
      "lossProbability": 22,
      "cashPercent": 15,
      "limitPrice": 150.50,
      "stopLoss": 147.00,
      "target": 156.00,
      "reasoning": "concise 1-2 sentence rationale",
      "catalysts": ["volume spike 3x avg", "positive news catalyst"],
      "setupType": "Momentum Breakout"
    }
  ],
  "marketBias": "BULLISH",
  "scanSummary": "one sentence overall market read",
  "tickersScanned": ${allTickers.size}
}`
        }],
      }),
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || "{}";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    trades = parsed.trades || [];
    marketBias = parsed.marketBias || "NEUTRAL";
    scanSummary = parsed.scanSummary || "";

    console.log(`[scanner] Claude identified ${trades.length} trade(s). Bias: ${marketBias}. Tickers scanned: ${allTickers.size}`);

    // ── STEP 7: Execute trades on Alpaca ──────────────────────────────────────
    const executedTrades = [];
    for (const trade of trades) {
      if (trade.lossProbability > 40) {
        console.log(`[scanner] SKIPPED ${trade.symbol} — loss prob ${trade.lossProbability}% > 40%`);
        continue;
      }
      if (trade.confidence < 60) {
        console.log(`[scanner] SKIPPED ${trade.symbol} — confidence ${trade.confidence}% too low`);
        continue;
      }

      try {
        const price = allTickers.get(trade.symbol)?.price || trade.limitPrice || 100;
        const qty   = Math.max(1, Math.floor((cash * (trade.cashPercent / 100)) / price));

        const orderBody = {
          symbol:        trade.symbol,
          qty,
          side:          trade.side,
          type:          trade.orderType,
          time_in_force: "day",
        };
        if (trade.orderType === "limit" && trade.limitPrice) {
          orderBody.limit_price = parseFloat(parseFloat(trade.limitPrice).toFixed(2));
        }

        const orderRes = await fetch("https://paper-api.alpaca.markets/v2/orders", {
          method:  "POST",
          headers: alpacaHeaders,
          body:    JSON.stringify(orderBody),
        });
        const order = await orderRes.json();

        if (order.id) {
          const executed = {
            orderId:         order.id,
            symbol:          trade.symbol,
            side:            trade.side,
            qty,
            price,
            orderType:       trade.orderType,
            limitPrice:      trade.limitPrice,
            stopLoss:        trade.stopLoss,
            target:          trade.target,
            confidence:      trade.confidence,
            lossProbability: trade.lossProbability,
            reasoning:       trade.reasoning,
            catalysts:       trade.catalysts,
            setupType:       trade.setupType,
            cashDeployed:    cash * (trade.cashPercent / 100),
            timestamp:       now.toISOString(),
            status:          order.status,
            marketBias,
          };
          executedTrades.push(executed);

          // Log to journal
          try {
            const store = getStore("trade-journal");
            await store.setJSON(`trade-${order.id}`, executed);
          } catch (e) { console.warn("Journal log failed:", e.message); }

          console.log(`[scanner] EXECUTED ${trade.side.toUpperCase()} ${qty} ${trade.symbol} @ $${price.toFixed(2)} (${trade.confidence}% conf, ${trade.lossProbability}% loss prob)`);
        } else {
          console.warn(`[scanner] Order rejected for ${trade.symbol}:`, order.message);
        }
      } catch (e) {
        console.error(`[scanner] Trade error for ${trade.symbol}:`, e.message);
      }
    }

    // ── STEP 8: Push notification for executed trades ─────────────────────────
    const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
    const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

    if (executedTrades.length > 0 && VAPID_PUBLIC && VAPID_PRIVATE) {
      try {
        webpush.setVapidDetails("mailto:quantedge@trading.app", VAPID_PUBLIC, VAPID_PRIVATE);
        const tradeList = executedTrades.map(t =>
          `${t.side.toUpperCase()} ${t.qty} ${t.symbol} @ $${t.price.toFixed(2)} (${t.confidence}% conf)`
        ).join("\n");

        const notification = {
          title: `◈ ${executedTrades.length} Trade${executedTrades.length > 1 ? "s" : ""} Executed`,
          body:  tradeList,
          tag:   "auto-trade",
          data:  { url: "https://glosamabinladen.github.io/quantedge-pro", type: "trade" },
        };

        const subStore = getStore("push-subscriptions");
        const { blobs } = await subStore.list().catch(() => ({ blobs: [] }));
        for (const { key } of blobs) {
          const sub = await subStore.getJSON(key).catch(() => null);
          if (sub?.subscription) {
            await webpush.sendNotification(sub.subscription, JSON.stringify(notification)).catch(() => {});
          }
        }
      } catch (e) { console.warn("Push notifications failed:", e.message); }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success:        true,
        tickersScanned: allTickers.size,
        tradesExecuted: executedTrades.length,
        trades:         executedTrades,
        marketBias,
        scanSummary,
        timestamp:      now.toISOString(),
      }),
    };
  } catch (e) {
    console.error("[scanner] Fatal error:", e);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: e.message, trades: [], tradesExecuted: 0 }),
    };
  }
};
