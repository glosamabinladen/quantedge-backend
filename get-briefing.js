// netlify/functions/get-briefing.js
// CommonJS — matches Netlify default Node runtime
// Returns morning briefing and/or EOD debrief from Netlify Blobs

const { getStore } = require("@netlify/blobs");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "ok" };
  }

  const type = (event.queryStringParameters && event.queryStringParameters.type) || "both";

  let morning = null;
  let eod = null;

  try {
    const store = getStore("briefings");

    if (type === "morning" || type === "both") {
      try {
        const raw = await store.get("morning-briefing");
        morning = raw ? JSON.parse(raw) : null;
      } catch (e) {
        console.log("No morning briefing yet:", e.message);
        morning = null;
      }
    }

    if (type === "eod" || type === "both") {
      try {
        const raw = await store.get("eod-debrief");
        eod = raw ? JSON.parse(raw) : null;
      } catch (e) {
        console.log("No EOD debrief yet:", e.message);
        eod = null;
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ morning, eod, fetchedAt: new Date().toISOString() }),
    };

  } catch (err) {
    console.error("get-briefing fatal:", err);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ morning: null, eod: null, error: err.message }),
    };
  }
};
