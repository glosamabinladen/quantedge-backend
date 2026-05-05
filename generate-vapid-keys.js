#!/usr/bin/env node
// generate-vapid-keys.js
// Run this ONCE on your MacBook to generate VAPID keys for push notifications
// Then add both keys to Netlify environment variables
//
// Usage:
//   npm install web-push
//   node generate-vapid-keys.js

const webpush = require("web-push");

const vapidKeys = webpush.generateVAPIDKeys();

console.log("\n╔════════════════════════════════════════════════════════╗");
console.log("║         QuantEdge Pro — VAPID Keys Generated           ║");
console.log("╚════════════════════════════════════════════════════════╝\n");

console.log("Add these to Netlify → Site Configuration → Environment Variables:\n");

console.log("Variable Name:    VAPID_PUBLIC_KEY");
console.log("Variable Value:  ", vapidKeys.publicKey);
console.log("");
console.log("Variable Name:    VAPID_PRIVATE_KEY");
console.log("Variable Value:  ", vapidKeys.privateKey);
console.log("");

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("Also add the PUBLIC key to your GitHub Pages index.html:");
console.log("");
console.log(`const VAPID_PUBLIC_KEY = "${vapidKeys.publicKey}";`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

console.log("⚠️  KEEP YOUR PRIVATE KEY SECRET — never commit it to GitHub\n");
