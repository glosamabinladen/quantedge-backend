// netlify/functions/market-scanner.js
// Scheduled: every 30 min 9:00AM–4:30PM EDT (13:00–20:30 UTC) Mon–Fri
// Function itself enforces 9:30AM–4:00PM market hours window
// Every run — executed, gated, or skipped — is logged to signal-log for the AUTO tab

import { getStore } from "@netlify/blobs";

const blob = (name) => getStore({
  name,
  siteID: process.env.NETLIFY_SITE_ID,
  token:  process.env.NETLIFY_AUTH_TOKEN,
});

const POLYGON_KEY  = process.env.POLYGON_API_KEY;
const ALPACA_KEY   = process.env.ALPACA_API_KEY;
const ALPACA_SEC   = process.env.ALPACA_API_SECRET;
const CLAUDE_KEY   = process.env.ANTHROPIC_API_KEY;

const ALPACA_HEADERS = {
  "APCA-API-KEY-ID":     ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SEC,
  "Content-Type":        "application/json",
};

const WATCHLIST = [
  "SPY","QQQ","AAPL","NVDA","TSLA","MSFT","META","AMZN","GOOGL","AMD",
  "NFLX","PLTR","COIN","MSTR","ARM","SMCI","HOOD","SQ","PYPL","SHOP",
  "RIVN","SOFI","UBER","SNAP","RBLX","CRM","NOW","PANW","CRWD","NET"
];

const MAX_POSITION_SIZE_PCT = 0.20;
const MIN_CONFIDENCE        = 65;
const MAX_LOSS_PROB         = 38;
const MIN_RISK_REWARD       = 1.5;
const MAX_POSITIONS         = 5;

// ── Helpers ──────────────────────────────────────────────
function nowEST(d = new Date()) {
  return d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
}

