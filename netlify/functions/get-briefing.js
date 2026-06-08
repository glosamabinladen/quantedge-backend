// netlify/functions/get-briefing.js
import { getStore } from "@netlify/blobs";

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
    const store = getStore("briefings");

    if (type === "morning" || type === "both") {
      try {
        morning = await store.getJSON("morning-briefing");
      } catch (e) {
        console.log("morning-briefing not found:", e.message);
      }
    }

    if (type === "eod" || type === "both") {
      try {
        eod = await store.getJSON("eod-debrief");
      } catch (e) {
        console.log("eod-debrief not found:", e.message);
      }
    }
  } catch (err) {
    console.error("get-briefing store error:", err.message);
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ morning, eod, fetchedAt: new Date().toISOString() }),
  };
};
