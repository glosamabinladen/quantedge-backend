// netlify/functions/get-briefing.js
// Returns morning briefing and/or EOD debrief from Netlify Blobs
// Handles missing/empty store gracefully (no 500 on cold start)

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const url = new URL(req.url);
    const type = url.searchParams.get("type") || "both"; // morning | eod | both

    const store = getStore("briefings");

    let morning = null;
    let eod = null;

    if (type === "morning" || type === "both") {
      try {
        const raw = await store.get("morning-briefing");
        morning = raw ? JSON.parse(raw) : null;
      } catch (_) {
        morning = null; // key doesn't exist yet — not an error
      }
    }

    if (type === "eod" || type === "both") {
      try {
        const raw = await store.get("eod-debrief");
        eod = raw ? JSON.parse(raw) : null;
      } catch (_) {
        eod = null;
      }
    }

    return new Response(
      JSON.stringify({ morning, eod, fetchedAt: new Date().toISOString() }),
      { status: 200, headers: CORS }
    );
  } catch (err) {
    console.error("get-briefing error:", err);
    return new Response(
      JSON.stringify({ morning: null, eod: null, error: err.message }),
      { status: 200, headers: CORS } // Return 200 with nulls so frontend doesn't crash
    );
  }
};

export const config = { path: "/get-briefing" };