async function logScanEvent(payload) {
  try {
    const store = blob("signal-log");
    const key = `scan-event-${Date.now()}`;
    await store.setJSON(key, {
      type:      "scan_event",
      source:    "auto",
      automated: true,
      ...payload,
      timestamp: payload.timestamp || new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[scanner] logScanEvent failed:", e.message);
  }
}

// ─────────────────────────────────────────────────────────
export const handler = async (event) => {
  const now = new Date();
  const timestamp = now.toISOString();

  const estHour = parseInt(new Intl.DateTimeFormat("en-US", {
    hour: "numeric", hour12: false, timeZone: "America/New_York",
  }).format(now));
  // Use actual ET minute
  const etMinStr = new Intl.DateTimeFormat("en-US", {
    minute: "numeric", timeZone: "America/New_York",
  }).format(now);
  const estMin = parseInt(etMinStr);

  const day = now.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" });
  const isWeekday    = !["Sat", "Sun"].includes(day);
  const isMarketOpen = isWeekday && (
    (estHour === 9 && estMin >= 30) ||
    (estHour >= 10 && estHour < 16)
  );

  const isManual = event.httpMethod === "GET" || event.httpMethod === "POST";

  // Outside market hours — log it so users see the scanner fired
  if (!isManual && !isMarketOpen) {
    console.log("[scanner] Outside market hours — skipping");
    await logScanEvent({
      timestamp,
      scanTime:       nowEST(now),
      skipped:        true,
      skipReason:     "Outside market hours",
      tickersScanned: 0,
      setupsFound:    0,
      tradesExecuted: 0,
      marketBias:     "N/A",
      scanSummary:    "Scanner fired but market is closed.",
    });
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: "outside market hours" }) };
  }

  console.log(`[scanner] Starting scan — ${nowEST(now)} ET`);

  if (!POLYGON_KEY || !ALPACA_KEY || !CLAUDE_KEY) {
    console.error("[scanner] Missing API keys");
    await logScanEvent({
      timestamp, scanTime: nowEST(now), skipped: true,
      skipReason: "Missing API keys (POLYGON, ALPACA, or ANTHROPIC)",
      tickersScanned: 0, setupsFound: 0, tradesExecuted: 0, marketBias: "N/A",
      scanSummary: "Scanner cannot run — one or more API keys are missing.",
    });
    return { statusCode: 500, body: JSON.stringify({ error: "Missing API keys" }) };
  }

  // ── 1. FETCH MARKET DATA ─────────────────────────────────
  let marketData = {};
  try {
    const tickerStr = WATCHLIST.join(",");
    const r = await fetch(
      `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerStr}&apiKey=${POLYGON_KEY}`,
      { headers: { "User-Agent": "QuantEdge/2.0" } }
    );
    const d = await r.json();
    if (d.tickers) {
      d.tickers.forEach(t => {
        const day  = t.day || {};
        const prev = t.prevDay || {};
        const price = t.lastTrade?.p || day.c || prev.c || 0;
        const vwap  = day.vw || 0;
        const vol   = day.v || 0;
        const prevClose = prev.c || price;
        if (price > 5) {
          const change = price - prevClose;
          const approxRsi = prevClose > 0
            ? Math.min(100, Math.max(0, 50 + (change / prevClose) * 500))
            : 50;
          marketData[t.ticker] = {
            price, open: day.o || prevClose, high: day.h || price,
            low: day.l || price, close: day.c || price, prevClose,
            volume: vol, vwap, changePerc: t.todaysChangePerc || 0,
            approxRsi, vwapBias: vwap > 0 ? (price > vwap ? "ABOVE" : "BELOW") : "N/A",
          };
        }
      });
    }
    console.log(`[scanner] Got data for ${Object.keys(marketData).length} tickers`);
  } catch (e) {
    console.error("[scanner] Polygon snapshot failed:", e.message);
    await logScanEvent({
      timestamp, scanTime: nowEST(now), skipped: true,
      skipReason: `Market data fetch failed: ${e.message}`,
      tickersScanned: 0, setupsFound: 0, tradesExecuted: 0, marketBias: "N/A",
      scanSummary: "Polygon API error prevented market scan.",
    });
    return { statusCode: 500, body: JSON.stringify({ error: "Market data fetch failed" }) };
  }

  // ── 2. SCORE MOVERS ──────────────────────────────────────
  const scored = Object.entries(marketData)
    .filter(([, d]) => d.volume > 300000 && d.price > 5)
    .map(([sym, d]) => {
      let score = 0;
      if (d.volume > 1e6)              score += 20;
      if (d.volume > 3e6)              score += 10;
      if (d.approxRsi < 35)            score += 15;
      if (d.approxRsi > 68)            score += 10;
      if (Math.abs(d.changePerc) > 3)  score += 15;
      if (Math.abs(d.changePerc) > 6)  score += 10;
      if (d.vwap > 0 && Math.abs(d.price - d.vwap) / d.vwap < 0.002) score += 10;
      return { sym, score, ...d };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  // ── 3. ALPACA ACCOUNT STATE ──────────────────────────────
  let account   = { portfolio_value: 100000, cash: 100000, equity: 100000 };
  let positions = [];
  try {
    const [accRes, posRes] = await Promise.all([
      fetch("https://paper-api.alpaca.markets/v2/account",   { headers: ALPACA_HEADERS }),
      fetch("https://paper-api.alpaca.markets/v2/positions", { headers: ALPACA_HEADERS }),
    ]);
    account   = await accRes.json();
    positions = await posRes.json();
    if (!Array.isArray(positions)) positions = [];
    console.log(`[scanner] Account: $${account.portfolio_value} | ${positions.length} positions`);
  } catch (e) {
    console.warn("[scanner] Alpaca fetch failed:", e.message);
  }

  const cash           = parseFloat(account.cash || 100000);
  const portfolioValue = parseFloat(account.portfolio_value || 100000);
  const existingSymbols = positions.map(p => p.symbol);

  // Max positions gate
  if (positions.length >= MAX_POSITIONS) {
    console.log(`[scanner] ${positions.length} positions — at max. Skipping new entries.`);
    await logScanEvent({
      timestamp, scanTime: nowEST(now), skipped: true,
      skipReason: `At max positions (${positions.length}/${MAX_POSITIONS})`,
      tickersScanned: Object.keys(marketData).length,
      setupsFound: 0, tradesExecuted: 0, marketBias: "N/A",
      portfolioValue: portfolioValue,
      openPositions: existingSymbols,
      scanSummary: `Portfolio is fully invested with ${positions.length} open positions. Waiting for exits before new entries.`,
    });
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: "max positions reached", positions: positions.length }) };
  }

  // ── 4. AUTO STOP-LOSSES ──────────────────────────────────
  for (const pos of positions) {
    const unrealizedPct = parseFloat(pos.unrealized_plpc) * 100;
    if (unrealizedPct < -5) {
      try {
        await fetch(`https://paper-api.alpaca.markets/v2/positions/${pos.symbol}`, {
          method: "DELETE", headers: ALPACA_HEADERS,
        });
        console.log(`[scanner] STOP-LOSS closed ${pos.symbol} at ${unrealizedPct.toFixed(1)}%`);
        const store = blob("trade-journal");
        const tradeKey = `close-${pos.symbol}-${Date.now()}`;
        await store.setJSON(tradeKey, {
          symbol:      pos.symbol,
          side:        "sell",
          qty:         parseFloat(pos.qty),
          price:       parseFloat(pos.current_price),
          realizedPnl: parseFloat(pos.unrealized_pl),
          reasoning:   `Auto stop-loss triggered at ${unrealizedPct.toFixed(1)}% loss`,
          setupType:   "Stop Loss",
          source:      "auto",
          automated:   true,
          timestamp,
        });
      } catch (e) {
        console.error(`[scanner] Stop-loss close failed for ${pos.symbol}:`, e.message);
      }
    }
  }

  // ── 5. CLAUDE ANALYSIS ──────────────────────────────────
  const moverSummary = scored.slice(0, 12).map(d => {
    const rsiLabel = d.approxRsi < 35 ? " [OVERSOLD]" : d.approxRsi > 68 ? " [OVERBOUGHT]" : "";
    return `${d.sym}: $${d.price.toFixed(2)} (${d.changePerc >= 0 ? "+" : ""}${d.changePerc.toFixed(2)}%) | Vol:${(d.volume/1e6).toFixed(1)}M | RSI~${d.approxRsi.toFixed(0)} | VWAP:${d.vwapBias}${rsiLabel}`;
  }).join("\n");

  const posSummary = positions.length
    ? positions.map(p => `${p.symbol}: ${p.qty}sh, P&L $${parseFloat(p.unrealized_pl).toFixed(2)} (${(parseFloat(p.unrealized_plpc)*100).toFixed(1)}%)`).join(" | ")
    : "None";

  let plannedTrades = [];
  let scanMeta = { marketBias: "NEUTRAL", scanSummary: "Analysis incomplete.", skipped: [] };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 1500,
        system: `You are QuantEdge Pro's autonomous trading AI. You analyze live market data and make precise trading decisions for a paper account. You are bold, data-driven, and focused on high-probability setups with favorable risk:reward. You enforce strict risk management: minimum 1.5:1 R:R, maximum 20% of cash per trade. You never chase momentum without technical justification.`,
        messages: [{
          role: "user",
          content: `SCAN TIME: ${nowEST(now)} ET
PORTFOLIO: $${portfolioValue.toLocaleString()} | Cash: $${cash.toLocaleString()}
OPEN POSITIONS (do NOT re-enter these): ${existingSymbols.join(", ") || "none"}
CURRENT POSITIONS: ${posSummary}

TOP MARKET MOVERS (scored by setup quality):
${moverSummary || "No qualifying movers found above volume threshold."}

TASK: Identify the 1-3 BEST trading opportunities. Requirements:
1. Minimum confidence: ${MIN_CONFIDENCE}%
2. Maximum loss probability: ${MAX_LOSS_PROB}%
3. Minimum risk:reward: ${MIN_RISK_REWARD}:1
4. Max position size: ${(MAX_POSITION_SIZE_PCT*100).toFixed(0)}% of cash
5. Prefer setups with technical confluence (volume + price level + momentum alignment)
6. Do NOT enter symbols already in positions
7. If no setups meet ALL criteria, return trades: [] and explain in scanSummary

Respond ONLY with this exact JSON:
{
  "trades": [
    {
      "symbol": "TICKER",
      "side": "buy" | "sell",
      "orderType": "limit" | "market",
      "confidence": 0-100,
      "lossProbability": 0-100,
      "cashPercent": 5-20,
      "limitPrice": null or number,
      "stopLoss": number,
      "target": number,
      "riskReward": "1:X",
      "reasoning": "specific 1-2 sentence rationale citing data",
      "catalysts": ["factor 1", "factor 2"],
      "setupType": "pattern name"
    }
  ],
  "marketBias": "BULLISH" | "BEARISH" | "NEUTRAL",
  "scanSummary": "1-2 sentence overall read explaining what was found and why trades were/weren't taken",
  "skipped": ["SYMBOL: reason did not meet criteria"]
}`,
        }],
      }),
    });

    const data = await res.json();
    const text = data.content?.[0]?.text || "{}";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    plannedTrades = parsed.trades || [];
    scanMeta = {
      marketBias:  parsed.marketBias  || "NEUTRAL",
      scanSummary: parsed.scanSummary || "No summary provided.",
      skipped:     parsed.skipped     || [],
    };
    console.log(`[scanner] Claude: ${plannedTrades.length} trade(s). Bias: ${scanMeta.marketBias}`);
  } catch (e) {
    console.error("[scanner] Claude analysis failed:", e.message);
    await logScanEvent({
      timestamp, scanTime: nowEST(now), skipped: true,
      skipReason: `Claude API error: ${e.message}`,
      tickersScanned: Object.keys(marketData).length,
      setupsFound: 0, tradesExecuted: 0, marketBias: "N/A",
      scanSummary: "Claude API failed — no analysis generated.",
    });
    return { statusCode: 500, body: JSON.stringify({ error: "Claude analysis failed", detail: e.message }) };
  }

  // ── 6. EXECUTE TRADES ────────────────────────────────────
  const executedTrades = [];
  const signalStore  = blob("signal-log");
  const journalStore = blob("trade-journal");

  for (const trade of plannedTrades) {
    const scanTimestamp = new Date().toISOString();
    const baseSignal = {
      ticker:          trade.symbol,
      symbol:          trade.symbol,
      action:          (trade.side || "buy").toUpperCase(),
      side:            trade.side,
      confidence:      trade.confidence,
      lossProbability: trade.lossProbability,
      riskReward:      trade.riskReward,
      stopLoss:        trade.stopLoss,
      target:          trade.target,
      reasoning:       trade.reasoning,
      catalysts:       trade.catalysts || [],
      setupType:       trade.setupType,
      marketBias:      scanMeta.marketBias,
      source:          "auto",
      automated:       true,
      timestamp:       scanTimestamp,
    };

    // Gate checks — log every skip
    let gatedReason = null;
    if ((trade.lossProbability || 100) > MAX_LOSS_PROB) {
      gatedReason = `Loss probability ${trade.lossProbability}% exceeds ${MAX_LOSS_PROB}% max`;
    } else if ((trade.confidence || 0) < MIN_CONFIDENCE) {
      gatedReason = `Confidence ${trade.confidence}% below ${MIN_CONFIDENCE}% minimum`;
    } else if (existingSymbols.includes(trade.symbol)) {
      gatedReason = `Already in position`;
    } else {
      const rrParts = (trade.riskReward || "1:0").split(":");
      const rrNum = parseFloat(rrParts[rrParts.length - 1]);
      if (rrNum > 0 && rrNum < MIN_RISK_REWARD) {
        gatedReason = `R:R ${trade.riskReward} below ${MIN_RISK_REWARD}:1 minimum`;
      }
    }

    if (gatedReason) {
      console.log(`[scanner] GATED: ${trade.symbol} — ${gatedReason}`);
      await signalStore.setJSON(`sig-gated-${trade.symbol}-${Date.now()}`, {
        ...baseSignal, executed: false, gated: true, gatedReason,
      }).catch(() => {});
      continue;
    }

    // Execute
    try {
      const cashPct  = Math.min(trade.cashPercent || 10, MAX_POSITION_SIZE_PCT * 100) / 100;
      const tradeAmt = cash * cashPct;
      const price    = marketData[trade.symbol]?.price || trade.limitPrice || 100;
      const qty      = Math.max(1, Math.floor(tradeAmt / price));

      const orderBody = {
        symbol: trade.symbol, qty: String(qty), side: trade.side,
        type: trade.orderType || "market", time_in_force: "day",
      };
      if (trade.orderType === "limit" && trade.limitPrice) {
        orderBody.limit_price = parseFloat(trade.limitPrice.toFixed(2));
      }

      const orderRes = await fetch("https://paper-api.alpaca.markets/v2/orders", {
        method: "POST", headers: ALPACA_HEADERS, body: JSON.stringify(orderBody),
      });
      const order = await orderRes.json();

      if (order.id) {
        const executed = {
          ...baseSignal, orderId: order.id, qty, orderType: trade.orderType,
          price, limitPrice: trade.limitPrice || null,
          cashPercent: cashPct * 100, cashDeployed: tradeAmt,
          executed: true, gated: false, status: order.status,
        };
        executedTrades.push(executed);
        await journalStore.setJSON(`trade-${order.id}`, executed);
        await signalStore.setJSON(`sig-${order.id}`, executed).catch(() => {});
        console.log(`[scanner] EXECUTED ${trade.side.toUpperCase()} ${qty}x ${trade.symbol} @ ~$${price.toFixed(2)} | conf:${trade.confidence}% | R:R ${trade.riskReward}`);
      } else {
        await signalStore.setJSON(`sig-rejected-${trade.symbol}-${Date.now()}`, {
          ...baseSignal, executed: false, gated: false,
          gatedReason: `Order rejected: ${order.message || order.code || "unknown"}`,
        }).catch(() => {});
        console.warn(`[scanner] Order rejected for ${trade.symbol}:`, order.message || JSON.stringify(order));
      }
    } catch (e) {
      console.error(`[scanner] Execution error for ${trade.symbol}:`, e.message);
    }
  }

  // ── 7. ALWAYS LOG SCAN SUMMARY ───────────────────────────
  // Written EVERY run so the AUTO tab always shows the scanner fired
  await logScanEvent({
    timestamp,
    scanTime:       nowEST(now),
    skipped:        false,
    tickersScanned: Object.keys(marketData).length,
    moversScored:   scored.length,
    setupsFound:    plannedTrades.length,
    setupsGated:    plannedTrades.length - executedTrades.length,
    tradesExecuted: executedTrades.length,
    marketBias:     scanMeta.marketBias,
    scanSummary:    scanMeta.scanSummary,
    skippedByAI:    scanMeta.skipped,
    portfolioValue,
    openPositions:  existingSymbols,
    executedSymbols: executedTrades.map(t => t.symbol),
  });

  console.log(`[scanner] Complete: ${executedTrades.length}/${plannedTrades.length} trades executed`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      success:        true,
      scanned:        Object.keys(marketData).length,
      moversFound:    scored.length,
      tradesPlanned:  plannedTrades.length,
      tradesExecuted: executedTrades.length,
      marketBias:     scanMeta.marketBias,
      scanSummary:    scanMeta.scanSummary,
      trades:         executedTrades,
    }),
  };
};
