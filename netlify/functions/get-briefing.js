// netlify/functions/get-briefing.js
// Serves stored morning briefings and EOD debriefs to the frontend
// Called by journal.html and terminal to display AI-generated briefings

import { getStore } from "@netlify/blobs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return corsResponse(200, {});
  }

  const { type, date } = event.queryStringParameters || {};

  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }).replace(/\//g, "-");
  const targetDate = date || today;
  const targetType = type || "morning";

  if (!["morning", "eod", "both"].includes(targetType)) {
    return corsResponse(400, { error: "type must be 'morning', 'eod', or 'both'" });
  }

  try {
    const store = getStore("daily-briefings");

    if (targetType === "both") {
      let morning = null, eod = null;
      try { morning = await store.getJSON(`morning-${targetDate}`); } catch {}
      try { eod = await store.getJSON(`eod-${targetDate}`); } catch {}
      return corsResponse(200, { morning, eod, date: targetDate });
    }

    let briefing = null;
    try {
      briefing = await store.getJSON(`${targetType}-${targetDate}`);
    } catch {
      // Try recent dates if today not found
      for (let i = 1; i <= 5; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        if (d.getDay() === 0 || d.getDay() === 6) continue;
        const key = d.toLocaleDateString("en-US", { timeZone: "America/New_York" }).replace(/\//g, "-");
        try {
          briefing = await store.getJSON(`${targetType}-${key}`);
          if (briefing) break;
        } catch {}
      }
    }

    if (!briefing) {
      return corsResponse(404, { error: `No ${targetType} briefing found for ${targetDate}`, date: targetDate });
    }

    return corsResponse(200, { ...briefing, retrieved: new Date().toISOString() });
  } catch (err) {
    return corsResponse(500, { error: "Failed to retrieve briefing", detail: err.message });
  }
};

function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "https://glosamabinladen.github.io",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}
