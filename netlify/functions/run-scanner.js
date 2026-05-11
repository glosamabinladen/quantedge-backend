// netlify/functions/run-scanner.js
// HTTP-callable wrapper to manually trigger the market scanner
import { getStore } from "@netlify/blobs";
import webpush from "web-push";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return corsResponse(204, {});
  if (event.httpMethod !== "POST") return corsResponse(405, { error: "POST only" });

  try {
    const { handler: scan } = await import("./market-scanner.js");
    const result = await scan(event);
    return { ...result, headers: { ...result.headers, "Access-Control-Allow-Origin": "*" } };
  } catch (e) {
    return corsResponse(500, { error: e.message });
  }
};

function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}
