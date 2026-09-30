// DomiFrame firmware for Seeed's XIAO ePaper Display Boards:
//   env ee04        EE04 + 7.3" E Ink Spectra 6 (800x480), GxEPD2
//   env ee02-13in3  EE02 + 13.3" E Ink Spectra 6 (1200x1600), Seeed_GFX
//
// Each wake: connect to Wi-Fi -> GET /api/frames/<id>/image (with ETag) ->
// redraw only if the picture changed -> deep sleep for as long as the server says
// (X-Sleep-Minutes), so check-in times, quiet hours and picture rotation are set on the server.
//
// First boot (or hold KEY3 while resetting): opens a Wi-Fi setup portal
// "DomiFrame-Setup" (password shown on the screen) where you enter the home Wi-Fi plus the
// frame ID and device key.
//
// Frame code: the frame makes its own random code (like K7PX-92QD-M4TR-8WZN) and shows it on
// its screen; people type it on the website to send pictures. Pictures are sealed in their
// browser with a key derived from the code (web/seal.js), so the server only ever has
// ciphertext; the frame derives the same key and opens them here. The server only gets the
// SHA-256 of a separate access token derived from the code (POST /api/frames/<id>/code).
// Hold KEY1 while pressing reset to show the code again; the setup portal can make a new one.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <SPI.h>
#include <esp_wifi.h>
#include <driver/rtc_io.h>
#include <esp_system.h>
#include <mbedtls/md.h>
#include <mbedtls/gcm.h>
#include <mbedtls/base64.h>
#include <qrcode.h>  // ESP-IDF's QR encoder
#include "config.h"

// ---- Screen -----------------------------------------------------------------
// W x H is the panel's own pixel layout, which is the order the server sends pictures in.
// Palette index order must match web/dither.js: black, white, yellow, red, blue, green.

#if defined(DOMIFRAME_PANEL_13IN3)
#include <TFT_eSPI.h>  // Seeed_GFX, configured by BOARD_SCREEN_COMBO=510 in platformio.ini
#define PANEL_ID "13.3"
static const int W = 1200, H = 1600;
static const bool NATIVE_PORTRAIT = true;
static const uint16_t PALETTE[6] = {TFT_BLACK, TFT_WHITE, TFT_YELLOW, TFT_RED, TFT_BLUE, TFT_GREEN};
EPaper epaper;
#else
#include <GxEPD2_7C.h>
#include <Fonts/FreeSansBold18pt7b.h>
#include <Fonts/FreeSans12pt7b.h>
#define PANEL_ID "7.3"
static const int W = 800, H = 480;
static const bool NATIVE_PORTRAIT = false;
static const uint16_t PALETTE[6] = {GxEPD_BLACK, GxEPD_WHITE, GxEPD_YELLOW, GxEPD_RED, GxEPD_BLUE, GxEPD_GREEN};
// GDEP073E01 uses the same ED2208 controller as Seeed's 7.3" Spectra 6 panel.
GxEPD2_7C<GxEPD2_730c_GDEP073E01, GxEPD2_730c_GDEP073E01::HEIGHT / 4>
    display(GxEPD2_730c_GDEP073E01(EPD_CS, EPD_DC, EPD_RST, EPD_BUSY));
#endif

static const size_t IMAGE_BYTES = (size_t)W * H / 2;
// Sealed download: IV (12) || ciphertext || GCM tag (16), see web/seal.js
static const size_t GCM_IV_BYTES = 12, GCM_TAG_BYTES = 16;
static const size_t SEALED_BYTES = GCM_IV_BYTES + IMAGE_BYTES + GCM_TAG_BYTES;

#if VERIFY_TLS
// Mozilla's root certificates (firmware/data/cert, made by tools/make_ca_bundle.py), so the
// frame trusts the server's certificate whichever CA issued it. Hosts switch between CAs,
// so a single pinned root would eventually lock every frame out.
extern const uint8_t CA_BUNDLE[] asm("_binary_data_cert_x509_crt_bundle_bin_start");
#endif

// Kept in RTC memory across deep sleep: the access point we joined last time, so the next wake
// can skip the Wi-Fi scan and connect straight away (the radio is the biggest battery drain).
RTC_DATA_ATTR uint8_t rtcBssid[6];
RTC_DATA_ATTR int32_t rtcChannel = 0;

