# MOONLAMP

> A physical LED lamp that glows **green** or **red** based on a crypto/stock price or your EVM wallet portfolio — with brightness scaling to signal intensity and a rapid flash alert mode.

Built with an ESP32 + Adafruit NeoPixel Ring 16, a Node.js backend, and a simple website to control it.

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
- **Alert mode** = rapid 5Hz flash when move exceeds your threshold (default 5%)

---

## Hardware

| Part | Link / Notes |
|------|-------------|
| ESP32 dev board | Any standard ESP32 dev board |
| Adafruit NeoPixel Ring 16 | 16x WS2812B RGB LEDs |
| USB cable | For power + programming |

### Wiring

```
NeoPixel Ring    ESP32
─────────────    ─────
PWR          →   5V (or VIN)
GND          →   GND
DIN          →   GPIO 5
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

PORT=3000
REFRESH_INTERVAL_MS=60000
```

> Crypto and stock tracking work with **no API key**. You only need the Zerion key for wallet portfolio mode.

### 4. Start the server

```bash
npm start
```

Open **http://localhost:3000** in your browser.

---

## Using the Web UI

1. **Asset Price mode** — search for a crypto (Bitcoin, Ethereum, Solana…) or enter a stock ticker (AAPL, TSLA, SPY…) and click `[ EXECUTE_TRACK ]` or create budles of tickers with weighted allocation
2. **EVM Wallet mode** — paste a `0x…` address. Uses the Zerion API to fetch your full multi-token portfolio value and real 24h P&L
3. **Alert Threshold** — drag the slider to set the % move that triggers rapid flash mode on the lamp. Default is 5%.

Prices refresh every 60 seconds automatically.

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

### 3. Configure the firmware

Open `firmware/moonlamp/moonlamp.ino` and edit the top section:

```cpp
const char* WIFI_SSID     = "your_wifi_name";
const char* WIFI_PASSWORD = "your_wifi_password";

// Your computer's local IP (run ipconfig on Windows / ifconfig on Mac)
const char* SERVER_HOST   = "192.168.1.XXX";
const int   SERVER_PORT   = 3000;
```

### 4. Flash to ESP32

1. Plug ESP32 into your computer via USB
2. Tools → Board → select **ESP32 Dev Module**
3. Tools → Port → select the correct COM port
4. Click **Upload**
5. Open Serial Monitor at **115200 baud** to see connection logs

### What the lamp does

| State | Behavior |
|-------|----------|
| Connecting to WiFi | White slow blink |
| WiFi connected | Two green flashes |
| Green, small move | Dim slow breathe |
| Green, large move | Bright slow breathe |
| Red, small move | Dim slow breathe (red) |
| Red, large move | Bright slow breathe (red) |
| Alert triggered | Rapid 5Hz flash |
| Server unreachable | Brief dim red flash, then restores |

---

## Project Structure

```
MoonLamp/
├── backend/
│   ├── server.js          # Express API server
│   ├── package.json
│   └── .env.example       # Copy to .env and add keys
├── frontend/
│   ├── index.html         # Y2K web UI
│   ├── style.css
│   └── app.js
└── firmware/
    └── moonlamp/
        └── moonlamp.ino   # ESP32 Arduino sketch
```

---

## API Reference

The ESP32 polls one endpoint:

```
GET /api/color
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
| `color` | `"green"` \| `"red"` \| `"white"` | Lamp color |
| `intensity` | `0.0 – 1.0` | Brightness level (scales with move size) |
| `alert` | `boolean` | `true` triggers rapid flash mode |

---

## Data Sources

| Mode | Source | API Key |
|------|--------|---------|
| Crypto | [CoinGecko](https://coingecko.com) | None required |
| Stocks | Yahoo Finance (`yahoo-finance2`) | None required |
| EVM Wallet | [Zerion](https://zerion.io) | Free key required |
