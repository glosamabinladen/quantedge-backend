// netlify/functions/claude-proxy.js
// Secure proxy for Anthropic Claude — API key stays server-side
// Called by: GitHub Pages frontend for AI signal generation

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return corsResponse(200, {});
  }

  if (event.httpMethod !== "POST") {
    return corsResponse(405, { error: "Method not allowed" });
  }

  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
  if (!CLAUDE_KEY) {
    return corsResponse(500, { error: "Claude API key not configured" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return corsResponse(400, { error: "Invalid JSON body" });
  }

  const { ticker, price, rsi, vwap, volume, volAvg, orderBook, timeOfDay } = body;

  if (!ticker || !price) {
    return corsResponse(400, { error: "Missing required fields: ticker, price" });
  }

  const systemPrompt = `You are QuantEdge Pro's AI signal engine — a ruthlessly precise, money-obsessed trading analyst. You analyze real market data and generate actionable trading signals for paper trading. You are direct, confident, and focused purely on edge. No disclaimers, no hedging — just the signal.`;

  const userPrompt = `Analyze this real-time market data and generate a trading signal:

TICKER: ${ticker}
CURRENT PRICE: $${price}
RSI (14): ${rsi || "N/A"}
VWAP: ${vwap ? `$${vwap}` : "N/A"}
VOLUME: ${volume ? volume.toLocaleString() : "N/A"}
AVG VOLUME: ${volAvg ? volAvg.toLocaleString() : "N/A"}
VOLUME SPIKE: ${volAvg && volume ? `${((volume / volAvg) * 100).toFixed(0)}%` : "N/A"}
TIME OF DAY: ${timeOfDay || "Market Hours"}
ORDER BOOK BIAS: ${orderBook || "N/A"}

Respond ONLY with this exact JSON structure (no extra text):
{
  "action": "BUY" or "SELL" or "HOLD",
  "confidence": <number 0-100>,
  "stopLoss": <price number>,
  "target": <price number>,
  "reasoning": "<2-3 sentence technical analysis>",
  "keyRisk": "<single biggest risk to this trade>",
  "setupType": "<pattern name e.g. RSI Oversold Bounce, VWAP Reclaim, Momentum Continuation>"
}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      return corsResponse(502, { error: "Claude API error", detail: data.error.message });
    }

    const text = data.content?.[0]?.text || "{}";
    let signal;
    try {
      signal = JSON.parse(text);
    } catch {
      // Try to extract JSON from response
      const match = text.match(/\{[\s\S]*\}/);
      signal = match ? JSON.parse(match[0]) : { action: "HOLD", confidence: 0, reasoning: text };
    }

    return corsResponse(200, { signal, ticker, timestamp: new Date().toISOString() });
  } catch (err) {
    return corsResponse(502, { error: "Claude request failed", detail: err.message });
  }
};

function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "https://glosamabinladen.github.io",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}