Preferences prefs;
String frameId, deviceKey, etag;
String frameCode;          // XXXX-XXXX-XXXX-XXXX, made here, never sent anywhere
bool codePending = false;  // made but not yet registered with the server
uint32_t sleepMinutes = SLEEP_MINUTES;  // replaced by the server's X-Sleep-Minutes
// How the frame hangs: "landscape" or "portrait". Chosen in the setup portal (sent to the server
// until it confirms), otherwise whatever the server says (set on the website). Pictures arrive
// already turned for it; this only decides which way up our own messages are drawn.
String orientation = "landscape";
bool orientationPending = false;

// Hung the other way from how the panel's rows run: messages are turned to read upright
// (rotation 1, matching how the upload page turns pictures: web/dither.js toPanelOrder).
bool turned() { return (orientation == "portrait") != NATIVE_PORTRAIT; }

// ---- QR code ----------------------------------------------------------------
// ESP-IDF hands the finished code to a callback, so it's copied out here for drawing.

static const int QR_MAX = 57;  // version 10: plenty for a link with the frame ID and code
static bool qrDots[QR_MAX][QR_MAX];
static int qrSize = 0;

static void captureQr(esp_qrcode_handle_t qr) {
  qrSize = esp_qrcode_get_size(qr);
  if (qrSize > QR_MAX) qrSize = 0;
  for (int y = 0; y < qrSize; y++)
    for (int x = 0; x < qrSize; x++) qrDots[y][x] = esp_qrcode_get_module(qr, x, y);
}

// Returns the QR code's size in modules (0 if it couldn't be made); modules are in qrDots.
int makeQr(const char* text) {
  esp_qrcode_config_t cfg = ESP_QRCODE_CONFIG_DEFAULT();
  cfg.display_func = captureQr;
  cfg.max_qrcode_version = 10;
  cfg.qrcode_ecc_level = ESP_QRCODE_ECC_MED;
  qrSize = 0;
  if (esp_qrcode_generate(&cfg, text) != ESP_OK) qrSize = 0;
  return qrSize;
}

// Where the QR code goes on a w x h screen (after rotation) with `margin` around it: to the
// right of the text when the screen is wide, below the text and color bars when it's tall.
void qrPlace(int w, int h, int module, int margin, int& x, int& y) {
  int side = (qrSize + 8) * module;  // with the 4-module quiet zone all round
  if (w > h) {
    x = w - margin - side;
    y = (h - side) / 2;
  } else {
    x = (w - side) / 2;
    y = h - margin - side;
  }
  x += 4 * module;
  y += 4 * module;
}

// ---------------------------------------------------------------------------

void displayPower(bool on) {
  pinMode(EPD_ENABLE, OUTPUT);
  digitalWrite(EPD_ENABLE, on ? HIGH : LOW);
  if (on) delay(10);
}

#if defined(DOMIFRAME_PANEL_13IN3)

// qr: optional text to show as a QR code (made with makeQr first)
void showMessage(const char* title, const char* line1, const char* line2 = nullptr, bool qr = false) {
  displayPower(true);
  epaper.begin();
  epaper.setRotation(turned() ? 1 : 0);
  epaper.fillScreen(TFT_WHITE);
  epaper.setTextColor(TFT_BLACK, TFT_WHITE);
  epaper.setTextDatum(TL_DATUM);
  // The 7.3" layout, doubled
  epaper.setFreeFont(&FreeSansBold18pt7b);
  epaper.setTextSize(2);
  epaper.drawString(title, 80, 180);
  epaper.setFreeFont(&FreeSans12pt7b);
  epaper.drawString(line1, 80, 320);
  if (line2) epaper.drawString(line2, 80, 400);
  const uint16_t bars[4] = {TFT_RED, TFT_YELLOW, TFT_GREEN, TFT_BLUE};
  for (int i = 0; i < 4; i++) epaper.fillRect(80 + i * 120, 800, 120, 24, bars[i]);
  if (qr && qrSize) {
    const int m = 10;
    int qx, qy;
    qrPlace(epaper.width(), epaper.height(), m, 80, qx, qy);
    for (int y = 0; y < qrSize; y++)
      for (int x = 0; x < qrSize; x++)
        if (qrDots[y][x]) epaper.fillRect(qx + x * m, qy + y * m, m, m, TFT_BLACK);
  }
  epaper.update();
  epaper.sleep();
}

void drawPacked(const uint8_t* buf) {
  displayPower(true);
  epaper.begin();
  epaper.setRotation(0);  // the picture's bytes are already in panel order
  for (int y = 0; y < H; y++) {
    const uint8_t* row = buf + (size_t)y * (W / 2);
    for (int x = 0; x < W; x += 2) {
      uint8_t b = row[x >> 1];
      epaper.drawPixel(x, y, PALETTE[(b >> 4) % 6]);
      epaper.drawPixel(x + 1, y, PALETTE[(b & 0x0F) % 6]);
    }
  }
  epaper.update();
  epaper.sleep();
}

