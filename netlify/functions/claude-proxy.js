// netlify/functions/claude-proxy.js
// Generates high-conviction trading signals using real market data

const CLAUDE_KEY = () => process.env.ANTHROPIC_API_KEY;

function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":"GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":"Content-Type",
    },
    body: JSON.stringify(body),
  };
}

function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(clean); } catch {}
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch {}
  }
  return null;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return corsResponse(200, {});
  if (event.httpMethod !== "POST") return corsResponse(405, { error: "Method not allowed" });

  const key = CLAUDE_KEY();
  if (!key) return corsResponse(500, { error: "ANTHROPIC_API_KEY not configured" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return corsResponse(400, { error: "Invalid JSON body" });
  }

  const { ticker, price, rsi, vwap, volume, volAvg, orderBook, timeOfDay, high, low, open, prevClose } = body;
  if (!ticker || !price) return corsResponse(400, { error: "Missing required fields: ticker, price" });

  // Calculate derived metrics
  const priceNum    = parseFloat(price);
  const vwapNum     = parseFloat(vwap) || 0;
  const rsiNum      = parseFloat(rsi) || 50;
  const volumeNum   = parseInt(volume) || 0;
  const volAvgNum   = parseInt(volAvg) || 0;
  const highNum     = parseFloat(high) || priceNum * 1.01;
  const lowNum      = parseFloat(low) || priceNum * 0.99;
  const openNum     = parseFloat(open) || priceNum;
  const prevNum     = parseFloat(prevClose) || priceNum;

  const volSpike    = volAvgNum > 0 ? ((volumeNum / volAvgNum) * 100).toFixed(0) + "%" : "N/A";
  const vwapBias    = vwapNum > 0 ? (priceNum > vwapNum ? `ABOVE VWAP (+${((priceNum-vwapNum)/vwapNum*100).toFixed(2)}%)` : `BELOW VWAP (${((priceNum-vwapNum)/vwapNum*100).toFixed(2)}%)`) : "N/A";
  const dayChange   = prevNum > 0 ? `${((priceNum-prevNum)/prevNum*100).toFixed(2)}%` : "N/A";
  const dayRange    = `$${lowNum.toFixed(2)} – $${highNum.toFixed(2)} (${((highNum-lowNum)/lowNum*100).toFixed(2)}% range)`;
  const priceInRange = highNum > lowNum ? `${((priceNum-lowNum)/(highNum-lowNum)*100).toFixed(0)}% of day range` : "N/A";

  const systemPrompt = `You are QuantEdge Pro's signal engine — a ruthlessly precise trading analyst. You generate actionable signals for paper trading based on real market data. You are direct and confident. No disclaimers. Only trade setups with clear edge.`;

  const userPrompt = `Analyze this live market data and generate a trading signal:

TICKER: ${ticker}
PRICE: $${priceNum.toFixed(2)}
DAY CHANGE: ${dayChange}
DAY RANGE: ${dayRange}
PRICE IN RANGE: ${priceInRange}
OPEN: $${openNum.toFixed(2)}
RSI(14): ${rsiNum.toFixed(1)} ${rsiNum > 70 ? "⚠ OVERBOUGHT" : rsiNum < 30 ? "⚠ OVERSOLD" : ""}
VWAP: ${vwapBias}
VOLUME: ${volumeNum > 0 ? volumeNum.toLocaleString() : "N/A"}
VOLUME SPIKE: ${volSpike}
ORDER BOOK BIAS: ${orderBook || "N/A"}
TIME OF DAY: ${timeOfDay || "Market Hours"}

Technical context:
- RSI ${rsiNum < 30 ? "oversold — potential bounce" : rsiNum > 70 ? "overbought — potential fade" : "neutral range"}
- Price ${vwapNum > 0 ? (priceNum > vwapNum ? "above VWAP → bullish intraday" : "below VWAP → bearish intraday") : "VWAP unknown"}
- Volume ${volAvgNum > 0 ? (volumeNum > volAvgNum * 1.5 ? "spike — institutional activity" : volumeNum < volAvgNum * 0.5 ? "dry — low conviction" : "normal") : "data N/A"}

Respond ONLY with this JSON (no markdown, no extra text):
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "stopLoss": number,
  "target": number,
  "riskReward": "1:X format e.g. 1:2.5",
  "reasoning": "2-3 sentence technical rationale citing specific data points",
  "keyRisk": "single biggest risk to this trade",
  "setupType": "specific pattern e.g. VWAP Reclaim, RSI Oversold Bounce, Momentum Breakout, Flag Consolidation"
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 600,
        system:     systemPrompt,
        messages:   [{ role: "user", content: userPrompt }],
      }),
    });

    const data = await res.json();
    if (data.error) {
      console.error("Claude API error:", data.error);
      return corsResponse(502, { error: "Claude API error", detail: data.error.message });
    }

    const text  = data.content?.[0]?.text || "{}";
    const signal = extractJSON(text) || { action: "HOLD", confidence: 0, reasoning: "Parse error" };

    console.log(`[claude-proxy] ${ticker} → ${signal.action} ${signal.confidence}% conf`);

    return corsResponse(200, { signal, ticker, price: priceNum, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("claude-proxy error:", err.message);
    return corsResponse(502, { error: "Claude request failed", detail: err.message });
  }
};
