#pragma once
// The Wi-Fi setup page, served by the frame itself: it opens its own network, a phone joins it,
// and the phone's "sign in to Wi-Fi" sheet shows one page: pick a network, type its password,
// Connect. The frame tries it while the page waits, and says on the page whether it worked.
// Nothing here needs the internet; domiframe.art only comes in once the frame is on Wi-Fi.

#include <Arduino.h>
#include <functional>

struct PortalSettings {  // what the page starts with
  String frameId;
  bool hasKey = false;   // the device key is never shown, only whether there is one
  bool hasCode = false;  // likewise the frame code
  String orientation;    // "landscape" or "portrait"
  String savedSsid, savedPass;  // the network the frame uses now, if any (the password isn't shown)
};

struct PortalResult {  // filled in when runPortal returns true
  String ssid, pass;   // the network it joined
  String frameId;      // as entered (may be unchanged)
  String deviceKey;    // "" = keep the saved one
  String code;         // what was typed as the frame code, "" = keep it
  bool newCode = false;
  String orientation;
};

// Opens the network apName (WPA2, apPassword) and serves the page until the frame has joined a
// network (returns true, still joined) or nobody has used the page for timeoutS (returns false).
// When a try fails and nobody's looking at the page (the phone can drop off while the frame
// joins), redraw(note) puts the setup screen back up with what went wrong.
bool runPortal(const char* apName, const char* apPassword, const PortalSettings& in, PortalResult& out,
               uint32_t timeoutS, std::function<void(const String& note)> redraw);
