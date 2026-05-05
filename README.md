# QuantEdge Pro — Phase 5 Backend

**Netlify serverless backend for QuantEdge Pro trading terminal**  
Site: kaleidoscopic-sundae-1092b5.netlify.app  
Frontend: glosamabinladen.github.io/quantedge-pro

---

## Architecture

```
GitHub Pages (frontend) ──calls──▶ Netlify Functions (backend)
                                         │
                          ┌──────────────┼──────────────┐
                          ▼              ▼              ▼
                     Polygon.io     Anthropic       Alpaca
                    (market data)   (AI signals)   (paper trading)
```

All API keys live in Netlify environment variables — never exposed to the browser.

---

## Files

```
├── netlify.toml                          # Netlify config + scheduled function crons
├── package.json                          # Dependencies
├── generate-vapid-keys.js                # Run ONCE to generate push notification keys
├── netlify/functions/
│   ├── market-proxy.js                   # Polygon.io secure proxy
│   ├── claude-proxy.js                   # Claude AI signal generation proxy
│   ├── alpaca-proxy.js                   # Alpaca paper trading proxy
│   ├── morning-briefing.js               # Scheduled 9AM EST — AI market briefing + push
│   ├── eod-debrief.js                    # Scheduled 4PM EST — EOD review + push
│   ├── log-signal.js                     # Signal auto-logging (GET + POST)
│   ├── get-briefing.js                   # Serve stored briefings to frontend
│   └── push-subscribe.js                 # Device push subscription management
└── public/
    ├── sw.js                             # Service worker (copy to GitHub Pages repo)
    └── manifest.json                     # PWA manifest (copy to GitHub Pages repo)
```

---

## Deployment Steps

### Step 1 — Push to GitHub

Create a new GitHub repo (e.g. `quantedge-backend`) and push this folder:

```bash
git init
git add .
git commit -m "Phase 5: Netlify backend"
git remote add origin https://github.com/glosamabinladen/quantedge-backend.git
git push -u origin main
```

### Step 2 — Connect to Netlify

1. Go to https://app.netlify.com
2. Click **Add new site → Import from Git**
3. Choose your `quantedge-backend` repo
4. Build settings:
   - Build command: *(leave blank)*
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
5. Click **Deploy site**
6. In **Site Configuration → General**, set your custom site name to `kaleidoscopic-sundae-1092b5`

### Step 3 — Verify Environment Variables

Go to **Site Configuration → Environment Variables** and confirm all 4 are set:
- `POLYGON_API_KEY`
- `ANTHROPIC_API_KEY`  
- `ALPACA_API_KEY`
- `ALPACA_SECRET_KEY`

### Step 4 — Generate VAPID Keys (Push Notifications)

On your MacBook, in this folder:

```bash
npm install web-push
node generate-vapid-keys.js
```

Copy the two output keys into Netlify Environment Variables:
- `VAPID_PUBLIC_KEY` = (the long public key string)
- `VAPID_PRIVATE_KEY` = (the long private key string — keep secret!)

Then redeploy: **Deploys → Trigger deploy → Deploy site**

### Step 5 — Add Service Worker to GitHub Pages

Copy `public/sw.js` into your `quantedge-pro` GitHub Pages repo root.  
Copy `public/manifest.json` into the same repo.

Your `index.html` needs these additions (see Frontend Integration section below).

### Step 6 — Test Functions

Test each function URL in your browser or with curl:

```
GET  https://kaleidoscopic-sundae-1092b5.netlify.app/.netlify/functions/market-proxy?path=/v2/snapshot/locale/us/markets/stocks/tickers&params=tickers=SPY

GET  https://kaleidoscopic-sundae-1092b5.netlify.app/.netlify/functions/alpaca-proxy?endpoint=/v2/account

GET  https://kaleidoscopic-sundae-1092b5.netlify.app/.netlify/functions/log-signal?limit=10

POST https://kaleidoscopic-sundae-1092b5.netlify.app/.netlify/functions/claude-proxy
     Body: {"ticker":"SPY","price":500,"rsi":45,"vwap":499.50}
```

### Step 7 — Test Scheduled Functions Manually

Trigger the morning briefing manually:
```
https://kaleidoscopic-sundae-1092b5.netlify.app/.netlify/functions/morning-briefing
```

Then check it stored:
```
https://kaleidoscopic-sundae-1092b5.netlify.app/.netlify/functions/get-briefing?type=morning
```

---

## Frontend Integration Code

Add this to your GitHub Pages `index.html` (replace existing API calls):

```javascript
const BACKEND = "https://kaleidoscopic-sundae-1092b5.netlify.app/.netlify/functions";
const VAPID_PUBLIC_KEY = "YOUR_VAPID_PUBLIC_KEY_HERE"; // from Step 4

// Replace Polygon calls:
// OLD: fetch(`https://api.polygon.io/...?apiKey=${POLYGON_KEY}`)
// NEW:
async function fetchMarketData(path, params = "") {
  const res = await fetch(`${BACKEND}/market-proxy?path=${encodeURIComponent(path)}&params=${encodeURIComponent(params)}`);
  return res.json();
}

// Replace Claude calls:
// OLD: fetch("https://api.anthropic.com/v1/messages", {...})
// NEW:
async function getAISignal(ticker, price, rsi, vwap, volume, volAvg) {
  const res = await fetch(`${BACKEND}/claude-proxy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticker, price, rsi, vwap, volume, volAvg }),
  });
  return res.json();
}

// Auto-log signals:
async function autoLogSignal(signalData) {
  await fetch(`${BACKEND}/log-signal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signalData),
  });
}

// Service Worker + Push Registration:
async function registerPushNotifications(deviceName) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    console.log("Push not supported");
    return;
  }
  
  const registration = await navigator.serviceWorker.register("/quantedge-pro/sw.js");
  await navigator.serviceWorker.ready;
  
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;
  
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });
  
  await fetch(`${BACKEND}/push-subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription, deviceName }),
  });
  
  console.log(`✅ ${deviceName} subscribed to push notifications`);
}

// Helper function:
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
```

---

## Scheduled Functions Schedule

| Function | Cron | Time (EST) | Days |
|---|---|---|---|
| morning-briefing | `0 14 * * 1-5` | 9:00 AM | Mon–Fri |
| eod-debrief | `0 21 * * 1-5` | 4:00 PM | Mon–Fri |

---

## API Endpoints Summary

| Endpoint | Method | Purpose |
|---|---|---|
| `/market-proxy?path=...` | GET | Polygon.io data proxy |
| `/claude-proxy` | POST | AI signal generation |
| `/alpaca-proxy?endpoint=...` | GET/POST | Alpaca paper trading |
| `/log-signal` | GET/POST | Signal storage |
| `/get-briefing?type=morning` | GET | Retrieve AI briefings |
| `/push-subscribe` | GET/POST/DELETE | Device subscriptions |
| `/morning-briefing` | GET | Trigger morning briefing |
| `/eod-debrief` | GET | Trigger EOD debrief |

---

## Notes

- **Netlify Blobs** is used for storage (built-in, no extra config needed)
- Push notifications require HTTPS (GitHub Pages ✅, Netlify ✅)
- Firefox on macOS Big Sur supports push notifications natively
- iPad Safari requires iOS 16.4+ for web push — ensure your iPad is updated
- Scheduled functions run in UTC — crons are set correctly for EST/EDT