#else  // 7.3"

void displayBegin() {
  displayPower(true);
  display.init(115200, true, 2, false);
  display.setRotation(0);
}

// qr: draw the QR code made by makeQr as well
void showMessage(const char* title, const char* line1, const char* line2 = nullptr, bool qr = false) {
  displayBegin();
  display.setFullWindow();
  display.firstPage();
  do {
    display.setRotation(turned() ? 1 : 0);  // upright however the frame hangs
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
    if (qr && qrSize) {
      const int m = 5;
      int qx, qy;
      qrPlace(display.width(), display.height(), m, 40, qx, qy);
      for (int y = 0; y < qrSize; y++)
        for (int x = 0; x < qrSize; x++)
          if (qrDots[y][x]) display.fillRect(qx + x * m, qy + y * m, m, m, GxEPD_BLACK);
    }
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

#endif

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
  frameCode = prefs.getString("code", "");
  codePending = prefs.getBool("codePend", false);
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

void saveCode(const String& code, bool pending) {
  frameCode = code;
  codePending = pending;
  prefs.begin("domiframe", false);
  prefs.putString("code", code);
  prefs.putBool("codePend", pending);
  prefs.end();
}

// ---- Frame code and sealed pictures ---------------------------------------------

static const char CODE_ALPHABET[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";  // Crockford base32

// n random characters from CODE_ALPHABET. The hardware RNG is truly random while the radio is
// on, so frame codes are made once Wi-Fi is up.
String randomChars(size_t n) {
  uint8_t bytes[32];
  esp_fill_random(bytes, n);
  String out;
  for (size_t i = 0; i < n; i++) out += CODE_ALPHABET[bytes[i] & 31];
  memset(bytes, 0, sizeof bytes);
  return out;
}

void newFrameCode() {
  String c = randomChars(16);
  saveCode(c.substring(0, 4) + "-" + c.substring(4, 8) + "-" + c.substring(8, 12) + "-" + c.substring(12), true);
  etag = "";  // pictures sealed with the old code are gone
  saveString("etag", etag);
}

void hmacSha256(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t len, uint8_t out[32]) {
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, keyLen, msg, len, out);
}

// HKDF-SHA256 (RFC 5869) for one 32-byte block, as web/seal.js frameKeys:
// input = the code without dashes, salt = "domiframe:<frame id>", info = "auth" or "content"
void frameKey(const char* info, uint8_t out[32]) {
  String ikm = frameCode;
  ikm.replace("-", "");
  String salt = "domiframe:" + frameId;
  uint8_t prk[32], msg[16];
  hmacSha256((const uint8_t*)salt.c_str(), salt.length(), (const uint8_t*)ikm.c_str(), ikm.length(), prk);
  size_t n = strlen(info);
  memcpy(msg, info, n);
  msg[n] = 1;
  hmacSha256(prk, sizeof prk, msg, n + 1, out);
  memset(prk, 0, sizeof prk);
}

// SHA-256 (hex) of the access token browsers send: base64url of the "auth" key, unpadded
String accessTokenHash() {
  uint8_t auth[32], b64[48], digest[32];
  size_t len = 0;
  frameKey("auth", auth);
  mbedtls_base64_encode(b64, sizeof b64, &len, auth, sizeof auth);
  while (len && b64[len - 1] == '=') len--;
  for (size_t i = 0; i < len; i++) {
    if (b64[i] == '+') b64[i] = '-';
    if (b64[i] == '/') b64[i] = '_';
  }
  mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), b64, len, digest);
  memset(auth, 0, sizeof auth);
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", digest[i]);
  return String(hex);
}

// Opens a sealed picture into out (IMAGE_BYTES). False if it wasn't sealed with our code.
bool unsealPicture(const uint8_t* sealed, uint8_t* out) {
  uint8_t key[32];
  frameKey("content", key);
  mbedtls_gcm_context gcm;
  mbedtls_gcm_init(&gcm);
  int rc = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, key, 256);
  if (rc == 0) {
    rc = mbedtls_gcm_auth_decrypt(&gcm, IMAGE_BYTES, sealed, GCM_IV_BYTES, nullptr, 0,
                                  sealed + GCM_IV_BYTES + IMAGE_BYTES, GCM_TAG_BYTES, sealed + GCM_IV_BYTES, out);
  }
  mbedtls_gcm_free(&gcm);
  memset(key, 0, sizeof key);
  return rc == 0;
}

