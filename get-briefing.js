// netlify/functions/get-briefing.js
const { getStore } = require("@netlify/blobs");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async function (event, context) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "ok" };
  }

  const type =
    (event.queryStringParameters && event.queryStringParameters.type) || "both";

  // Netlify Blobs needs siteID when called via HTTP functions
  // context.site.id is injected automatically by Netlify at runtime
  const siteID = context.site && context.site.id
    ? context.site.id
    : process.env.NETLIFY_SITE_ID || "extraordinary-mandazi-a05e7e";

  let morning = null;
  let eod = null;

  try {
    const store = getStore({ name: "briefings", siteID, token: process.env.NETLIFY_TOKEN });

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
    console.error("get-briefing fatal:", err.message);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ morning: null, eod: null, error: err.message }),
    };
  }
};
