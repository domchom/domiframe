// DomiFrame firmware for Seeed's XIAO ePaper Display Boards:
//   env ee04        EE04 + 7.3" E Ink Spectra 6 (800x480), GxEPD2
//   env ee02-13in3  EE02 + 13.3" E Ink Spectra 6 (1200x1600), Seeed_GFX
//
// Each wake: connect to Wi-Fi -> GET /api/frames/<id>/image (with ETag) ->
// redraw only if the picture changed -> deep sleep for as long as the server says
// (X-Sleep-Minutes), so check-in times, quiet hours and picture rotation are set on the server.
//
// Wi-Fi setup (portal.cpp): on first boot, when someone switches the frame on (or resets it, or
// presses KEY1) and it can't reach its Wi-Fi, or with KEY3 held while resetting, the frame opens
// its own network "DomiFrame-Setup" and shows a QR code to join it (and its password). The phone
// gets one page: pick the Wi-Fi, type its password. The frame ID and device key go in there too
// on first setup, then stay out of the way.
//
// Frame code: the frame makes its own random code (like K7PX-92QD-M4TR-8WZN) and shows it on
// its screen; people type it on the website to send pictures. Pictures are sealed in their
// browser with a key derived from the code (web/seal.js), so the server only ever has
// ciphertext; the frame derives the same key and opens them here. The server only gets the
// SHA-256 of a separate access token derived from the code (POST /api/frames/<id>/code).
// Hold KEY1 while pressing reset to show the code again; the setup portal can make a new one,
// or take back the code the frame had (the server then brings back the pictures sealed with it).
//
// Updates over Wi-Fi: when newer firmware for this build is out, the check-in reply says so.
// The frame downloads it, checks its signature against FW_SIGNING_KEY (include/fw_key.h) and
// installs it. Settings, Wi-Fi and the frame code are kept, so its pictures stay.

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <SPI.h>
#include <esp_wifi.h>
#include <driver/rtc_io.h>
#include <esp_system.h>
#include <mbedtls/md.h>
#include <mbedtls/gcm.h>
#include <mbedtls/aes.h>
#include <mbedtls/base64.h>
#include <mbedtls/pk.h>
#include <Update.h>
#include <esp_ota_ops.h>
#include <qrcode.h>  // ESP-IDF's QR encoder
#include "config.h"
#include "portal.h"
#include "fw_key.h"
#include "pixel_font.h"  // made by the app repo's scripts/make-pixel-font.py, as web/pixelfont.js

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
#define PANEL_ID "7.3"
static const int W = 800, H = 480;
static const bool NATIVE_PORTRAIT = false;
static const uint16_t PALETTE[6] = {GxEPD_BLACK, GxEPD_WHITE, GxEPD_YELLOW, GxEPD_RED, GxEPD_BLUE, GxEPD_GREEN};
// GDEP073E01 uses the same ED2208 controller as Seeed's 7.3" Spectra 6 panel.
GxEPD2_7C<GxEPD2_730c_GDEP073E01, GxEPD2_730c_GDEP073E01::HEIGHT / 4>
    display(GxEPD2_730c_GDEP073E01(EPD_CS, EPD_DC, EPD_RST, EPD_BUSY));
#endif
#include "plex_fonts.h"  // IBM Plex, as on the website, at this screen's own size (tools/make_fonts.py)

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
// Failed tries at installing an update (a bad download, a bad signature), so a broken release
// doesn't drain the battery retrying at every check-in. Starts over for a newer version.
RTC_DATA_ATTR uint8_t rtcUpdateFails = 0;
RTC_DATA_ATTR char rtcUpdateFailedVersion[16] = "";
// The frame's usual check-in interval (the server's X-Retry-Minutes), and how many check-ins in
// a row haven't got through: when the next one fails, it waits that long, doubled for each.
RTC_DATA_ATTR uint32_t rtcRetryMinutes = 0;
RTC_DATA_ATTR uint8_t rtcFailedCheckIns = 0;

Preferences prefs;
String frameId, deviceKey, etag;
String frameCode;          // XXXX-XXXX-XXXX-XXXX, made here, never sent anywhere
bool codePending = false;  // made but not yet registered with the server
// How long to sleep: the server's X-Sleep-Minutes after a check-in, otherwise the usual interval
uint32_t sleepMinutes = SLEEP_MINUTES;
bool checkedIn = false;  // the server answered this wake's check-in
// How the frame hangs: "landscape" or "portrait". Chosen in the setup portal (sent to the server
// until it confirms), otherwise whatever the server says (set on the website). Pictures arrive
// already turned for it; this only decides which way up our own messages are drawn.
String orientation = "landscape";
bool orientationPending = false;
// Newer firmware the server offered at this check-in (X-Fw-Update etc.), if any
struct { String version, url, sig; size_t size = 0; } offer;

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

// ---------------------------------------------------------------------------

void displayPower(bool on) {
  pinMode(EPD_ENABLE, OUTPUT);
  digitalWrite(EPD_ENABLE, on ? HIGH : LOW);
  if (on) delay(10);
}

#if defined(DOMIFRAME_PANEL_13IN3)

// Drawing for messages (see showMessage): sizes are the 7.3"'s, drawn S times as big here
static const int S = 2;

template <typename Paint>
void drawScreen(Paint paint) {
  displayPower(true);
  epaper.begin();
  epaper.setRotation(turned() ? 1 : 0);  // upright however the frame hangs
  epaper.fillScreen(TFT_WHITE);
  paint();
  epaper.update();
  epaper.sleep();
}

