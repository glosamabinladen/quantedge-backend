// netlify/functions/claude-proxy.js
// CommonJS — no ES module syntax, no fetch() dependency
const https = require("https");

function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve({}); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(clean); } catch (_) {}
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return corsResponse(200, {});
  if (event.httpMethod !== "POST") return corsResponse(405, { error: "Method not allowed" });

  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
  if (!CLAUDE_KEY) return corsResponse(500, { error: "Claude API key not configured" });

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
VOLUME: ${volume ? Number(volume).toLocaleString() : "N/A"}
AVG VOLUME: ${volAvg ? Number(volAvg).toLocaleString() : "N/A"}
VOLUME SPIKE: ${volAvg && volume ? ((volume / volAvg) * 100).toFixed(0) + "%" : "N/A"}
TIME OF DAY: ${timeOfDay || "Market Hours"}
ORDER BOOK BIAS: ${orderBook || "N/A"}

Respond ONLY with this exact JSON structure (no markdown, no extra text):
{
  "action": "BUY",
  "confidence": 75,
  "stopLoss": 290.00,
  "target": 305.00,
  "reasoning": "2-3 sentence technical analysis",
  "keyRisk": "single biggest risk",
  "setupType": "pattern name e.g. RSI Oversold Bounce"
}`;

  const reqBody = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const options = {
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Length": Buffer.byteLength(reqBody),
    },
  };

  try {
    const data = await httpsPost(options, reqBody);

    if (data.error) {
      console.error("Claude API error:", data.error);
      return corsResponse(502, { error: "Claude API error", detail: data.error.message });
    }

    const text = data.content?.[0]?.text || "{}";
    console.log("Claude raw:", text.slice(0, 200));

    const signal = extractJSON(text) || {
      action: "HOLD",
      confidence: 0,
      reasoning: text.slice(0, 100),
    };

    return corsResponse(200, {
      signal,
      ticker,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("claude-proxy error:", err.message);
    return corsResponse(502, { error: "Claude request failed", detail: err.message });
  }
};
