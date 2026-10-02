#pragma once

// ---- Server ---------------------------------------------------------------
#define SERVER_BASE "https://domiframe.art"
#define FW_VERSION "0.8.0"  // tools/release.py publishes it; raise it for every release

// Which build this is, so updates over Wi-Fi only ever bring the same build (platformio.ini envs)
#if defined(DOMIFRAME_PANEL_13IN3)
#define FW_ENV "ee02-13in3"
#else
#define FW_ENV "ee04"
#endif

// Updates over Wi-Fi need this much battery (millivolts): a download that dies halfway is
// harmless, but there's no point starting one on a flat battery. Readings under 1 V mean no
// battery is connected (running on USB), and don't count.
#define MIN_UPDATE_MV 3550

// Check the server's HTTPS certificate against Mozilla's root CAs (data/cert). 0 skips the
// check, for debugging only: anyone on the frame's network could then read its device key.
#define VERIFY_TLS 1

// How often the frame wakes to check for a new picture when the server doesn't say
// (offline, or an old server). Normally the server sends X-Sleep-Minutes, set per frame on
// the upload/admin pages, clamped to this range.
#define SLEEP_MINUTES 60
#define MIN_SLEEP_MINUTES 5
#define MAX_SLEEP_MINUTES (7 * 24 * 60)
// After check-ins that don't get through (no Wi-Fi, or the server doesn't answer), the frame
// waits twice as long after each one in a row, up to this, so a frame whose network is down
// doesn't spend its battery on the radio every hour.
#define MAX_OFFLINE_SLEEP_MINUTES (12 * 60)

// An empty battery (millivolts, read before Wi-Fi is on): the frame stops checking in, keeping its
// picture up, and looks again every FLAT_CHECK_MINUTES (without Wi-Fi) until the battery is back
// over RESUME_MV, from charging. The server's own low-battery slowdown starts well
// before this (LOW_BATTERY_MV in netlify/lib/schedule.mjs).
#define FLAT_MV 3350
#define RESUME_MV 3700
#define FLAT_CHECK_MINUTES (6 * 60)

// ---- XIAO ePaper Display Board EE04 (XIAO ESP32-S3 Plus) --------------------
// From Seeed_GFX User_Setups/EPaper_Board_Pins_Setups.h (USE_XIAO_EPAPER_DISPLAY_BOARD_EE04)
#define EPD_CS 44      // D7
#define EPD_DC 10      // D16
#define EPD_RST 38     // D11
#define EPD_BUSY 4     // D3
#define EPD_ENABLE 43  // D6, drive HIGH to power the panel
// SPI: SCK = D8, MOSI = D10 (XIAO default SPI pins)

// Buttons (from Seeed EE04 wiki; active LOW)
#define BTN_REFRESH 2  // KEY1: wake and check for a new picture now
#define BTN_SETUP 5    // KEY3: hold while powering on / pressing reset to reopen Wi-Fi setup

// Battery sense (from Seeed EE04 wiki)
#define BAT_ADC_PIN 1        // A0
#define BAT_ADC_ENABLE_PIN 6 // A5, HIGH while measuring
#define BAT_SCALE 7.16f      // volts = raw / 4096 * BAT_SCALE

// Wi-Fi setup portal
#define SETUP_AP_NAME "DomiFrame-Setup"
#define SETUP_PORTAL_TIMEOUT_S 600