void showCodeScreen() {
  String line1 = "Frame ID: " + frameId;  // short lines: they fit a portrait 7.3" too
  // The QR code opens the frame's page with the code filled in. It's after the #, which
  // browsers never send to the server.
  String link = String(SERVER_BASE) + "/f/" + frameId + "#k=" + frameCode;
  bool qr = makeQr(link.c_str()) > 0;
  showMessage(frameCode.c_str(), line1.c_str(), qr ? "Scan, or use both at domiframe.art" : "Use both at domiframe.art", qr);
  etag = "";  // the picture comes back at the next wake
  saveString("etag", etag);
}

void secureClient(WiFiClientSecure& client) {
#if VERIFY_TLS
  client.setCACertBundle(CA_BUNDLE);
#else
  client.setInsecure();
#endif
}

// Tell the server about a new code (only a hash of the token derived from it).
// Returns the HTTP status, or <= 0 on a network error.
int registerCode() {
  WiFiClientSecure client;
  secureClient(client);
  HTTPClient http;
  String url = String(SERVER_BASE) + "/api/frames/" + frameId + "/code";
  if (!http.begin(client, url)) return -1;
  http.setTimeout(20000);
  http.addHeader("X-Device-Key", deviceKey);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST("{\"hash\":\"" + accessTokenHash() + "\"}");
  http.end();
  Serial.printf("POST %s -> %d\n", url.c_str(), code);
  if (code == 200) saveCode(frameCode, false);
  return code;
}

bool runSetupPortal() {
  // A fresh password each time, shown only on the screen: nobody nearby can join the portal
  // (and change where the frame connects) without seeing the frame.
  String apPassword = randomChars(8);
  String joinLine = "password " + apPassword + " to set me up.";
  showMessage("Wi-Fi setup", "On your phone, join \"" SETUP_AP_NAME "\",", joinLine.c_str());

  WiFiManager wm;
  WiFiManagerParameter pId("id", "Frame ID", frameId.c_str(), 32);
  // Never shown back: anyone who joins the portal could read it. Blank keeps the saved key.
  WiFiManagerParameter pKey("key", deviceKey.isEmpty() ? "Device key" : "Device key (leave blank to keep it)", "", 64);
  // WiFiManager only has text fields: a hidden one holds the value, a dropdown fills it in.
  WiFiManagerParameter pOrient("orient", "", orientation.c_str(), 10, "type='hidden'");
  bool portrait = orientation == "portrait";
  String pickHtml = String("<br><label for='orientPick'>How the frame hangs</label>"
                           "<select id='orientPick' onchange=\"document.getElementById('orient').value=this.value\">"
                           "<option value='landscape'") + (portrait ? "" : " selected") + ">Landscape (wide)</option>"
                           "<option value='portrait'" + (portrait ? " selected" : "") + ">Portrait (tall)</option></select>";
  WiFiManagerParameter pOrientPick(pickHtml.c_str());
  WiFiManagerParameter pNewCode("newcode", "", "", 2, "type='hidden'");
  WiFiManagerParameter pNewCodePick(
      "<br><label><input type='checkbox' style='width:auto' "
      "onchange=\"document.getElementById('newcode').value=this.checked?'1':''\"> "
      "Make a new frame code. The old code stops working and all pictures are removed.</label>");
  wm.addParameter(&pId);
  wm.addParameter(&pKey);
  wm.addParameter(&pOrientPick);
  wm.addParameter(&pOrient);
  if (!frameCode.isEmpty()) {
    wm.addParameter(&pNewCodePick);
    wm.addParameter(&pNewCode);
  }
  wm.setConfigPortalTimeout(SETUP_PORTAL_TIMEOUT_S);
  wm.setBreakAfterConfig(true);

  bool ok = wm.startConfigPortal(SETUP_AP_NAME, apPassword.c_str());
  String newId = pId.getValue();
  newId.trim();
  bool wantNewCode = String(pNewCode.getValue()) == "1";
  if (newId.length() && newId != frameId) {
    frameId = newId;
    saveString("id", frameId);
    wantNewCode = true;  // the code's keys are tied to the frame ID
  }
  if (wantNewCode) saveCode("", false);  // made (and registered) once we're online
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
  rtcChannel = 0;  // maybe a new network
  // force a redraw after setup
  etag = "";
  saveString("etag", etag);
  return ok && WiFi.status() == WL_CONNECTED;
}

