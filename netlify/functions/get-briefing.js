// netlify/functions/get-briefing.js
// GET /.netlify/functions/get-briefing?type=morning|eod|both
// Reads from "briefings" blob store — keys: "morning-briefing" and "eod-debrief"

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
  "Netlify-CDN-Cache-Control": "no-store",
};

// ── BLOBS (explicit auth required) ───────────────────────────────────────────
const blob = (name) => getStore({
  name,
  siteID: process.env.NETLIFY_SITE_ID,
  token:  process.env.NETLIFY_AUTH_TOKEN,
});

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "ok" };
  }

  const type = event.queryStringParameters?.type || "both";

  let morning = null;
  let eod     = null;

  try {
    const store = blob("briefings");

    if (type === "morning" || type === "both") {
      try {
        const raw = await store.get("morning-briefing");
        morning = raw ? JSON.parse(raw) : null;
      } catch (e) {
        console.log("morning-briefing not found:", e.message);
      }
    }

    if (type === "eod" || type === "both") {
      try {
        const raw = await store.get("eod-debrief");
        eod = raw ? JSON.parse(raw) : null;
      } catch (e) {
        console.log("eod-debrief not found:", e.message);
      }
    }
  } catch (err) {
    console.error("get-briefing store error:", err.message);
    // Fall through — return nulls, not a 500
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ morning, eod, fetchedAt: new Date().toISOString() }),
  };
};
