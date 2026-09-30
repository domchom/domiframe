// DomiFrame firmware for XIAO ePaper Display Board EE04 + 7.3" E Ink Spectra 6 (800x480).
//
// Each wake: connect to Wi-Fi -> GET /api/frames/<id>/image (with ETag) ->
// redraw only if the picture changed -> deep sleep for as long as the server says
// (X-Sleep-Minutes), so check-in times, quiet hours and picture rotation are set on the server.
//
// First boot (or hold KEY3 while resetting): opens a Wi-Fi setup portal
// "DomiFrame-Setup" where you enter the home Wi-Fi plus the frame ID and device key.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <SPI.h>
#include <GxEPD2_7C.h>
#include <Fonts/FreeSansBold18pt7b.h>
#include <Fonts/FreeSans12pt7b.h>
#include <driver/rtc_io.h>
#include "config.h"

static const int W = 800, H = 480;
static const size_t IMAGE_BYTES = W * H / 2;

// Palette index order must match web/dither.js
static const uint16_t PALETTE[6] = {GxEPD_BLACK, GxEPD_WHITE, GxEPD_YELLOW, GxEPD_RED, GxEPD_BLUE, GxEPD_GREEN};

// GDEP073E01 uses the same ED2208 controller as Seeed's 7.3" Spectra 6 panel.
GxEPD2_7C<GxEPD2_730c_GDEP073E01, GxEPD2_730c_GDEP073E01::HEIGHT / 4>
    display(GxEPD2_730c_GDEP073E01(EPD_CS, EPD_DC, EPD_RST, EPD_BUSY));

Preferences prefs;
String frameId, deviceKey, etag;
uint32_t sleepMinutes = SLEEP_MINUTES;  // replaced by the server's X-Sleep-Minutes
// How the frame hangs: "landscape" or "portrait". Chosen in the setup portal (sent to the server
// until it confirms), otherwise whatever the server says (set on the website). Pictures arrive
// already turned for it; this only decides which way up our own messages are drawn.
String orientation = "landscape";
bool orientationPending = false;

// ---------------------------------------------------------------------------

void displayBegin() {
  pinMode(EPD_ENABLE, OUTPUT);
  digitalWrite(EPD_ENABLE, HIGH);
  delay(10);
  display.init(115200, true, 2, false);
  display.setRotation(0);
}

void showMessage(const char* title, const char* line1, const char* line2 = nullptr) {
  displayBegin();
  display.setFullWindow();
  display.firstPage();
  do {
    display.setRotation(orientation == "portrait" ? 1 : 0);  // upright on a portrait-hung frame
    display.fillScreen(GxEPD_WHITE);
    display.setTextColor(GxEPD_BLACK);
    display.setFont(&FreeSansBold18pt7b);
    display.setCursor(40, 120);
    display.print(title);
    display.setFont(&FreeSans12pt7b);
    display.setCursor(40, 190);
    display.print(line1);
    if (line2) {
      display.setCursor(40, 230);
      display.print(line2);
    }
    display.fillRect(40, 400, 60, 12, GxEPD_RED);
    display.fillRect(100, 400, 60, 12, GxEPD_YELLOW);
    display.fillRect(160, 400, 60, 12, GxEPD_GREEN);
    display.fillRect(220, 400, 60, 12, GxEPD_BLUE);
  } while (display.nextPage());
  display.hibernate();
}

void drawPacked(const uint8_t* buf) {
  displayBegin();  // rotation 0: the picture's bytes are already in panel order
  display.setFullWindow();
  display.firstPage();
  do {
    for (int y = 0; y < H; y++) {
      const uint8_t* row = buf + (size_t)y * (W / 2);
      for (int x = 0; x < W; x += 2) {
        uint8_t b = row[x >> 1];
        display.drawPixel(x, y, PALETTE[(b >> 4) % 6]);
        display.drawPixel(x + 1, y, PALETTE[(b & 0x0F) % 6]);
      }
    }
  } while (display.nextPage());
  display.hibernate();
}