int screenW() { return epaper.width() / S; }
int screenH() { return epaper.height() / S; }
void inkRect(int x, int y, int w, int h, int ink) { epaper.fillRect(x * S, y * S, w * S, h * S, PALETTE[ink]); }
// Text with its baseline at y
// (the fonts are made at this screen's size, so they're drawn 1:1, not doubled)
void inkText(const char* text, int x, int y, const GFXfont* font, int ink) {
  epaper.setFreeFont(font);
  epaper.setTextSize(1);
  epaper.setTextColor(PALETTE[ink]);
  epaper.setTextDatum(L_BASELINE);
  epaper.drawString(text, x * S, y * S);
}
int textWidth(const char* text, const GFXfont* font) {  // in screen units, like everything else
  epaper.setFreeFont(font);
  epaper.setTextSize(1);
  return epaper.textWidth(text) / S;
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

// Drawing for messages (see showMessage), at the 7.3"'s own size
static const int S = 1;

template <typename Paint>
void drawScreen(Paint paint) {
  displayBegin();
  display.setFullWindow();
  display.firstPage();
  do {
    display.setRotation(turned() ? 1 : 0);  // upright however the frame hangs
    display.fillScreen(GxEPD_WHITE);
    paint();
  } while (display.nextPage());
  display.hibernate();
}

int screenW() { return display.width() / S; }
int screenH() { return display.height() / S; }
void inkRect(int x, int y, int w, int h, int ink) { display.fillRect(x * S, y * S, w * S, h * S, PALETTE[ink]); }
// Text with its baseline at y
void inkText(const char* text, int x, int y, const GFXfont* font, int ink) {
  display.setFont(font);
  display.setTextSize(S);
  display.setTextColor(PALETTE[ink]);
  display.setCursor(x * S, y * S);
  display.print(text);
}
int textWidth(const char* text, const GFXfont* font) {
  display.setFont(font);
  display.setTextSize(1);
  int16_t x1, y1;
  uint16_t w, h;
  display.getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
  return x1 + w;
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

// ---- Messages ----------------------------------------------------------------
// Laid out like the website: the wordmark and its strip of the six inks over a rule, small
// red labels, big black text, a rule and a note at the foot. Sizes are for the 7.3" (S scales
// them on the 13.3"); every screen is at least 480 x 480 of these units, upright either way.

enum Ink { INK_BLACK, INK_WHITE, INK_YELLOW, INK_RED, INK_BLUE, INK_GREEN };  // PALETTE order
static const int MARGIN = 40, HEAD = 88;               // HEAD: the rule under the wordmark

// A 50% checkerboard of one ink: the site's dithered shadows
void inkDither(int x, int y, int w, int h, int ink) {
  for (int yy = y; yy < y + h; yy++)
    for (int xx = x + ((x + yy) & 1); xx < x + w; xx += 2) inkRect(xx, yy, 1, 1, ink);
}

const PfGlyph* wordGlyph(char c) {
  for (const PfGlyph& g : PF_WORD) if (g.c == c) return &g;
  return nullptr;
}

// The wordmark's pixel letters (pixel_font.h), s units a dot, with a red dithered shadow one
// dot down and right, as on the website and in the app; returns their width
int pixelWord(const char* text, int x, int top, int s, int ink) {
  for (int pass = 0; pass < 2; pass++) {  // the shadow, then the letters over it
    int cx = x;
    for (const char* p = text; *p; p++) {
      const PfGlyph* g = wordGlyph(*p);
      if (!g) continue;
      for (int r = 0; r < PF_CAP; r++)
        for (int c = 0; c < g->w; c++)
          if (g->rows[r][c] == '#') {
            if (pass == 0) inkDither(cx + (c + 1) * s, top + (r + 1) * s, s, s, INK_RED);
            else inkRect(cx + c * s, top + r * s, s, s, ink);
          }
      cx += (g->w + PF_SPACING) * s;
    }
    if (pass == 1) return cx - PF_SPACING * s - x;
  }
  return 0;
}

void drawHeader(int w) {
  const int strip[6] = {INK_BLACK, INK_BLUE, INK_GREEN, INK_YELLOW, INK_RED, INK_WHITE};
  int x = MARGIN + pixelWord("DomiFrame", MARGIN, 34, 3, INK_BLACK) + 22;
  inkRect(x - 2, 41, 6 * 16 + 4, 16, INK_BLACK);  // outlined, so the white block shows
  for (int i = 0; i < 6; i++) inkRect(x + i * 16, 43, 16, 12, strip[i]);
  inkRect(MARGIN, HEAD - 3, w - 2 * MARGIN, 3, INK_BLACK);
}

// Cards on the code screen get a dithered shadow this far down and right, as the site's prints
static const int CARD_SHADOW = 6;


// The frame code in one card, read like a line of text: groups of four apart, with a red dash
// between them; on one line at the biggest size that fits maxW, or else on two (the dash at the
// end of the first). Digits blue, letters black, each character drawn to differ from its
// look-alikes (pixel_font.h), PF_CODE_W x PF_CODE_H dots of sc units, CODE_BOLD wider so the
// strokes are heavier than the gaps. web/sim.js codeCard draws the same. Returns its height.
static const int CODE_BOLD = 2;

void drawCodeChar(char ch, int x, int y, int sc) {
  const PfCodeGlyph* g = nullptr;
  for (const PfCodeGlyph& k : PF_CODE) if (k.c == ch) g = &k;
  if (!g) return;
  int ink = isdigit((unsigned char)ch) ? INK_BLUE : INK_BLACK;
  for (int r = 0; r < PF_CODE_H; r++)
    for (int c = 0; c < PF_CODE_W; c++)
      if (g->rows[r][c] == '#') inkRect(x + c * sc, y + r * sc, sc + CODE_BOLD, sc, ink);
}

void showMessage(const char* title, const char* line1, const char* line2 = nullptr) {
  drawScreen([&] {
    drawHeader(screenW());
    inkText(title, MARGIN, HEAD + 70, &PlexTitle, INK_BLACK);
    inkText(line1, MARGIN, HEAD + 130, &PlexBody, INK_BLACK);
    if (line2) inkText(line2, MARGIN, HEAD + 166, &PlexBody, INK_BLACK);
  });
}

// The QR code made by makeQr is drawn QR_MODULE units a module (showCodeScreen)
static const int QR_MODULE = 5;

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

// What someone typed as a frame code -> XXXX-XXXX-XXXX-XXXX, or "" if it isn't one. Forgiving
// like the website (web/code.js normalizeCode): any case, spaces or dashes, O/I/L as 0/1/1.
String tidyCode(const char* typed) {
  String c;
  for (const char* p = typed; *p; p++) {
    char ch = toupper((unsigned char)*p);
    if (ch == ' ' || ch == '-') continue;
    if (ch == 'O') ch = '0';
    if (ch == 'I' || ch == 'L') ch = '1';
    if (!strchr(CODE_ALPHABET, ch)) return "";
    c += ch;
  }
  if (c.length() != 16) return "";
  return c.substring(0, 4) + "-" + c.substring(4, 8) + "-" + c.substring(8, 12) + "-" + c.substring(12);
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
// AES-GCM decryption, written out: AES-CTR for the data and GHASH for the tag. The ESP32-S3's
// built-in GCM gave wrong tags for a whole 192 KB picture (it can't be done in one call from
// internal RAM, and split up, the hardware GHASH goes wrong), while its plain AES block
// cipher is reliable. Only the AES block is the hardware's here; GHASH is in software.
struct Gcm {
  mbedtls_aes_context aes;
  uint8_t h[16];      // the hash key: AES(0)
  uint8_t ghash[16];  // the running hash
};

// x = x * h in GF(2^128), as GCM defines it (bit-reflected, R = 0xE1 || 0^120)
static void gfMul(uint8_t x[16], const uint8_t h[16]) {
  uint8_t z[16] = {0}, v[16];
  memcpy(v, h, 16);
  for (int i = 0; i < 128; i++) {
    if (x[i / 8] & (0x80 >> (i % 8)))
      for (int k = 0; k < 16; k++) z[k] ^= v[k];
    bool lsb = v[15] & 1;
    for (int k = 15; k > 0; k--) v[k] = (v[k] >> 1) | (v[k - 1] << 7);
    v[0] >>= 1;
    if (lsb) v[0] ^= 0xE1;
  }
  memcpy(x, z, 16);
}

static void ghashBlock(Gcm& g, const uint8_t* block, size_t n) {
  for (size_t i = 0; i < n; i++) g.ghash[i] ^= block[i];
  gfMul(g.ghash, g.h);
}

// Opens IV (12) || ciphertext (len) || tag (16) into out (len bytes). The input may be in PSRAM:
// it's read 16 bytes at a time into internal RAM.
static bool gcmOpen(const uint8_t key[32], const uint8_t* sealed, size_t len, uint8_t* out) {
  Gcm g;
  mbedtls_aes_init(&g.aes);
  bool ok = mbedtls_aes_setkey_enc(&g.aes, key, 256) == 0;
  uint8_t zero[16] = {0}, j0[16], ctr[16], ks[16], blk[16], tag[16];
  if (ok) ok = mbedtls_aes_crypt_ecb(&g.aes, MBEDTLS_AES_ENCRYPT, zero, g.h) == 0;
  memset(g.ghash, 0, 16);
  memcpy(j0, sealed, 12);  // a 12-byte IV: J0 = IV || 0x00000001
  j0[12] = 0; j0[13] = 0; j0[14] = 0; j0[15] = 1;
  memcpy(ctr, j0, 16);
  for (size_t done = 0; ok && done < len; done += 16) {
    size_t n = min((size_t)16, len - done);
    memcpy(blk, sealed + 12 + done, n);
    ghashBlock(g, blk, n);  // GHASH is over the ciphertext
    for (int k = 15; k >= 12 && ++ctr[k] == 0; k--) {}  // inc32
    ok = mbedtls_aes_crypt_ecb(&g.aes, MBEDTLS_AES_ENCRYPT, ctr, ks) == 0;
    for (size_t k = 0; k < n; k++) blk[k] ^= ks[k];
    memcpy(out + done, blk, n);
  }
  // The lengths block: no associated data, then the ciphertext's length in bits
  uint8_t lens[16] = {0};
  uint64_t bits = (uint64_t)len * 8;
  for (int k = 0; k < 8; k++) lens[15 - k] = bits >> (8 * k);
  ghashBlock(g, lens, 16);
  if (ok) ok = mbedtls_aes_crypt_ecb(&g.aes, MBEDTLS_AES_ENCRYPT, j0, tag) == 0;
  mbedtls_aes_free(&g.aes);
  const uint8_t* want = sealed + 12 + len;
  uint8_t diff = 0;
  for (int k = 0; k < 16; k++) diff |= (tag[k] ^ g.ghash[k]) ^ want[k];
  memset(&g, 0, sizeof g);
  memset(ks, 0, sizeof ks);
  return ok && diff == 0;
}

// Once at start: open a sample sealed by the website's own code (web/seal.js, frame "emma",
// code K7PX-92QD-M4TR-8WZN). If this fails, opening pictures can't work either.
static void gcmSelfTest() {
  static const uint8_t sample[] = {0x72, 0x63, 0x0d, 0x5a, 0x54, 0xba, 0x34, 0xa7, 0x8a, 0x68, 0xf3, 0xb1, 0xf3, 0x7b, 0x8f, 0x88, 0x78, 0x55, 0x1e, 0x1e, 0x6b, 0x42, 0x8f, 0xa5, 0xb1, 0x58, 0x33, 0x28, 0x50, 0x63, 0x3f, 0x74, 0x02};
  static const uint8_t want[] = {0, 1, 2, 250, 255};
  String savedId = frameId, savedCode = frameCode;
  frameId = "emma";
  frameCode = "K7PX-92QD-M4TR-8WZN";
  uint8_t key[32], out[sizeof want];
  frameKey("content", key);
  frameId = savedId;
  frameCode = savedCode;
  bool ok = gcmOpen(key, sample, sizeof want, out) && memcmp(out, want, sizeof want) == 0;
  memset(key, 0, sizeof key);
  Serial.printf("decryption self-test: %s\n", ok ? "ok" : "FAILED");
}

bool unsealPicture(const uint8_t* sealed, uint8_t* out) {
  uint8_t key[32];
  frameKey("content", key);
  bool ok = gcmOpen(key, sealed, IMAGE_BYTES, out);
  memset(key, 0, sizeof key);
  if (!ok) {
    // Which code this frame has, as the first characters of its token's hash: compare with
    // the server's to tell a different code from a decryption problem (never the code itself)
    Serial.printf("can't open: code hash %.12s\n", accessTokenHash().c_str());
  }
  return ok;
}

// ---- The code screen ---------------------------------------------------------------------
// A friendly card for setting the frame up, in the six inks: the app's icon and the wordmark,
// a headline, the frame ID and then the code in pale fields (sparse blue dots on white read as
// pale blue), the QR code in a card under a blue SCAN TO OPEN bar, and a little picture of a
// frame on a shelf. The code reads like a line of text: red dashes between its groups, two lines
// when it doesn't fit on one. web/sim.js showCode draws the same.

// Pixel art, one letter an ink: k black, w white, r red, y yellow, g green, b blue, o orange
// (red and yellow dithered), . nothing. The same as in web/sim.js.
static const char* const ART_PAINTING[] = {
  "rrrrrrrrrrrrrrrr", "ooooooooooowwwoo", "oooooooooowwwwwo", "yyyyyyyyyyywwwyy",
  "yyyyggyyyyyyyyyy", "yyygggggyyggyyyy", "yygggggggggggyyy", "gggggggggggggggg",
  "bbbbbbbbbbbwbbbb", "bbbbbbbbbbwbwbbb", "bbbbbbbbbbbwbbbb", "bbbbbbbbbbbbbbbb",
};
static const char* const ART_PLANT[] = {
  ".....g..g.....", "....gg..gg....", "...ggg..ggg...", "g..gggggggg..g", "gg..gggggg..gg", "ggg..gggg..ggg", ".ggg.gggg.ggg.", "..gggggggggg..", "...gggggggg...", "....gggggg....", ".....gggg.....", "......gg......",
};
static const char* const ART_POT[] = {
  "kkkkkkkkkkkk", "kooooooooook", "kkkkkkkkkkkk", ".kooooooook.", ".kooooooook.", ".kooooooook.", "..kooooook..", "..kkkkkkkk..",
};
static const char* const ART_PHONE[] = {
  ".kkkkkkkkk.", "kkkkwwwkkkk", "kkkkkkkkkkk", "kbbbbbbbbbk", "kbwwwwwwwbk", "kbwkkwkkwbk", "kbwkkwkkwbk", "kbwwwwwwwbk", "kbwkkwkwwbk", "kbwkkwwkwbk", "kbwwwwwwwbk", "kbbbbbbbbbk", "kkkkkkkkkkk", "kkkkwwwkkkk", ".kkkkkkkkk.",
};

void inkDot(int x, int y, int ink) { inkRect(x, y, 1, 1, ink); }

void drawArt(const char* const* rows, int n, int x, int y, int sc) {
  for (int ry = 0; ry < n; ry++)
    for (int rx = 0; rows[ry][rx]; rx++) {
      char c = rows[ry][rx];
      int px = x + rx * sc, py = y + ry * sc;
      if (c == '.') continue;
      if (c == 'o') {
        for (int a = 0; a < sc; a++)
          for (int b = 0; b < sc; b++) inkDot(px + a, py + b, (a + b) & 1 ? INK_YELLOW : INK_RED);
        continue;
      }
      int ink = c == 'k' ? INK_BLACK : c == 'w' ? INK_WHITE : c == 'y' ? INK_YELLOW : c == 'r' ? INK_RED
              : c == 'b' ? INK_BLUE : INK_GREEN;
      inkRect(px, py, sc, sc, ink);
    }
}

// A rounded rectangle, a row at a time: pick(x, y) -> ink, or -1 for none
template <typename Pick>
void roundFill(int x, int y, int w, int h, int r, Pick pick) {
  for (int dy = 0; dy < h; dy++) {
    float e = dy < r ? r - dy - 0.5f : dy >= h - r ? dy - (h - r) + 0.5f : 0;
    int inset = e > 0 ? (int)lroundf(r - sqrtf(fmaxf(0, r * r - e * e))) : 0;
    for (int dx = inset; dx < w - inset; dx++) {
      int ink = pick(x + dx, y + dy);
      if (ink >= 0) inkDot(x + dx, y + dy, ink);
    }
  }
}
// Pale blue: 1 dot in 8, on a staggered grid so it reads as a flat tint, not stripes
int paleBlue(int x, int y) { return (y & 1) == 0 && (x & 3) == (y & 2) ? INK_BLUE : INK_WHITE; }
int inkBlack(int, int) { return INK_BLACK; }

// The code and setup screens' header: the icon, the wordmark and what it is, the inks at the
// right, over a rule at y = 92
void drawBrandHeader(int w) {
  roundFill(MARGIN, 24, 44, 36, 5, inkBlack);
  inkRect(MARGIN + 3, 27, 38, 30, INK_WHITE);
  drawArt(ART_PAINTING, 12, MARGIN + 6, 30, 2);
  pixelWord("DomiFrame", MARGIN + 58, 24, 3, INK_BLACK);
  inkText("COLOR E-PAPER PHOTO FRAMES", MARGIN + 58, 74, &PlexLabel, INK_BLACK);
  const int strip[6] = {INK_BLACK, INK_BLUE, INK_GREEN, INK_YELLOW, INK_RED, INK_WHITE};
  int sx = w - MARGIN - 6 * 16 - 4;
  inkRect(sx, 31, 6 * 16 + 4, 16, INK_BLACK);  // centred on the wordmark
  for (int i = 0; i < 6; i++) inkRect(sx + 2 + i * 16, 33, 16, 12, strip[i]);
  inkRect(MARGIN, 92, w - 2 * MARGIN, 2, INK_BLACK);
}

// The QR code made by makeQr, in a card under a blue bar with a label, with blue corner marks
// and a dithered shadow: (qrSize + 4) * QR_MODULE + 24 wide, 30 more tall
void drawQrCard(int cardX, int cardY, const char* label) {
  int qside = (qrSize + 4) * QR_MODULE, cardW = qside + 24, cardH = qside + 24 + 30;
  roundFill(cardX + CARD_SHADOW, cardY + CARD_SHADOW, cardW, cardH, 10,
            [](int x, int y) { return (x + y) & 1 ? -1 : (int)INK_BLACK; });
  roundFill(cardX, cardY, cardW, cardH, 10, [&](int x, int y) {
    bool edge = x < cardX + 2 || x >= cardX + cardW - 2 || y < cardY + 2 || y >= cardY + cardH - 2;
    return edge || y < cardY + 30 ? (int)INK_BLUE : (int)INK_WHITE;
  });
  inkText(label, cardX + (cardW - textWidth(label, &PlexLabel)) / 2, cardY + 21, &PlexLabel, INK_WHITE);
  int qx = cardX + 12, qy = cardY + 30 + 12;
  for (int r = 0; r < qrSize; r++)
    for (int c = 0; c < qrSize; c++)
      if (qrDots[r][c]) inkRect(qx + (c + 2) * QR_MODULE, qy + (r + 2) * QR_MODULE, QR_MODULE, QR_MODULE, INK_BLACK);
  const int L = 18, T = 4, x1 = qx - 2, y1 = qy - 2, x2 = qx + qside + 2, y2 = qy + qside + 2;
  const int corners[4][4] = {{x1, y1, 1, 1}, {x2, y1, -1, 1}, {x1, y2, 1, -1}, {x2, y2, -1, -1}};
  for (auto& k : corners) {
    inkRect(k[2] > 0 ? k[0] : k[0] - L, k[3] > 0 ? k[1] : k[1] - T, L, T, INK_BLUE);
    inkRect(k[2] > 0 ? k[0] : k[0] - T, k[3] > 0 ? k[1] : k[1] - L, T, L, INK_BLUE);
  }
}

void showCodeScreen() {
  // The QR code opens the frame's page with the code filled in. It's after the #, which
  // browsers never send to the server.
  String link = String(SERVER_BASE) + "/f/" + frameId + "#k=" + frameCode;
  bool qr = makeQr(link.c_str()) > 0;
  drawScreen([&] {
    int w = screenW(), h = screenH();
    drawBrandHeader(w);

    bool wide = w > h;
    int qside = qr ? (qrSize + 4) * QR_MODULE : 0;
    int cardW = qside + 24, cardH = qside + 24 + 30;
    int cardX = wide ? w - MARGIN - cardW - CARD_SHADOW : (w - cardW) / 2;
    int colW = (qr && wide ? cardX - 30 : w - MARGIN) - MARGIN;

    // A taller screen (the 13.3" landscape) has room to spare: some above, a little between
    int ex = max(0, h - 480);

    // Headline
    int y = 134 + ex * 2 / 5;
    inkText("Add this frame", MARGIN, y, &PlexTitle, INK_BLACK);
    inkText("to your phone", MARGIN, y += 36, &PlexTitle, INK_BLACK);

    // The frame ID, in a pale field
    inkText("FRAME ID", MARGIN, y += 40 + ex / 10, &PlexLabel, INK_RED);
    roundFill(MARGIN, y += 8, colW, 48, 7, paleBlue);
    const GFXfont* idFont = &PlexIdL;
    if (textWidth(frameId.c_str(), idFont) + 32 > colW) idFont = &PlexIdM;
    if (textWidth(frameId.c_str(), idFont) + 32 > colW) idFont = &PlexIdS;
    inkText(frameId.c_str(), MARGIN + 16, y + 34, idFont, INK_BLACK);

    // The code, in a pale field: one line at the biggest size that fits, else two
    inkText("FRAME CODE", MARGIN, y += 48 + 30 + ex / 10, &PlexLabel, INK_RED);
    const int pad = 14;
    auto gW = [](int sc) { return 4 * PF_CODE_W * sc + 3 * sc + CODE_BOLD; };
    auto dW = [](int sc) { return 5 * sc; };  // a space, the dash, a space
    auto lW = [&](int sc, int per) { return per * gW(sc) + (per - 1) * dW(sc) + (per < 4 ? dW(sc) : 0); };
    int sc = 0, perLine = 4;
    for (int k = 6; k >= 4 && !sc; k--) if (lW(k, 4) + 2 * pad <= colW) sc = k;
    if (!sc) {
      perLine = 2;
      for (int k = 6; k >= 3 && !sc; k--) if (lW(k, 2) + 2 * pad <= colW) sc = k;
      if (!sc) sc = 3;
    }
    int lines = 4 / perLine, lineH = PF_CODE_H * sc, gap = 3 * sc;
    int fieldH = lines * lineH + (lines - 1) * gap + 2 * pad;
    roundFill(MARGIN, y += 8, colW, fieldH, 7, paleBlue);
    String rest = frameCode;
    for (int k = 0; k < 4; k++) {
      int dash = rest.indexOf('-');
      String g = dash < 0 ? rest : rest.substring(0, dash);
      rest = dash < 0 ? "" : rest.substring(dash + 1);
      int gx = MARGIN + pad + (k % perLine) * (gW(sc) + dW(sc)), gy = y + pad + (k / perLine) * (lineH + gap);
      for (int i = 0; i < (int)g.length(); i++) drawCodeChar(g[i], gx + i * (PF_CODE_W + 1) * sc, gy, sc);
      if (k < 3) inkRect(gx + gW(sc) + sc, gy + 3 * sc, 3 * sc, sc, INK_RED);
    }
    y += fieldH;

    // The QR code, in a card under a blue bar, with blue corner marks
    int cardY = 104 + ex * 2 / 5;
    if (qr) {
      if (!wide) cardY = y + 28;
      drawQrCard(cardX, cardY, "SCAN TO OPEN");
    }

    // How to use it, by a phone: level with the shelf, so the bottom reads as one band
    int shelfY = h - MARGIN, shelfW = 190, shelfX = w - MARGIN - shelfW;
    int ty = max((wide || !qr ? y : cardY + cardH) + 46, wide ? shelfY - 28 : 0);
    drawArt(ART_PHONE, 15, MARGIN, ty - 22, 2);
    inkText(qr ? "Scan the QR code with a phone's camera," : "Enter the ID and code at", MARGIN + 38, ty, &PlexBody, INK_BLACK);
    inkText(qr ? "or enter the ID and code at domiframe.art." : "domiframe.art, under My frame.", MARGIN + 38, ty + 26, &PlexBody, INK_BLACK);

    // A frame on a shelf, beside a plant: in the corner, where there's room
    if (wide && qr && shelfY - 64 > cardY + cardH + CARD_SHADOW + 8) {
      roundFill(shelfX, shelfY, shelfW, 10, 3, [](int x, int y) { return (x + y) & 1 ? (int)INK_YELLOW : (int)INK_RED; });
      inkRect(shelfX, shelfY, shelfW, 2, INK_BLACK);
      int fx = shelfX + shelfW - 82, fy = shelfY - 56;
      roundFill(fx, fy, 72, 56, 6, inkBlack);
      drawArt(ART_PAINTING, 12, fx + 4, fy + 4, 4);
      drawArt(ART_POT, 8, shelfX + 18, shelfY - 16, 2);
      drawArt(ART_PLANT, 12, shelfX + 16, shelfY - 16 - 24, 2);
    }
  });
  etag = "";  // the picture comes back at the next wake
  saveString("etag", etag);
}

// While the setup page is open: a QR code that joins the frame's own network (a phone's camera
// offers to join it), the network's name and password to type instead, and what comes next.
// note: what went wrong with the last try, if anything.
void showSetupScreen(const String& apPassword, const String& note = "") {
  String join = "WIFI:T:WPA;S:" SETUP_AP_NAME ";P:" + apPassword + ";;";
  bool qr = makeQr(join.c_str()) > 0;
  drawScreen([&] {
    int w = screenW(), h = screenH();
    drawBrandHeader(w);

    bool wide = w > h;
    int qside = qr ? (qrSize + 4) * QR_MODULE : 0;
    int cardW = qside + 24;
    int cardX = wide ? w - MARGIN - cardW - CARD_SHADOW : (w - cardW) / 2;
    int colW = (qr && wide ? cardX - 30 : w - MARGIN) - MARGIN;
    int ex = wide ? max(0, h - 480) : 0;  // room to spare on the 13.3" landscape

    int y = 134 + (wide ? ex * 2 / 5 : max(0, h - 760) / 2);
    inkText("Set up Wi-Fi", MARGIN, y, &PlexTitle, INK_BLACK);
    if (note.length()) {
      // Too long for one line (a long network name): the name, in quotes, goes on a second
      int q = note.indexOf('"');
      if (textWidth(note.c_str(), &PlexBody) > colW && q > 0) {
        inkText(note.substring(0, q - 1).c_str(), MARGIN, y += 32, &PlexBody, INK_RED);
        inkText(note.substring(q).c_str(), MARGIN, y += 26, &PlexBody, INK_RED);
      } else {
        inkText(note.c_str(), MARGIN, y += 32, &PlexBody, INK_RED);
      }
    }

    inkText("1  JOIN THE FRAME'S WI-FI", MARGIN, y += 40 + ex / 10, &PlexLabel, INK_RED);
    inkText(qr ? "Scan the code with your phone's camera," : "On your phone, join this network:", MARGIN, y += 30,
            &PlexBody, INK_BLACK);
    if (qr) inkText("or join this network in Wi-Fi settings:", MARGIN, y += 26, &PlexBody, INK_BLACK);
    roundFill(MARGIN, y += 12, colW, 72, 7, paleBlue);
    inkText("NETWORK", MARGIN + 16, y + 29, &PlexLabel, INK_BLACK);
    inkText(SETUP_AP_NAME, MARGIN + 124, y + 30, &PlexIdM, INK_BLACK);
    inkText("PASSWORD", MARGIN + 16, y + 59, &PlexLabel, INK_BLACK);
    inkText(apPassword.c_str(), MARGIN + 124, y + 60, &PlexIdM, INK_BLACK);
    y += 72;

    inkText("2  PICK YOUR WI-FI", MARGIN, y += 36 + ex / 10, &PlexLabel, INK_RED);
    inkText("A setup page opens on your phone.", MARGIN, y += 30, &PlexBody, INK_BLACK);
    inkText("Choose your Wi-Fi and type its password.", MARGIN, y += 26, &PlexBody, INK_BLACK);

    if (qr) drawQrCard(cardX, wide ? 104 + ex * 2 / 5 : y + 34, "SCAN TO JOIN");
  });
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
  if (code == 200) {
    saveCode(frameCode, false);
    checkedIn = true;
    rtcFailedCheckIns = 0;
  }
  return code;
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

// The Wi-Fi network the frame joins, saved by the setup page. Frames first set up by older
// firmware (with WiFiManager) have it in the Wi-Fi driver's own storage instead.
// Needs Wi-Fi started (WiFi.mode).
bool savedWifi(String& ssid, String& pass) {
  prefs.begin("domiframe", true);
  ssid = prefs.getString("wifiSsid", "");
  pass = prefs.getString("wifiPass", "");
  prefs.end();
  if (ssid.length()) return true;
  wifi_config_t conf;
  if (esp_wifi_get_config(WIFI_IF_STA, &conf) != ESP_OK || !conf.sta.ssid[0]) return false;
  char s[33] = {0}, p[65] = {0};
  memcpy(s, conf.sta.ssid, 32);
  memcpy(p, conf.sta.password, 64);
  ssid = s;
  pass = p;
  return true;
}

// The setup page (portal.cpp), with the setup screen up: returns true once the frame has joined
// a network, which it keeps, along with anything changed under the page's frame details.
bool runSetupPortal() {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);  // the radio on first: it's what makes the random password truly random
  // A fresh password each time, shown only on the screen: nobody nearby can join the frame's
  // network (and change where the frame connects) without seeing the frame.
  String apPassword = randomChars(8);

  PortalSettings in;
  in.frameId = frameId;
  in.hasKey = !deviceKey.isEmpty();
  in.hasCode = !frameCode.isEmpty();
  in.orientation = orientation;
  savedWifi(in.savedSsid, in.savedPass);

  showSetupScreen(apPassword);
  etag = "";  // the setup screen covers the picture: it comes back at the next check-in
  saveString("etag", etag);
  PortalResult out;
  bool ok = runPortal(SETUP_AP_NAME, apPassword.c_str(), in, out, SETUP_PORTAL_TIMEOUT_S,
                      [&](const String& note) { showSetupScreen(apPassword, note); });
  if (!ok) return false;

  prefs.begin("domiframe", false);
  prefs.putString("wifiSsid", out.ssid);
  prefs.putString("wifiPass", out.pass);
  prefs.end();
  rtcChannel = 0;  // a new network, maybe
  rememberAccessPoint();

  bool wantNewCode = out.newCode;
  if (out.frameId.length() && out.frameId != frameId) {
    frameId = out.frameId;
    saveString("id", frameId);
    wantNewCode = true;  // the code's keys are tied to the frame ID
  }
  String typed = tidyCode(out.code.c_str());
  if (typed.length() && typed != frameCode) {
    saveCode(typed, true);  // registered below, now that it's online
  } else if (wantNewCode && typed.isEmpty()) {
    saveCode("", false);  // made (and registered) below
  }
  if (out.deviceKey.length()) {
    deviceKey = out.deviceKey;
    saveString("key", deviceKey);
  }
  if ((out.orientation == "landscape" || out.orientation == "portrait") && out.orientation != orientation) {
    orientation = out.orientation;
    saveString("orient", orientation);
    saveOrientationPending(true);  // tell the server at the next check-in
  }
  return true;
}

bool connectWifi() {
  // RAM only: never rewrite the saved network, on every wake, with a pinned AP.
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  String ssid, pass;
  if (!savedWifi(ssid, pass)) return false;

  // Fast path: straight to last time's access point and channel
  if (rtcChannel > 0) {
    WiFi.begin(ssid.c_str(), pass.c_str(), rtcChannel, rtcBssid);
    if (waitForWifi(5000)) return true;
    WiFi.disconnect();
    rtcChannel = 0;
  }
  WiFi.begin(ssid.c_str(), pass.c_str());  // scan: the router may have moved channel or been replaced
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
  // HTTP/1.0: no chunked encoding. The picture is read straight off the connection below, and a
  // chunked reply (which Netlify sends when it doesn't give a length) would mix the chunk sizes
  // into the picture, so it never opens.
  http.useHTTP10(true);
  http.setTimeout(20000);
  http.addHeader("X-Device-Key", deviceKey);
  http.addHeader("X-Battery-Mv", String(batteryMv));
  http.addHeader("X-Fw", FW_VERSION);
  if (sizeof FW_SIGNING_KEY > 1) http.addHeader("X-Fw-Env", FW_ENV);  // can take updates
  http.addHeader("X-Panel", PANEL_ID);  // the server makes pictures this size
  if (etag.length()) http.addHeader("If-None-Match", etag);
  if (orientationPending) http.addHeader("X-Set-Orientation", orientation);
  const char* keep[] = {"ETag", "X-Sleep-Minutes", "X-Retry-Minutes", "X-Orientation",
                        "X-Fw-Update", "X-Fw-Url", "X-Fw-Size", "X-Fw-Sig"};
  http.collectHeaders(keep, 8);

  int code = http.GET();
  Serial.printf("GET %s -> %d\n", url.c_str(), code);

  if (code == 200 || code == 204 || code == 304) {
    checkedIn = true;
    rtcFailedCheckIns = 0;
    long mins = http.header("X-Sleep-Minutes").toInt();  // 0 if missing
    if (mins >= MIN_SLEEP_MINUTES && mins <= MAX_SLEEP_MINUTES) sleepMinutes = (uint32_t)mins;
    long retry = http.header("X-Retry-Minutes").toInt();  // missing from older servers
    if (retry >= MIN_SLEEP_MINUTES && retry <= MAX_SLEEP_MINUTES) rtcRetryMinutes = (uint32_t)retry;
    // This firmware got through to the server: keep it (after an update, an image that can't
    // would be rolled back to the one before, where the bootloader supports that)
    esp_ota_mark_app_valid_cancel_rollback();
    offer.version = http.header("X-Fw-Update");
    offer.url = http.header("X-Fw-Url");
    offer.sig = http.header("X-Fw-Sig");
    offer.size = (size_t)http.header("X-Fw-Size").toInt();
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
    if (got == SEALED_BYTES) {
      // It arrived whole and won't open, and downloading it again won't change that: keep its
      // ETag so the next check-ins get a 304 until the server moves on to another picture,
      // instead of the whole picture again at every wake. A short read is tried again.
      etag = newEtag;
      saveString("etag", etag);
    }
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

// ---- Updates over Wi-Fi ----------------------------------------------------------

// True if sig (base64 DER) is FW_SIGNING_KEY's ECDSA signature of
// "domiframe-fw|<build>|<version>|<sha256 of the image, hex>", as tools/release.py makes it.
// Signing the build and version too means an image can't be passed off as another build, or
// an old release as a new one.
bool signatureOk(const String& version, const uint8_t imageSha[32], const String& sig) {
  if (sizeof FW_SIGNING_KEY <= 1) return false;
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", imageSha[i]);
  String msg = String("domiframe-fw|") + FW_ENV + "|" + version + "|" + hex;
  uint8_t digest[32], der[128];
  size_t derLen = 0;
  if (mbedtls_base64_decode(der, sizeof der, &derLen, (const uint8_t*)sig.c_str(), sig.length()) != 0) return false;
  mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), (const uint8_t*)msg.c_str(), msg.length(), digest);
  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  bool ok = mbedtls_pk_parse_public_key(&pk, (const uint8_t*)FW_SIGNING_KEY, sizeof FW_SIGNING_KEY) == 0 &&
            mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, digest, sizeof digest, der, derLen) == 0;
  mbedtls_pk_free(&pk);
  return ok;
}

// "0.7.0" -> 7000 etc., so versions compare as numbers (0 if it isn't one)
uint32_t versionNumber(const String& v) {
  unsigned a, b, c;
  return sscanf(v.c_str(), "%u.%u.%u", &a, &b, &c) == 3 ? a * 1000000u + b * 1000u + c : 0;
}

// Download the firmware the server offered into the spare app slot, check it, and restart into
// it. Anything wrong (no battery, a short download, a bad signature) leaves the running firmware
// as it is, to try again at a later check-in. The picture on the screen stays up throughout.
void installUpdate(int batteryMv) {
  if (versionNumber(offer.version) <= versionNumber(FW_VERSION) || !offer.url.startsWith("/firmware/") || !offer.size) return;
  if (batteryMv > 1000 && batteryMv < MIN_UPDATE_MV) {
    Serial.printf("update %s waits for more battery\n", offer.version.c_str());
    return;
  }
  if (offer.version != rtcUpdateFailedVersion) rtcUpdateFails = 0;
  if (rtcUpdateFails >= 3) return;  // until a newer one, or the frame is reset
  auto failed = [](const char* why) {
    Serial.printf("update %s failed: %s\n", offer.version.c_str(), why);
    strlcpy(rtcUpdateFailedVersion, offer.version.c_str(), sizeof rtcUpdateFailedVersion);
    rtcUpdateFails++;
  };
  if (WiFi.status() != WL_CONNECTED && !connectWifi()) return;  // off while drawing

  WiFiClientSecure client;
  secureClient(client);
  HTTPClient http;
  String url = String(SERVER_BASE) + offer.url;
  if (!http.begin(client, url)) return failed("bad link");
  http.useHTTP10(true);  // read straight off the connection, as the picture is: no chunks
  http.setTimeout(20000);
  http.useHTTP10(true);  // no chunked replies: the stream below is the file's bytes as they are
  int code = http.GET();
  Serial.printf("GET %s -> %d\n", url.c_str(), code);
  int len = http.getSize();  // -1 if the server didn't say
  if (code != 200 || (len != -1 && len != (int)offer.size)) {
    http.end();
    return failed("download");
  }
  if (!Update.begin(offer.size, U_FLASH)) {
    http.end();
    return failed(Update.errorString());
  }

  mbedtls_md_context_t sha;
  mbedtls_md_init(&sha);
  mbedtls_md_setup(&sha, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&sha);
  static uint8_t chunk[4096];
  WiFiClient* stream = http.getStreamPtr();
  size_t got = 0;
  uint32_t last = millis();
  while (got < offer.size && millis() - last < 15000) {
    int n = stream->read(chunk, min(sizeof chunk, offer.size - got));
    if (n <= 0) {
      delay(5);
      continue;
    }
    mbedtls_md_update(&sha, chunk, n);
    if (Update.write(chunk, n) != (size_t)n) break;
    got += n;
    last = millis();
  }
  http.end();
  uint8_t imageSha[32];
  mbedtls_md_finish(&sha, imageSha);
  mbedtls_md_free(&sha);

  if (got != offer.size) {
    Update.abort();
    return failed("short download");
  }
  if (!signatureOk(offer.version, imageSha, offer.sig)) {
    Update.abort();  // never boots: the slot isn't marked
    return failed("signature doesn't match");
  }
  if (!Update.end()) return failed(Update.errorString());
  Serial.printf("updated to %s, restarting\n", offer.version.c_str());
  Serial.flush();
  WiFi.disconnect(true);
  ESP.restart();
}

// The usual check-in interval: the server's, from the last check-in that got through
uint32_t usualMinutes() { return rtcRetryMinutes ? rtcRetryMinutes : SLEEP_MINUTES; }

// After a check-in that didn't get through (no Wi-Fi, the server didn't answer or refused): the
// usual interval the first time, then twice as long for each one in a row, up to
// MAX_OFFLINE_SLEEP_MINUTES (or the usual interval, if that's longer). It can't keep to quiet
// hours, which only the server knows, but it soon wakes rarely enough that they hardly matter.
void sleepAfterFailedCheckIn() {
  uint32_t usual = usualMinutes();
  uint32_t longest = max(usual, (uint32_t)MAX_OFFLINE_SLEEP_MINUTES);
  uint32_t minutes = usual << min<uint8_t>(rtcFailedCheckIns, 8);
  sleepMinutes = min(minutes, longest);
  if (rtcFailedCheckIns < 255) rtcFailedCheckIns++;
}

// When the battery is all but empty the frame stops checking in, leaving its picture up: e-paper
// keeps it with no power at all. Wi-Fi and a refresh could brown it out, and running a LiPo flat
// wears it, so until it's been charged it only wakes every few hours to read the battery, without
// Wi-Fi. Owners see the battery from the last check-in on the website and in the app. Returns
// true while it's flat.
bool batteryFlat(int mv) {
  prefs.begin("domiframe", true);
  bool flat = prefs.getBool("flat", false);
  prefs.end();

  bool onUsb = mv < 1000;  // no battery connected
  bool nowFlat = !onUsb && mv < (flat ? RESUME_MV : FLAT_MV);  // charged well up before it counts
  if (nowFlat != flat) {
    Serial.printf(nowFlat ? "battery empty (%d mV)\n" : "battery back to %d mV\n", mv);
    prefs.begin("domiframe", false);
    prefs.putBool("flat", nowFlat);  // kept in flash: a brownout restart forgets RTC memory
    prefs.end();
  }
  if (nowFlat) sleepMinutes = FLAT_CHECK_MINUTES;
  return nowFlat;
}

// This wake is from someone at the frame: the slide switch, the reset button or KEY1. Not a
// timer, nor a restart after an update or a brownout.
bool someoneThere() {
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  if (cause == ESP_SLEEP_WAKEUP_EXT1) return true;
  esp_reset_reason_t r = esp_reset_reason();
  return cause == ESP_SLEEP_WAKEUP_UNDEFINED && (r == ESP_RST_POWERON || r == ESP_RST_EXT);
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

// The Arduino core would mark new firmware as good as soon as it starts. Wait until it has
// reached the server instead (fetchAndDraw), so a broken update can be rolled back.
extern "C" bool verifyRollbackLater() { return true; }

// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(200);
  pinMode(BTN_SETUP, INPUT_PULLUP);
  pinMode(BTN_REFRESH, INPUT_PULLUP);

  loadSettings();
  sleepMinutes = usualMinutes();  // until the server says otherwise
  gcmSelfTest();

  // Before Wi-Fi: the radio pulls the battery's voltage down while it's on, and the reading with it
  int mv = readBatteryMv();
  Serial.printf("frame=%s battery=%dmV etag=%s\n", frameId.c_str(), mv, etag.c_str());
  if (batteryFlat(mv)) goToSleep();

  bool wantSetup = frameId.isEmpty() || deviceKey.isEmpty() || digitalRead(BTN_SETUP) == LOW;
  // KEY1 held while pressing reset (not a KEY1 wake from sleep): show the frame code again
  bool wantCode = esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_UNDEFINED && digitalRead(BTN_REFRESH) == LOW;
  // A code the server already knows is kept here, so show it without Wi-Fi: someone whose
  // network changed can still read it before redoing setup
  if (wantCode && !wantSetup && !frameCode.isEmpty() && !codePending) {
    showCodeScreen();
    goToSleep();
  }

  bool online = wantSetup ? runSetupPortal() : connectWifi();
  // Someone's at the frame (just switched on or reset, or pressed KEY1) and it can't reach its
  // Wi-Fi: it has probably moved, or been given to someone. Open setup rather than waiting
  // quietly. Timer wakes keep the picture up and retry, less often each time.
  if (!online && !wantSetup && someoneThere()) {
    wantSetup = true;
    online = runSetupPortal();
  }
  if (!online) {
    if (wantSetup) showMessage("Not on Wi-Fi yet", "Switch the frame off and on again", "to set up Wi-Fi.");
    // Otherwise keep the current picture and retry at the next wake.
    sleepAfterFailedCheckIn();
    goToSleep();
  }

  if (frameCode.isEmpty()) newFrameCode();  // first setup, or asked for in the portal
  if (codePending) {
    int code = registerCode();
    if (code == 200) showCodeScreen();
    else if (code == 401 || code == 404) showMessage("Frame not registered", "Hold KEY3 and press reset", "to re-enter the frame ID and key.");
    if (!checkedIn) sleepAfterFailedCheckIn();
    goToSleep();  // on a network error, try again next wake (pictures can't arrive before)
  }
  if (wantCode) {
    showCodeScreen();
    goToSleep();
  }

  bool drew = fetchAndDraw(mv);
  if (!drew && wantSetup) showCodeScreen();  // what someone needs to send the first picture
  if (offer.version.length()) installUpdate(mv);  // restarts into the new firmware if it works
  if (!checkedIn) sleepAfterFailedCheckIn();
  goToSleep();
}

void loop() {}
