/*
 * Moonlamp Firmware
 * Target:   ESP32 (any dev board)
 * LED:      Adafruit NeoPixel Ring 16 (WS2812B, 16 pixels)
 * Libraries (install via Arduino Library Manager):
 *   - Adafruit NeoPixel
 *   - ArduinoJson  (by Benoit Blanchon)
 *
 * Wiring:
 *   Ring PWR  → ESP32 5V (or VIN)
 *   Ring GND  → ESP32 GND
 *   Ring DIN  → ESP32 GPIO 5
 *
 * /api/color response:
 *   { "color": "green", "intensity": 0.85, "alert": false }
 *
 *   intensity (0.0–1.0) → NeoPixel brightness
 *   alert = true        → rapid flash instead of slow breathe
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Adafruit_NeoPixel.h>

// ── Configuration — FILL THESE IN ────────────────────────────────────────────

const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Local IP of the machine running the Node.js server
// Find it: Windows → ipconfig | Mac/Linux → ifconfig
const char* SERVER_HOST   = "192.168.1.XXX";
const int   SERVER_PORT   = 3000;

// ── Hardware ──────────────────────────────────────────────────────────────────

#define DATA_PIN      4     // GPIO pin → ring DIN
#define NUM_PIXELS    16    // NeoPixel Ring 16
#define MAX_BRIGHTNESS 160  // 0–255. Keep ≤ 160 on USB power to avoid current issues.

#define POLL_INTERVAL_MS 60000  // 60 seconds between server checks

// ── Globals ───────────────────────────────────────────────────────────────────

Adafruit_NeoPixel ring(NUM_PIXELS, DATA_PIN, NEO_GRB + NEO_KHZ800);

unsigned long lastPoll = 0;

// Current values from last server response
String  currentColor    = "white";
float   currentIntensity = 0.2f;
bool    currentAlert    = false;

// ── Color helpers ─────────────────────────────────────────────────────────────

struct RGB { uint8_t r, g, b; };

RGB colorForState(const String& color) {
  if (color == "green") return { 0,   200,  50  };
  if (color == "red")   return { 220, 20,   20  };
  return                       { 160, 160,  220 }; // white/moonlight
}

// Sets every pixel to rgb scaled by brightnessScale (0.0–1.0)
void setAll(RGB c, float brightnessScale) {
  brightnessScale = constrain(brightnessScale, 0.0f, 1.0f);
  uint8_t r = (uint8_t)(c.r * brightnessScale);
  uint8_t g = (uint8_t)(c.g * brightnessScale);
  uint8_t b = (uint8_t)(c.b * brightnessScale);
  for (int i = 0; i < NUM_PIXELS; i++) ring.setPixelColor(i, ring.Color(r, g, b));
  ring.show();
}

// ── Animations ────────────────────────────────────────────────────────────────

/*
 * Slow sine-wave breathe. Modulates brightness between 15% and intensity.
 * Call every loop() iteration — returns true once per full cycle.
 */
bool breathe() {
  static uint16_t step = 0;
  static unsigned long lastStep = 0;

  if (millis() - lastStep < 10) return false;
  lastStep = millis();

  // sin over 0→2π gives 0→1→0
  float t = step / 628.0f; // 628 steps ≈ 2π * 100
  float wave = 0.5f - 0.5f * cosf(t * 2.0f * PI);
  float minBright = 0.08f;
  float brightness = minBright + (currentIntensity - minBright) * wave;

  RGB c = colorForState(currentColor);
  setAll(c, brightness);

  step = (step + 1) % 629;
  return (step == 0);
}

/*
 * Rapid alert flash — alternates full brightness ↔ off at 5Hz.
 * The slow breathe is completely replaced while alert is active.
 */
void alertFlash() {
  static unsigned long lastFlip = 0;
  static bool on = true;
  if (millis() - lastFlip < 100) return; // 100ms = 5Hz
  lastFlip = millis();
  on = !on;
  RGB c = colorForState(currentColor);
  setAll(c, on ? currentIntensity : 0.05f);
}

// ── WiFi ──────────────────────────────────────────────────────────────────────

void connectWifi() {
  Serial.print("Connecting to WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  RGB white = { 160, 160, 220 };
  bool blink = false;
  while (WiFi.status() != WL_CONNECTED) {
    blink = !blink;
    setAll(white, blink ? 0.25f : 0.0f);
    delay(500);
    Serial.print(".");
  }

  Serial.printf("\nConnected! IP: %s\n", WiFi.localIP().toString().c_str());

  // Two quick green flashes on success
  RGB green = { 0, 200, 50 };
  for (int i = 0; i < 2; i++) {
    setAll(green, 0.8f); delay(200);
    setAll(green, 0.0f); delay(150);
  }
}

// ── HTTP poll ─────────────────────────────────────────────────────────────────

void pollServer() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost, reconnecting…");
    connectWifi();
    return;
  }

  String url = String("http://") + SERVER_HOST + ":" + SERVER_PORT + "/api/color";
  Serial.println("Polling: " + url);

  HTTPClient http;
  http.begin(url);
  http.setTimeout(10000);

  int code = http.GET();
  if (code == 200) {
    String body = http.getString();
    Serial.println("Response: " + body);

    StaticJsonDocument<128> doc;
    if (deserializeJson(doc, body) == DeserializationError::Ok) {
      currentColor     = doc["color"].as<String>();
      currentIntensity = doc["intensity"] | 0.5f;
      currentAlert     = doc["alert"]     | false;

      // Scale intensity against max brightness
      ring.setBrightness((uint8_t)(MAX_BRIGHTNESS * currentIntensity));

      Serial.printf("color=%s intensity=%.2f alert=%s\n",
        currentColor.c_str(), currentIntensity, currentAlert ? "YES" : "no");

      // Apply immediately (animation will take over in loop())
      RGB c = colorForState(currentColor);
      setAll(c, currentIntensity);
    } else {
      Serial.println("JSON parse error");
    }
  } else {
    Serial.printf("HTTP error: %d\n", code);
    // Brief dim flash to signal error, then restore
    RGB err = { 100, 0, 0 };
    setAll(err, 0.3f);
    delay(300);
    RGB c = colorForState(currentColor);
    setAll(c, currentIntensity);
  }

  http.end();
}

// ── Arduino entry points ──────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  delay(300);

  ring.begin();
  ring.setBrightness(MAX_BRIGHTNESS);
  ring.clear();
  ring.show();

  connectWifi();
  pollServer();
  lastPoll = millis();
}

void loop() {
  // Animate
  if (currentAlert) {
    alertFlash();
  } else {
    breathe();
  }

  // Poll on schedule (non-blocking — animation keeps running between polls)
  if (millis() - lastPoll >= POLL_INTERVAL_MS) {
    lastPoll = millis();
    pollServer();
  }
}