int readBatteryMv() {
  pinMode(BAT_ADC_ENABLE_PIN, OUTPUT);
  digitalWrite(BAT_ADC_ENABLE_PIN, HIGH);
  delay(10);
  analogReadResolution(12);
  uint32_t sum = 0;
  for (int i = 0; i < 8; i++) sum += analogRead(BAT_ADC_PIN);
  digitalWrite(BAT_ADC_ENABLE_PIN, LOW);
  return (int)((sum / 8.0f) / 4096.0f * BAT_SCALE * 1000.0f);
}

// ---------------------------------------------------------------------------

void loadSettings() {
  prefs.begin("domiframe", true);
  frameId = prefs.getString("id", "");
  deviceKey = prefs.getString("key", "");
  etag = prefs.getString("etag", "");
  orientation = prefs.getString("orient", "landscape");
  orientationPending = prefs.getBool("orientSet", false);
  prefs.end();
}

void saveString(const char* k, const String& v) {
  prefs.begin("domiframe", false);
  prefs.putString(k, v);
  prefs.end();
}

void saveOrientationPending(bool pending) {
  orientationPending = pending;
  prefs.begin("domiframe", false);
  prefs.putBool("orientSet", pending);
  prefs.end();
}

bool runSetupPortal() {
  showMessage("Wi-Fi setup", "On your phone, join the Wi-Fi",
              "\"" SETUP_AP_NAME "\" to set me up.");

  WiFiManager wm;
  WiFiManagerParameter pId("id", "Frame ID", frameId.c_str(), 32);
  WiFiManagerParameter pKey("key", "Device key", deviceKey.c_str(), 64);
  // WiFiManager only has text fields: a hidden one holds the value, a dropdown fills it in.
  WiFiManagerParameter pOrient("orient", "", orientation.c_str(), 10, "type='hidden'");
  bool portrait = orientation == "portrait";
  String pickHtml = String("<br><label for='orientPick'>How the frame hangs</label>"
                           "<select id='orientPick' onchange=\"document.getElementById('orient').value=this.value\">"
                           "<option value='landscape'") + (portrait ? "" : " selected") + ">Landscape (wide)</option>"
                           "<option value='portrait'" + (portrait ? " selected" : "") + ">Portrait (tall)</option></select>";
  WiFiManagerParameter pOrientPick(pickHtml.c_str());
  wm.addParameter(&pId);
  wm.addParameter(&pKey);
  wm.addParameter(&pOrientPick);
  wm.addParameter(&pOrient);
  wm.setConfigPortalTimeout(SETUP_PORTAL_TIMEOUT_S);
  wm.setBreakAfterConfig(true);

  bool ok = wm.startConfigPortal(SETUP_AP_NAME);
  if (strlen(pId.getValue())) {
    frameId = pId.getValue();
    saveString("id", frameId);
  }
  if (strlen(pKey.getValue())) {
    deviceKey = pKey.getValue();
    saveString("key", deviceKey);
  }
  String o = pOrient.getValue();
  if (o == "landscape" || o == "portrait") {
    orientation = o;
    saveString("orient", orientation);
    saveOrientationPending(true);  // tell the server at the next check-in
  }
  // force a redraw after setup
  etag = "";
  saveString("etag", etag);
  return ok && WiFi.status() == WL_CONNECTED;
}

bool connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin();  // credentials stored by WiFiManager
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) delay(200);
  return WiFi.status() == WL_CONNECTED;
}

