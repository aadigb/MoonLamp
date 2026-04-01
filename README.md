# MOONLAMP

> A physical LED lamp that glows **green** or **red** based on a crypto/stock price or your EVM wallet portfolio — with brightness scaling to signal intensity and a rapid flash alert mode.

Built with an ESP32 + Adafruit NeoPixel Ring 16, a Node.js backend, and a retro Y2K web UI to control it.

---

## How it works

```
[Website] ──POST config──▶ [Node.js Backend] ──polls every 60s──▶ [CoinGecko / Yahoo Finance / Zerion]
                                   │
                            stores color + intensity + alert
                                   │
                           [ESP32 polls /api/color]
                                   │
                           [NeoPixel Ring 16 glows]
```

- **Green** = 24h change ≥ 0%
- **Red** = 24h change < 0%
- **Brightness** scales with how large the move is (dim = small move, bright = big move)
- **Alert mode** = rapid 5Hz flash when the move exceeds your threshold

---

## Features

| Feature | Description |
|---------|-------------|
| **Asset Price** | Track any crypto (via CoinGecko) or stock ticker (via Yahoo Finance) |
| **Bundle** | Create named portfolios of mixed crypto + stocks with custom weights; lamp shows weighted-average 24h change |
| **EVM Wallet** | Paste a `0x…` address; Zerion API fetches your full multi-token portfolio value and real 24h P&L |
| **Alert threshold** | Set the % move that triggers rapid flash mode (1–20%, in 0.5% steps) |
| **Lamp schedule** | Set active hours (PST) — lamp turns off automatically outside your window |
| **Mood log** | Log how you're feeling alongside the market color; stored with timestamp |
| **Vault ID** | Anonymous UUID that syncs your config across devices and persists your data; copy it to restore on any browser |

---

## Hardware

| Part | Notes |
|------|-------|
| ESP32 dev board | Any standard ESP32 dev board |
| Adafruit NeoPixel Ring 16 | 16x WS2812B RGB LEDs |
| USB cable | For power + programming |

### Wiring

```
NeoPixel Ring    ESP32
─────────────    ─────
PWR          →   5V (or VIN)
GND          →   GND
DIN          →   GPIO 4
```

---

## Backend Setup

### Requirements
- Node.js 18+

### 1. Clone the repo

```bash
git clone https://github.com/aadigb/MoonLamp.git
cd MoonLamp
```

### 2. Install dependencies

```bash
cd backend
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in:

```env
# Required only for EVM wallet tracking mode
# Get a free key at https://developers.zerion.io
ZERION_API_KEY=zk_your_key_here

# Optional — reduces CoinGecko 429 rate limit errors
# Get a free key at https://www.coingecko.com/en/api
COINGECKO_API_KEY=CG-your_key_here

# Port for the server (default 3000)
PORT=3000

# How often to refresh prices in milliseconds (default 60s)
REFRESH_INTERVAL_MS=60000
```

> Crypto and stock tracking work without any API keys. You only need Zerion for wallet mode, and CoinGecko is optional (it prevents rate limit errors under heavy use).

### 4. Start the server

```bash
npm start
```

Open **http://localhost:3000** in your browser.

---

## Deploying to Render (recommended)

Deploying to Render lets your ESP32 connect over the internet — no need to keep your computer on.

1. Push the repo to GitHub
2. Create a new **Web Service** on [render.com](https://render.com) pointing to your repo
3. Set **Root Directory** to `backend`, **Build Command** to `npm install`, **Start Command** to `npm start`
4. Add your env vars (`ZERION_API_KEY`, `COINGECKO_API_KEY`, and optionally `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`)
5. Deploy — Render gives you a URL like `moonlamp-xxxx.onrender.com`

A `render.yaml` is included at the repo root for one-click blueprint deploys.

### Persistent storage on Render

By default the backend stores config and mood logs as JSON files on disk — this works locally but resets on Render's free tier (ephemeral filesystem). For persistent cloud storage, add a [Supabase](https://supabase.com) project and set:

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key
```

The backend switches automatically to Supabase when these are present. Create two tables:

```sql
create table configs (
  account_id text primary key,
  data       jsonb not null,
  updated_at timestamptz default now()
);

create table moods (
  id             bigserial primary key,
  account_id     text not null,
  mood           text not null,
  lamp_color     text,
  percent_change numeric,
  created_at     timestamptz default now()
);
```

---

## Web UI Guide

### ASSET_PRICE tab
Search for a crypto (Bitcoin, Ethereum, Solana…) or enter a stock ticker (AAPL, TSLA, SPY…) and click `[ EXECUTE_TRACK ]`.

### BUNDLE tab
Create named bundles of mixed crypto + stocks. Each asset has a weight (1–100) and the lamp displays the weighted-average 24h change across the whole bundle. Bundles are saved to your Vault ID and persist across sessions.

### EVM_WALLET tab
Paste a `0x…` address. Uses the Zerion API to fetch your full multi-token portfolio value and real 24h P&L across all chains.

