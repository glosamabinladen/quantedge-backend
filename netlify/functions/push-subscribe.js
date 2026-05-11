// netlify/functions/push-subscribe.js
// Saves push notification subscriptions from iPad + MacBook
import { getStore } from "@netlify/blobs";
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return corsResponse(200, {});
  }
  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return corsResponse(400, { error: "Invalid JSON" });
    }
    const { subscription, deviceName } = body;
    if (!subscription || !subscription.endpoint) {
      return corsResponse(400, { error: "Missing subscription object" });
    }
    try {
      const store = getStore("push-subscriptions");
      const key = Buffer.from(subscription.endpoint).toString("base64").slice(0, 50);
      await store.setJSON(key, {
        subscription,
        deviceName: deviceName || "Unknown Device",
        registeredAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      });
      return corsResponse(200, {
        success: true,
        message: `${deviceName || "Device"} subscribed to QuantEdge Pro push notifications`
      });
    } catch (err) {
      return corsResponse(500, { error: "Failed to save subscription", detail: err.message });
    }
  }
  if (event.httpMethod === "DELETE") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return corsResponse(400, { error: "Invalid JSON" });
    }
    const { endpoint } = body;
    if (!endpoint) return corsResponse(400, { error: "Missing endpoint" });
    try {
      const store = getStore("push-subscriptions");
      const key = Buffer.from(endpoint).toString("base64").slice(0, 50);
      await store.delete(key);
      return corsResponse(200, { success: true, message: "Unsubscribed" });
    } catch (err) {
      return corsResponse(500, { error: "Failed to remove subscription" });
    }
  }
  if (event.httpMethod === "GET") {
    try {
      const store = getStore("push-subscriptions");
      const { blobs } = await store.list();
      const devices = await Promise.all(
        blobs.map(async ({ key }) => {
          const data = await store.getJSON(key);
          return { key, deviceName: data?.deviceName, registeredAt: data?.registeredAt };
        })
      );
      return corsResponse(200, { devices, count: devices.length });
    } catch (err) {
      return corsResponse(500, { error: "Failed to list subscriptions" });
    }
  }
  return corsResponse(405, { error: "Method not allowed" });
};
function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}