// Returns true if a new picture was drawn.
bool fetchAndDraw(int batteryMv) {
  WiFiClientSecure client;
  // TODO: pin the Let's Encrypt root CA (ISRG Root X1) instead of skipping verification.
  client.setInsecure();

  HTTPClient http;
  String url = String(SERVER_BASE) + "/api/frames/" + frameId + "/image";
  if (!http.begin(client, url)) return false;
  http.setTimeout(20000);
  http.addHeader("X-Device-Key", deviceKey);
  http.addHeader("X-Battery-Mv", String(batteryMv));
  http.addHeader("X-Fw", FW_VERSION);
  if (etag.length()) http.addHeader("If-None-Match", etag);
  if (orientationPending) http.addHeader("X-Set-Orientation", orientation);
  const char* keep[] = {"ETag", "X-Sleep-Minutes", "X-Orientation"};
  http.collectHeaders(keep, 3);

  int code = http.GET();
  Serial.printf("GET %s -> %d\n", url.c_str(), code);

  long mins = http.header("X-Sleep-Minutes").toInt();  // 0 if missing
  if (mins >= MIN_SLEEP_MINUTES && mins <= MAX_SLEEP_MINUTES) sleepMinutes = (uint32_t)mins;

  if (code == 200 || code == 204 || code == 304) {
    if (orientationPending) saveOrientationPending(false);  // the server has it now
    String o = http.header("X-Orientation");
    if ((o == "landscape" || o == "portrait") && o != orientation) {
      orientation = o;  // changed on the website
      saveString("orient", orientation);
    }
  }

  if (code == 401 || code == 404) {
    http.end();
    showMessage("Frame not registered", "Hold KEY3 and press reset", "to re-enter the frame ID and key.");
    return false;
  }
  if (code != 200) {  // 304 unchanged, 204 nothing uploaded yet, or error
    http.end();
    return false;
  }

  int len = http.getSize();  // -1 if the response is chunked
  if (len != -1 && len != (int)IMAGE_BYTES) {
    Serial.printf("unexpected size %d\n", len);
    http.end();
    return false;
  }

  uint8_t* buf = (uint8_t*)ps_malloc(IMAGE_BYTES);
  if (!buf) buf = (uint8_t*)malloc(IMAGE_BYTES);
  if (!buf) {
    http.end();
    return false;
  }

  WiFiClient* stream = http.getStreamPtr();
  size_t got = 0;
  uint32_t last = millis();
  while (got < IMAGE_BYTES && millis() - last < 15000) {
    int n = stream->read(buf + got, IMAGE_BYTES - got);
    if (n > 0) {
      got += n;
      last = millis();
    } else {
      delay(5);
    }
  }
  String newEtag = http.header("ETag");
  http.end();

  if (got != IMAGE_BYTES) {
    Serial.printf("short read %u\n", (unsigned)got);
    free(buf);
    return false;
  }

  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);  // save power during the ~20 s refresh
  drawPacked(buf);
  free(buf);

  etag = newEtag;
  saveString("etag", etag);
  return true;
}

void goToSleep() {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  digitalWrite(EPD_ENABLE, LOW);

  esp_sleep_enable_timer_wakeup((uint64_t)sleepMinutes * 60ULL * 1000000ULL);
  rtc_gpio_pullup_en((gpio_num_t)BTN_REFRESH);
  rtc_gpio_pulldown_dis((gpio_num_t)BTN_REFRESH);
  esp_sleep_enable_ext1_wakeup(1ULL << BTN_REFRESH, ESP_EXT1_WAKEUP_ANY_LOW);  // ESP32-S3: any IDF version

  Serial.printf("sleeping %u min\n", (unsigned)sleepMinutes);
  Serial.flush();
  esp_deep_sleep_start();
}

// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(200);
  pinMode(BTN_SETUP, INPUT_PULLUP);
  pinMode(BTN_REFRESH, INPUT_PULLUP);

  loadSettings();
  bool wantSetup = frameId.isEmpty() || deviceKey.isEmpty() || digitalRead(BTN_SETUP) == LOW;

  bool online = wantSetup ? runSetupPortal() : connectWifi();
  if (!online) {
    if (wantSetup) showMessage("Setup timed out", "Press reset to try again.");
    // Otherwise keep the current picture and retry at the next wake.
    goToSleep();
  }

  int mv = readBatteryMv();
  Serial.printf("frame=%s battery=%dmV etag=%s\n", frameId.c_str(), mv, etag.c_str());

  bool drew = fetchAndDraw(mv);
  if (!drew && wantSetup) {
    showMessage("Connected!", "Send a picture from your upload link.");
  }
  goToSleep();
}

void loop() {}