### ALERT_CONFIG
Drag the slider to set the % move that triggers rapid flash mode on the lamp. Range: 1%–20% in 0.5% steps.

### LAMP_SCHEDULE
Enable active hours (in PST) to automatically turn the lamp off outside your set window. Useful so it doesn't flash at 3am.

### MOOD_LOG
Log how you're feeling alongside the current lamp color and market change. Recent entries shown below the buttons.

### VAULT_ID
Your anonymous account key. Copy it and paste it into `[ RESTORE ]` on any other browser or device to sync your config, bundles, and mood history.

---

## ESP32 Firmware Setup

### Requirements
- [Arduino IDE](https://www.arduino.cc/en/software)
- ESP32 board support package
- Libraries: **Adafruit NeoPixel** and **ArduinoJson** (both installable via Arduino Library Manager)

### 1. Add ESP32 board support

In Arduino IDE → File → Preferences → add this URL to *Additional Boards Manager URLs*:

```
https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
```

Then: Tools → Board → Boards Manager → search **esp32** → Install.

### 2. Install libraries

Tools → Manage Libraries → search and install:
- `Adafruit NeoPixel`
- `ArduinoJson` (by Benoit Blanchon)

### 3. Choose a mode

Open `firmware/moonlamp/moonlamp.ino`. At the top, uncomment **one** mode:

```cpp
#define MODE_WIFI   // connects to WiFi and polls your server
//#define MODE_USB  // no WiFi — receives commands over USB serial (great for testing)
```

### 4. Configure the firmware (MODE_WIFI)

Edit the WiFi / server section:

```cpp
const char* WIFI_SSID     = "your_wifi_name";
const char* WIFI_PASSWORD = "your_wifi_password";
const char* ACCOUNT_ID    = "";         // paste your Vault ID here to use your saved config
                                        // leave empty to use the default account

// Option A: Render (recommended) — use your Render URL, no port needed
const char* SERVER_HOST   = "moonlamp-xxxx.onrender.com";
const bool  USE_HTTPS     = true;

// Option B: Local — your computer's local IP (ipconfig / ifconfig)
// const char* SERVER_HOST = "192.168.1.XXX";
// const bool  USE_HTTPS   = false;
```

### 5. Flash to ESP32

1. Plug ESP32 into your computer via USB
2. Tools → Board → select **ESP32 Dev Module**
3. Tools → Port → select the correct COM port
4. Click **Upload**
5. Open Serial Monitor at **115200 baud** to see connection logs

### USB mode (MODE_USB)

No WiFi needed. Send commands from the Arduino Serial Monitor or a script:

```
green 0.85 false
red 0.60 true
white 0.20 false
off
```

Format: `<color> <intensity 0–1> <alert true|false>`

---

## Lamp behavior

| State | Behavior |
|-------|----------|
| Connecting to WiFi | White slow blink |
| WiFi connected | Two green flashes |
| Green, small move | Dim slow breathe |
| Green, large move | Bright slow breathe |
| Red, small move | Dim slow breathe (red) |
| Red, large move | Bright slow breathe (red) |
| Alert triggered | Rapid 5Hz flash |
| Outside schedule hours | Off |
| Server unreachable | Brief dim red flash, then restores |

---

## Project Structure

```
MoonLamp/
├── backend/
│   ├── server.js          # Express API + price fetching + account storage
│   ├── package.json
│   └── .env.example       # Copy to .env and add keys
├── frontend/
│   ├── index.html         # Y2K web UI
│   ├── style.css
│   └── app.js
├── firmware/
│   └── moonlamp/
│       └── moonlamp.ino   # ESP32 Arduino sketch (MODE_WIFI / MODE_USB)
└── render.yaml            # Render deployment blueprint
```

---

## API Reference

The ESP32 polls one endpoint. Pass your Vault ID as a query param to use your saved config:

```
GET /api/color?account=<vault-id>
```

```json
{
  "color": "green",
  "intensity": 0.72,
  "alert": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `color` | `"green"` \| `"red"` \| `"white"` \| `"off"` | Lamp color (`"off"` when outside schedule) |
| `intensity` | `0.0 – 1.0` | Brightness level (scales with move size) |
| `alert` | `boolean` | `true` triggers rapid flash mode |

Other endpoints (used by the web UI):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/account/new` | Generate a new Vault ID |
| `GET` | `/api/status` | Full state + config for an account |
| `POST` | `/api/config` | Update tracking config |
| `GET` | `/api/search/crypto?q=` | Search CoinGecko by name |
| `POST` | `/api/mood` | Log a mood entry |
| `GET` | `/api/moods` | Fetch recent mood log |

---

## Data Sources

| Mode | Source | API Key |
|------|--------|---------|
| Crypto | [CoinGecko](https://coingecko.com) | None required (optional key reduces rate limits) |
| Stocks | Yahoo Finance (`yahoo-finance2`) | None required |
| EVM Wallet | [Zerion](https://zerion.io) | Free key required |