bool waitForWifi(uint32_t ms) {
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < ms) delay(50);
  return WiFi.status() == WL_CONNECTED;
}

void rememberAccessPoint() {
  const uint8_t* bssid = WiFi.BSSID();
  if (!bssid) return;
  memcpy(rtcBssid, bssid, 6);
  rtcChannel = WiFi.channel();
}

bool connectWifi() {
  // RAM only: never rewrite the network WiFiManager saved, on every wake, with a pinned AP.
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  wifi_config_t conf;
  if (esp_wifi_get_config(WIFI_IF_STA, &conf) != ESP_OK || !conf.sta.ssid[0]) return false;
  char ssid[33] = {0}, pass[65] = {0};
  memcpy(ssid, conf.sta.ssid, 32);
  memcpy(pass, conf.sta.password, 64);

  // Fast path: straight to last time's access point and channel
  if (rtcChannel > 0) {
    WiFi.begin(ssid, pass, rtcChannel, rtcBssid);
    if (waitForWifi(5000)) return true;
    WiFi.disconnect();
    rtcChannel = 0;
  }
  WiFi.begin(ssid, pass);  // scan: the router may have moved channel or been replaced
  if (!waitForWifi(20000)) return false;
  rememberAccessPoint();
  return true;
}

// Returns true if a new picture was drawn.
bool fetchAndDraw(int batteryMv) {
  WiFiClientSecure client;
  secureClient(client);

  HTTPClient http;
  String url = String(SERVER_BASE) + "/api/frames/" + frameId + "/image";
  if (!http.begin(client, url)) return false;
  http.setTimeout(20000);
  http.addHeader("X-Device-Key", deviceKey);
  http.addHeader("X-Battery-Mv", String(batteryMv));
  http.addHeader("X-Fw", FW_VERSION);
  http.addHeader("X-Panel", PANEL_ID);  // the server makes pictures this size
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
  if (len != -1 && len != (int)SEALED_BYTES) {
    Serial.printf("unexpected size %d\n", len);
    http.end();
    return false;
  }

  auto alloc = [](size_t n) {
    uint8_t* p = (uint8_t*)ps_malloc(n);
    return p ? p : (uint8_t*)malloc(n);
  };
  uint8_t* sealed = alloc(SEALED_BYTES);
  uint8_t* buf = sealed ? alloc(IMAGE_BYTES) : nullptr;
  if (!buf) {
    free(sealed);
    http.end();
    return false;
  }

  WiFiClient* stream = http.getStreamPtr();
  size_t got = 0;
  uint32_t last = millis();
  while (got < SEALED_BYTES && millis() - last < 15000) {
    int n = stream->read(sealed + got, SEALED_BYTES - got);
    if (n > 0) {
      got += n;
      last = millis();
    } else {
      delay(5);
    }
  }
  String newEtag = http.header("ETag");
  http.end();

  bool opened = got == SEALED_BYTES && unsealPicture(sealed, buf);
  free(sealed);
  if (!opened) {
    // Short read, or not sealed with our code (e.g. uploaded just before a new code)
    Serial.printf(got == SEALED_BYTES ? "couldn't open the picture\n" : "short read %u\n", (unsigned)got);
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
  // KEY1 held while pressing reset (not a KEY1 wake from sleep): show the frame code again
  bool wantCode = esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_UNDEFINED && digitalRead(BTN_REFRESH) == LOW;

  bool online = wantSetup ? runSetupPortal() : connectWifi();
  if (!online) {
    if (wantSetup) showMessage("Setup timed out", "Press reset to try again.");
    // Otherwise keep the current picture and retry at the next wake.
    goToSleep();
  }

  int mv = readBatteryMv();
  Serial.printf("frame=%s battery=%dmV etag=%s\n", frameId.c_str(), mv, etag.c_str());

  if (frameCode.isEmpty()) newFrameCode();  // first setup, or asked for in the portal
  if (codePending) {
    int code = registerCode();
    if (code == 200) showCodeScreen();
    else if (code == 401 || code == 404) showMessage("Frame not registered", "Hold KEY3 and press reset", "to re-enter the frame ID and key.");
    goToSleep();  // on a network error, try again next wake (pictures can't arrive before)
  }
  if (wantCode) {
    showCodeScreen();
    goToSleep();
  }

  bool drew = fetchAndDraw(mv);
  if (!drew && wantSetup) showCodeScreen();  // what someone needs to send the first picture
  goToSleep();
}

void loop() {}
