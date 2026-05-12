// netlify/functions/run-scanner.js
// HTTP-callable wrapper to manually trigger the market scanner
import { getStore } from "@netlify/blobs";
import webpush from "web-push";

const POLYGON_KEY  = () => process.env.POLYGON_API_KEY;
const ALPACA_KEY   = () => process.env.ALPACA_API_KEY;
const ALPACA_SEC   = () => process.env.ALPACA_API_SECRET;
const CLAUDE_KEY   = () => process.env.ANTHROPIC_API_KEY;
const VAPID_PUBLIC = () => process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE= () => process.env.VAPID_PRIVATE_KEY;

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "POST only" }) };

  try {
    const now = new Date();
    const estHour = parseInt(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" }).format(now));
    const day = now.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" });
    const isWeekday = !["Sat", "Sun"].includes(day);

    const WATCHLIST = ["SPY","QQQ","AAPL","NVDA","TSLA","MSFT","META","AMZN","GOOGL","AMD","NFLX","PLTR","RIVN","SOFI","COIN","HOOD","F","UBER","SNAP","RBLX","SQ","PYPL","MSTR","ARM","SMCI"];

    let marketData = {};
    try {
      const tickerStr = WATCHLIST.join(",");
      const r = await fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerStr}&apiKey=${POLYGON_KEY()}`);
      const d = await r.json();
      if (d.tickers) {
        d.tickers.forEach(t => {
          marketData[t.ticker] = {
            price: t.day?.c || t.prevDay?.c || 0,
            open: t.day?.o || 0, high: t.day?.h || 0, low: t.day?.l || 0,
            volume: t.day?.v || 0, vwap: t.day?.vw || 0,
            changePerc: t.todaysChangePerc || 0, prevClose: t.prevDay?.c || 0,
          };
        });
      }
    } catch (e) { console.error("Polygon failed:", e.message); }

    const movers = Object.entries(marketData)
      .filter(([, d]) => d.price > 5 && d.volume > 500000)
      .sort((a, b) => Math.abs(b[1].changePerc) - Math.abs(a[1].changePerc))
      .slice(0, 10);

    let account = { portfolio_value: 100000, cash: 100000 };
    let existingPositions = [];
    try {
      const headers = { "APCA-API-KEY-ID": ALPACA_KEY(), "APCA-API-SECRET-KEY": ALPACA_SEC() };
      const [accRes, posRes] = await Promise.all([
        fetch("https://paper-api.alpaca.markets/v2/account", { headers }),
        fetch("https://paper-api.alpaca.markets/v2/positions", { headers }),
      ]);
      account = await accRes.json();
      existingPositions = await posRes.json();
    } catch (e) { console.warn("Alpaca failed:", e.message); }

    const cash = parseFloat(account.cash || 100000);
    const existingSymbols = Array.isArray(existingPositions) ? existingPositions.map(p => p.symbol) : [];

    const moverSummary = movers.map(([sym, d]) =>
      `${sym}: $${d.price.toFixed(2)} (${d.changePerc >= 0 ? "+" : ""}${d.changePerc.toFixed(2)}%) Vol: ${(d.volume / 1e6).toFixed(1)}M`
    ).join("\n");

    let trades = [];
    let marketBias = "NEUTRAL";
    let scanSummary = "";

    try {
      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": CLAUDE_KEY(), "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: "You are QuantEdge Pro's autonomous trading AI. Find high-probability trades. Never trade with >40% loss probability.",
          messages: [{
            role: "user",
            content: `Time: ${now.toLocaleTimeString("en-US", { timeZone: "America/New_York" })} EST
Cash: $${cash.toLocaleString()}
Skip these symbols: ${existingSymbols.join(", ") || "none"}

TOP MOVERS:
${moverSummary}

Find 1-3 best trades. Position size: 90%+ conf = 25% cash, 70-89% = 15%, 60-69% = 5%.
Skip any trade with >40% loss probability.

Respond ONLY with JSON:
{
  "trades": [{"symbol":"","side":"buy","orderType":"limit","confidence":0,"lossProbability":0,"cashPercent":5,"limitPrice":null,"stopLoss":0,"target":0,"reasoning":"","setupType":""}],
  "marketBias": "BULLISH",
  "scanSummary": ""
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
    } catch (e) { console.error("Claude failed:", e.message); }

    const executedTrades = [];
    for (const trade of trades) {
      if (trade.lossProbability > 40 || trade.confidence < 60) continue;
      try {
        const price = marketData[trade.symbol]?.price || 100;
        const qty = Math.max(1, Math.floor((cash * (trade.cashPercent / 100)) / price));
        const orderBody = { symbol: trade.symbol, qty, side: trade.side, type: trade.orderType, time_in_force: "day" };
        if (trade.orderType === "limit" && trade.limitPrice) orderBody.limit_price = parseFloat(trade.limitPrice.toFixed(2));
        const orderRes = await fetch("https://paper-api.alpaca.markets/v2/orders", {
          method: "POST",
          headers: { "APCA-API-KEY-ID": ALPACA_KEY(), "APCA-API-SECRET-KEY": ALPACA_SEC(), "Content-Type": "application/json" },
          body: JSON.stringify(orderBody),
        });
        const order = await orderRes.json();
        if (order.id) {
          const executed = { ...trade, orderId: order.id, qty, price, timestamp: now.toISOString(), status: order.status };
          executedTrades.push(executed);
          const store = getStore("trade-journal");
          await store.setJSON(`trade-${order.id}`, executed);
          console.log(`EXECUTED: ${trade.side.toUpperCase()} ${qty} ${trade.symbol} @ $${price.toFixed(2)}`);
        }
      } catch (e) { console.error(`Trade failed for ${trade.symbol}:`, e.message); }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, scanned: Object.keys(marketData).length, tradesExecuted: executedTrades.length, trades: executedTrades, marketBias, scanSummary }),
    };
  } catch (e) {
    console.error("Scanner error:", e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
