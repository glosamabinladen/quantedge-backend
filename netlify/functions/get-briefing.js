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

  const type = (event.queryStringParameters && event.queryStringParameters.type) || "both";

  // Always return 200 — never let a missing briefing crash the function
  let morning = null;
  let eod = null;

  try {
    // siteID from context (injected by Netlify) or env var fallback
    const siteID =
      (context && context.site && context.site.id) ||
      process.env.NETLIFY_SITE_ID ||
      "extraordinary-mandazi-a05e7e";

    const token = process.env.NETLIFY_TOKEN;

    // Build store config — with token if available, without if not
    const storeConfig = token
      ? { name: "briefings", siteID, token }
      : { name: "briefings", siteID };

    const store = getStore(storeConfig);

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
    body: JSON.stringify({
      morning,
      eod,
      fetchedAt: new Date().toISOString(),
    }),
  };
};
