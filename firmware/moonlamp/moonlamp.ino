/*
 * Moonlamp Firmware
 * Target:   ESP32 (any dev board)
 * LED:      Adafruit NeoPixel Ring 16 (WS2812B, 16 pixels)
 * Libraries (install via Arduino Library Manager):
 *   - Adafruit NeoPixel
 *   - ArduinoJson  (by Benoit Blanchon)
 *
 * Wiring:
 *   Ring PWR  → ESP32 VIN (5V)
 *   Ring GND  → ESP32 GND
 *   Ring DIN  → ESP32 GPIO 4
 *
 * ── MODE SELECT ──────────────────────────────────────────────────────────────
 * Uncomment ONE mode below.
 *
 *   MODE_WIFI  — connects to WiFi, polls your Render (or local) server
 *   MODE_USB   — no WiFi needed; receives color commands over USB serial
 *                from your computer (great for testing / no WiFi situations)
 */

#define MODE_WIFI
 //define MODE_USB

// ── WiFi / server config (MODE_WIFI only) ────────────────────────────────────

#ifdef MODE_WIFI

const char* WIFI_SSID     = "moonlamp";
const char* WIFI_PASSWORD = "123456789";
const char* ACCOUNT_ID    = "9c02728c-be3f-4314-a237-6f6371a0b3d5";
// ── Option A: Render (recommended) ───────────────────────────────────────────
// Use your Render URL — no port needed, HTTPS handled automatically.
// Example: "moonlamp-xxxx.onrender.com"
const char* SERVER_HOST   = "moonlamp.onrender.com";
const bool  USE_HTTPS     = true;


#endif // MODE_WIFI

// ── Hardware ──────────────────────────────────────────────────────────────────

#define DATA_PIN       4    // GPIO pin → ring DIN
#define NUM_PIXELS    16    // NeoPixel Ring 16
#define MAX_BRIGHTNESS 160  // 0–255 — keep ≤ 160 on USB power

#define POLL_INTERVAL_MS 60000  // ms between server polls (WiFi mode)

// ── Includes ──────────────────────────────────────────────────────────────────

#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>

#ifdef MODE_WIFI
  #include <WiFi.h>
  #include <HTTPClient.h>
  #include <WiFiClientSecure.h>
#endif

// ── Globals ───────────────────────────────────────────────────────────────────

Adafruit_NeoPixel ring(NUM_PIXELS, DATA_PIN, NEO_GRB + NEO_KHZ800);

String  currentColor     = "white";
float   currentIntensity = 0.2f;
bool    currentAlert     = false;
String  prevColor        = "white";
float   prevIntensity    = 0.2f;

#ifdef MODE_WIFI
  unsigned long lastPoll = 0;
#endif

// ── Color helpers ─────────────────────────────────────────────────────────────

struct RGB { uint8_t r, g, b; };

RGB colorForState(const String& color) {
  if (color == "green") return {   0, 200,  50 };
  if (color == "red")   return { 220,  20,  20 };
  return                       { 160, 160, 220 }; // white/moonlight
}

void setAll(RGB c, float brightnessScale) {
  brightnessScale = constrain(brightnessScale, 0.0f, 1.0f);
  for (int i = 0; i < NUM_PIXELS; i++)
    ring.setPixelColor(i, ring.Color(
      (uint8_t)(c.r * brightnessScale),
      (uint8_t)(c.g * brightnessScale),
      (uint8_t)(c.b * brightnessScale)
    ));
  ring.show();
}

// ── Fade transition ───────────────────────────────────────────────────────────

void fadeToColor(RGB from, float fromBright, RGB to, float toBright, int durationMs) {
  const int steps = durationMs / 10;
  for (int i = 0; i <= steps; i++) {
    float t = (float)i / steps;
    RGB blended = {
      (uint8_t)(from.r + (to.r - from.r) * t),
      (uint8_t)(from.g + (to.g - from.g) * t),
      (uint8_t)(from.b + (to.b - from.b) * t)
    };
    setAll(blended, fromBright + (toBright - fromBright) * t);
    delay(10);
  }
}

// ── Animations ────────────────────────────────────────────────────────────────

void showSolid() {
  static String lastColor = "";
  static float  lastIntensity = -1;
  if (currentColor == lastColor && currentIntensity == lastIntensity) return;
  setAll(colorForState(currentColor), currentIntensity);
  lastColor     = currentColor;
  lastIntensity = currentIntensity;
}

void alertFlash() {
  static unsigned long lastFlip = 0;
  static bool on = true;
  if (millis() - lastFlip < 100) return;
  lastFlip = millis();
  on = !on;
  setAll(colorForState(currentColor), on ? currentIntensity : 0.05f);
}

// ── Apply a new color state ───────────────────────────────────────────────────

void applyState(String newColor, float newIntensity, bool newAlert) {
  if (newColor == "off") {
    currentColor = "off";
    ring.clear();
    ring.show();
    return;
  }
  ring.setBrightness((uint8_t)(MAX_BRIGHTNESS * newIntensity));
  fadeToColor(colorForState(prevColor), prevIntensity,
              colorForState(newColor),  newIntensity, 800);
  prevColor        = newColor;
  prevIntensity    = newIntensity;
  currentColor     = newColor;
  currentIntensity = newIntensity;
  currentAlert     = newAlert;
}

// ═════════════════════════════════════════════════════════════════════════════
// MODE_WIFI
// ═════════════════════════════════════════════════════════════════════════════

