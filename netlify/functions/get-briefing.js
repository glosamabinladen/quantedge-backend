// netlify/functions/get-briefing.js
import { getStore } from "@netlify/blobs";

const blob = (name) => getStore({
  name,
  siteID: process.env.NETLIFY_SITE_ID,
  token:  process.env.NETLIFY_AUTH_TOKEN,
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "ok" };

  const type = event.queryStringParameters?.type || "both";
  let morning = null;
  let eod = null;

  try {
    const store = blob("briefings");
    if (type === "morning" || type === "both") {
      try { morning = await store.getJSON("morning-briefing"); } catch {}
    }
    if (type === "eod" || type === "both") {
      try { eod = await store.getJSON("eod-debrief"); } catch {}
    }
  } catch (err) {
    console.error("get-briefing error:", err.message);
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ morning, eod, fetchedAt: new Date().toISOString() }),
  };
};
