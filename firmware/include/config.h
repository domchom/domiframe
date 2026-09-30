#pragma once

// ---- Server ---------------------------------------------------------------
#define SERVER_BASE "https://domiframe.com"
#define FW_VERSION "0.3.0"

// How often the frame wakes to check for a new picture when the server doesn't say
// (offline, or an old server). Normally the server sends X-Sleep-Minutes, set per frame on
// the upload/admin pages, clamped to this range.
#define SLEEP_MINUTES 60
#define MIN_SLEEP_MINUTES 5
#define MAX_SLEEP_MINUTES (7 * 24 * 60)

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