#ifdef MODE_WIFI

void connectWifi() {
  Serial.printf("Connecting to WiFi SSID: \"%s\"\n", WIFI_SSID);
  WiFi.persistent(false);   // don't save credentials to flash
  WiFi.disconnect(true);    // clear any stale connection
  delay(200);
  WiFi.mode(WIFI_STA);
  delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  RGB white = { 160, 160, 220 };
  bool blink = false;
  int attempts = 0;

  while (WiFi.status() != WL_CONNECTED) {
    blink = !blink;
    setAll(white, blink ? 0.25f : 0.0f);
    delay(500);
    attempts++;
    Serial.printf(". [%d] status=%d\n", attempts, (int)WiFi.status());
    // After 40 attempts (~20s) restart and try again
    if (attempts >= 40) {
      Serial.println("\nCould not connect — restarting...");
      ESP.restart();
    }
  }
  Serial.printf("\nConnected! IP: %s\n", WiFi.localIP().toString().c_str());
  RGB green = { 0, 200, 50 };
  for (int i = 0; i < 2; i++) { setAll(green, 0.8f); delay(200); setAll(green, 0.0f); delay(150); }
}

void pollServer() {
  if (WiFi.status() != WL_CONNECTED) { connectWifi(); return; }

  String url = String(USE_HTTPS ? "https://" : "http://") + SERVER_HOST + "/api/color";
  if (strlen(ACCOUNT_ID) > 0) url += String("?account=") + ACCOUNT_ID;
  Serial.println("Polling: " + url);

  HTTPClient http;
  WiFiClientSecure secureClient;
  if (USE_HTTPS) {
    secureClient.setInsecure(); // skip cert verification (fine for personal use)
    http.begin(secureClient, url);
  } else {
    http.begin(url);
  }
  http.setTimeout(10000);

  int code = http.GET();
  if (code == 200) {
    String body = http.getString();
    Serial.println("Response: " + body);
    StaticJsonDocument<128> doc;
    if (deserializeJson(doc, body) == DeserializationError::Ok) {
      applyState(
        doc["color"].as<String>(),
        doc["intensity"] | 0.5f,
        doc["alert"]     | false
      );
    }
  } else {
    Serial.printf("HTTP error: %d\n", code);
    RGB err = { 100, 0, 0 };
    setAll(err, 0.3f); delay(300);
    setAll(colorForState(currentColor), currentIntensity);
  }
  http.end();
}

#endif // MODE_WIFI

// ═════════════════════════════════════════════════════════════════════════════
// MODE_USB — receive commands from computer over serial
//
// Send lines from your computer via Serial Monitor or a script:
//   green 0.85 false
//   red 0.60 true
//   white 0.20 false
//   off
//
// A helper script (run on your computer):
//   node -e "
//     const { SerialPort } = require('serialport');
//     const port = new SerialPort({ path: 'COM3', baudRate: 115200 });
//     fetch('http://localhost:3000/api/color')
//       .then(r => r.json())
//       .then(d => port.write(d.color+' '+d.intensity+' '+d.alert+'\n'));
//   "
// ═════════════════════════════════════════════════════════════════════════════

#ifdef MODE_USB

String serialBuffer = "";

void readSerialCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      serialBuffer.trim();
      if (serialBuffer.length() > 0) {
        Serial.println("CMD: " + serialBuffer);
        if (serialBuffer == "off") {
          applyState("off", 0, false);
        } else {
          // Parse: "color intensity alert"  e.g. "green 0.85 false"
          int s1 = serialBuffer.indexOf(' ');
          int s2 = serialBuffer.lastIndexOf(' ');
          if (s1 > 0 && s2 > s1) {
            String col   = serialBuffer.substring(0, s1);
            float  inten = serialBuffer.substring(s1 + 1, s2).toFloat();
            bool   alrt  = serialBuffer.substring(s2 + 1) == "true";
            applyState(col, inten, alrt);
          }
        }
      }
      serialBuffer = "";
    } else {
      serialBuffer += c;
    }
  }
}

#endif // MODE_USB

// ═════════════════════════════════════════════════════════════════════════════
// Arduino entry points
// ═════════════════════════════════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  delay(300);
  ring.begin();
  ring.setBrightness(MAX_BRIGHTNESS);
  ring.clear();
  ring.show();

#ifdef MODE_WIFI
  connectWifi();
  pollServer();
  lastPoll = millis();
  Serial.println("Running in WIFI mode");
#endif

#ifdef MODE_USB
  Serial.println("Running in USB mode — send: 'green 0.85 false'");
  Serial.println("Commands: green/red/white/off  intensity(0-1)  alert(true/false)");
#endif
}

void loop() {
  // Off state — ring dark, keep polling for updates
  if (currentColor == "off") {
    ring.clear();
    ring.show();
#ifdef MODE_WIFI
    delay(1000);
    if (millis() - lastPoll >= POLL_INTERVAL_MS) { lastPoll = millis(); pollServer(); }
#endif
#ifdef MODE_USB
    readSerialCommands();
    delay(50);
#endif
    return;
  }

  // Normal animation
  if (currentAlert) alertFlash();
  else              showSolid();

#ifdef MODE_WIFI
  if (millis() - lastPoll >= POLL_INTERVAL_MS) { lastPoll = millis(); pollServer(); }
#endif

#ifdef MODE_USB
  readSerialCommands();
#endif
}
