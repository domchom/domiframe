// The Wi-Fi setup page (see portal.h). One page, styled like domiframe.art: the networks the
// frame can see, a password, how it hangs, and the frame's own details tucked away once it has
// them. Plain HTML forms, so it works in any phone's sign-in sheet; a few lines of script only
// make it nicer. Every page is built here, small enough to send in one go.

#include "portal.h"

#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>

#include <algorithm>
#include <vector>

#include "pixel_font.h"

namespace {

const IPAddress AP_IP(192, 168, 4, 1);

WebServer* server;
DNSServer dns;
const PortalSettings* in_;
PortalResult* out_;

struct Net { String ssid; int rssi; bool open; int channel; };
std::vector<Net> nets;

// A try at joining the network picked on the page. The page waits on /result meanwhile.
enum class Try { None, Connecting, Joined, Failed };
Try state;
String trySsid, tryPass;
String failNote;    // why the last try failed, for the page (HTML)
String screenNote;  // the same, short and plain, for the frame's screen
uint32_t tryStart, tryEnd, joinedSeenAt;
bool resultSeen;    // the page has shown how the last try went
volatile uint8_t lastReason;  // the Wi-Fi driver's reason for the last disconnect

uint32_t lastActivity;  // the page was last used (the phone's own captive checks don't count)
void activity() { lastActivity = millis(); }

String esc(const String& s) {
  String o;
  o.reserve(s.length() + 8);
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '&') o += "&amp;";
    else if (c == '<') o += "&lt;";
    else if (c == '>') o += "&gt;";
    else if (c == '"') o += "&quot;";
    else if (c == '\'') o += "&#39;";
    else o += c;
  }
  return o;
}

// For the frame's screen: its fonts are plain ASCII, and the line has to fit
String plain(const String& s, size_t max) {
  String o;
  for (size_t i = 0; i < s.length(); i++) if (s[i] >= 0x20 && s[i] < 0x7F) o += s[i];
  if (o.length() > max) o = o.substring(0, max - 3) + "...";
  return o;
}

// The networks in range, strongest first, each name once
void scan() {
  int n = WiFi.scanNetworks();
  nets.clear();
  for (int i = 0; i < n; i++) {
    String s = WiFi.SSID(i);
    if (!s.length()) continue;  // hidden: "Other network" is for those
    auto it = std::find_if(nets.begin(), nets.end(), [&](const Net& x) { return x.ssid == s; });
    if (it != nets.end()) {
      if (WiFi.RSSI(i) > it->rssi) { it->rssi = WiFi.RSSI(i); it->channel = WiFi.channel(i); }
      continue;
    }
    nets.push_back({s, WiFi.RSSI(i), WiFi.encryptionType(i) == WIFI_AUTH_OPEN, WiFi.channel(i)});
  }
  WiFi.scanDelete();
  std::sort(nets.begin(), nets.end(), [](const Net& a, const Net& b) { return a.rssi > b.rssi; });
  if (nets.size() > 30) nets.resize(30);
}

// ---- Pages --------------------------------------------------------------------------

// The site's colors (web/style.css): the panel's white and black inks, red for the accent
const char CSS[] = R"CSS(
:root{--bg:#e8e8e8;--card:#fbfbf8;--ink:#191e21;--muted:#5c6166;--soft:#b9bcbe;--accent:#b21318;--blue:#2157ba;--ok:#125f20;color-scheme:light}
@media(prefers-color-scheme:dark){:root{--bg:#111416;--card:#191e21;--ink:#e8e8e8;--muted:#9ba1a6;--soft:#3b4247;--accent:#e0454a;--blue:#7ea6f2;--ok:#6fbf7e;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.45 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:460px;margin:0 auto;padding:18px 16px 40px}
header{display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;border-bottom:3px solid var(--ink);margin-bottom:24px}
.wm{height:30px;width:auto;color:var(--ink)}
.inks{display:flex;border:2px solid var(--ink);height:16px}.inks i{width:13px}
h1{font-size:28px;line-height:1.15;margin:0 0 8px;letter-spacing:-.01em}
p{margin:0 0 12px}
.lede{color:var(--muted)}
.label{display:block;font:700 12px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin:26px 0 10px}
.card{background:var(--card);border:2px solid var(--ink);box-shadow:4px 4px 0 var(--ink)}
.net{display:flex;align-items:center;gap:10px;padding:13px 14px;border-top:1px solid var(--soft);cursor:pointer}
.net:first-child{border-top:0}
.net:has(input:checked){background:var(--bg)}
input[type=radio],input[type=checkbox]{accent-color:var(--accent);width:20px;height:20px;margin:0;flex:none}
.n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.tag{font-size:13px;color:var(--muted);white-space:nowrap}
.lock{flex:none;color:var(--muted)}
.b{display:inline-flex;align-items:flex-end;gap:2px;height:14px;flex:none}.b i{width:3px;background:var(--soft)}
.b i:nth-child(1){height:4px}.b i:nth-child(2){height:7px}.b i:nth-child(3){height:10px}.b i:nth-child(4){height:14px}
.b1 i:nth-child(-n+1),.b2 i:nth-child(-n+2),.b3 i:nth-child(-n+3),.b4 i{background:var(--ink)}
.other input[name=hs]{flex:1;min-width:0;border:0;border-bottom:1px solid var(--soft);padding:2px 0;background:none;font:inherit;color:inherit}
.hint{font-size:14px;color:var(--muted);margin:12px 0 0}
a{color:var(--blue)}
.field{display:block;width:100%;font:inherit;padding:12px 14px;border:2px solid var(--ink);border-radius:0;background:var(--card);color:var(--ink)}
.field::placeholder{color:var(--muted)}
.check{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:15px}
.hang{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.tile{display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px 10px 12px;cursor:pointer}
.tile:has(input:checked){outline:3px solid var(--accent);outline-offset:-3px}
.pic{display:block;border:4px solid var(--ink);background:linear-gradient(var(--blue) 55%,var(--ok) 55%)}
.land{width:64px;height:44px;margin:10px 0}.port{width:44px;height:64px}
.tile span{font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px}
summary{cursor:pointer;color:var(--muted);font-size:15px;margin-top:26px}
.sub{font-size:15px;font-weight:600;margin:16px 0 6px;display:block}
.go{display:block;width:100%;margin-top:30px;padding:15px;font:inherit;font-size:18px;font-weight:700;background:var(--accent);color:#fff;border:2px solid var(--ink);box-shadow:4px 4px 0 var(--ink);border-radius:0;cursor:pointer}
.go:disabled{opacity:.7}
.msg{background:var(--card);border:2px solid var(--accent);border-left-width:8px;padding:12px 14px;margin:0 0 20px}
.msg.ok{border-color:var(--ok)}
.spin{width:34px;height:34px;border:4px solid var(--soft);border-top-color:var(--accent);border-radius:50%;animation:s 1s linear infinite;margin:10px 0 22px}
@keyframes s{to{transform:rotate(1turn)}}
)CSS";

// The wordmark's pixel letters (pixel_font.h), as on the website, the app and the frame's
// screens, with the red dithered shadow one dot down and right
const String& wordmark() {
  static String svg;
  if (svg.length()) return svg;
  String d;
  int x = 0;
  for (const char* p = "DomiFrame"; *p; p++) {
    const PfGlyph* g = nullptr;
    for (const PfGlyph& k : PF_WORD) if (k.c == *p) g = &k;
    if (!g) continue;
    for (int r = 0; r < PF_CAP; r++)
      for (int c = 0; c < g->w;) {
        if (g->rows[r][c] != '#') { c++; continue; }
        int run = 0;
        while (c + run < g->w && g->rows[r][c + run] == '#') run++;
        d += "M" + String(x + c) + " " + String(r) + "h" + String(run) + "v1h-" + String(run) + "z";
        c += run;
      }
    x += g->w + PF_SPACING;
  }
  int w = x - PF_SPACING + 1;
  // 30px tall for 11 dots: the shadow's checkerboard is one CSS pixel a square
  svg = "<svg class=wm role=img aria-label=DomiFrame viewBox='0 0 " + String(w) + " " + String(PF_CAP + 1) +
        "'><defs><pattern id=dz width=.733 height=.733 patternUnits=userSpaceOnUse>"
        "<path style=fill:var(--accent) d='M0 0h.367v.367H0zM.367 .367h.367v.367H.367z'/></pattern>"
        "<path id=wd d='" + d + "'/></defs><use href=#wd x=1 y=1 fill='url(#dz)'/><use href=#wd fill=currentColor /></svg>";
  return svg;
}

String head(const char* title, int refresh = 0) {
  String h;
  h.reserve(9000);
  h += "<!doctype html><html lang=en><head><meta charset=utf-8>"
       "<meta name=viewport content='width=device-width,initial-scale=1'>"
       "<meta name=format-detection content='telephone=no'>";
  if (refresh) h += "<meta http-equiv=refresh content='" + String(refresh) + ";url=/result'>";
  h += "<title>";
  h += title;
  h += "</title><style>";
  h += CSS;
  h += "</style></head><body><main><header>";
  h += wordmark();
  h += "<span class=inks aria-hidden=true><i style=background:#191e21></i><i style=background:#2157ba></i>"
       "<i style=background:#125f20></i><i style=background:#efde44></i><i style=background:#b21318></i>"
       "<i style=background:#e8e8e8></i></span></header>";
  return h;
}

const char FOOT[] = "</main></body></html>";

void send(const String& page) {
  server->sendHeader("Cache-Control", "no-store");
  server->send(200, "text/html; charset=utf-8", page);
}

void redirect(const char* to, int code = 302) {
  server->sendHeader("Location", to, true);
  server->send(code, "text/plain", "");
}

const char LOCK[] =
    "<svg class=lock viewBox='0 0 10 12' width=11 height=13 aria-label=Locked>"
    "<path fill=currentColor d='M2 5V3.5a3 3 0 0 1 6 0V5h1v7H1V5zm1.5 0h3V3.5a1.5 1.5 0 0 0-3 0z'/></svg>";

String bars(int rssi) {
  int b = rssi >= -55 ? 4 : rssi >= -67 ? 3 : rssi >= -75 ? 2 : 1;
  return "<span class='b b" + String(b) + "' aria-label='Signal " + String(b) + " of 4'><i></i><i></i><i></i><i></i></span>";
}

String netRow(const String& ssid, bool open, int rssi, bool checked) {
  bool saved = in_->savedSsid.length() && ssid == in_->savedSsid;
  String r = "<label class=net><input type=radio name=s required value='" + esc(ssid) + "'";
  if (open) r += " data-open";
  if (saved) r += " data-saved";
  if (checked) r += " checked";
  r += "><span class=n>" + esc(ssid) + "</span>";
  if (saved) r += "<span class=tag>Saved</span>";
  if (!open) r += LOCK;
  r += bars(rssi);
  return r + "</label>";
}

String hangTile(const char* value, const char* label, const char* pic, const String& current) {
  return String("<label class='card tile'><i class='pic ") + pic + "'></i><span><input type=radio name=orient value=" +
         value + (current == value ? " checked" : "") + ">" + label + "</span></label>";
}

void handleHome() {
  activity();
  if (state == Try::Connecting || state == Try::Joined) return redirect("/result");
  if (server->hasArg("rescan")) scan();
  if (state == Try::Failed) resultSeen = true;

  bool needsDetails = !in_->frameId.length() || !in_->hasKey;  // not set up for anyone yet
  // Picked to start with: the network the last try was for, or else the saved one, if it's here
  // (a frame that has moved shouldn't offer its old home's network)
  String pick = state == Try::Failed ? trySsid : "";
  for (const Net& n : nets) if (!pick.length() && n.ssid == in_->savedSsid) pick = n.ssid;
  String id = out_->frameId.length() ? out_->frameId : in_->frameId;
  String orient = out_->orientation.length() ? out_->orientation : in_->orientation;

  String h = head("Set up Wi-Fi");
  h += "<h1>Connect your frame to <span style=white-space:nowrap>Wi-Fi</span></h1><p class=lede>Pick the Wi-Fi network it should use.</p>";
  if (state == Try::Failed && failNote.length()) h += "<p class=msg role=alert>" + failNote + "</p>";
  h += "<form method=post action=/connect>";

  h += "<span class=label>Wi-Fi network</span><div class='card nets'>";
  for (const Net& n : nets) h += netRow(n.ssid, n.open, n.rssi, n.ssid == pick);
  h += "<label class='net other'><input type=radio name=s value='' id=o required>"
       "<input name=hs maxlength=32 placeholder='Other network' aria-label='Other network name' autocapitalize=off "
       "autocorrect=off spellcheck=false oninput=\"document.getElementById('o').checked=true;u()\"></label></div>";
  h += "<p class=hint>Don't see yours? Frames can only use 2.4 GHz Wi-Fi. <a href='/?rescan=1'>Look again</a></p>";

  h += "<label class=label for=p>Wi-Fi password</label>"
       "<input class=field id=p name=p type=password maxlength=64 autocomplete=off autocapitalize=off autocorrect=off spellcheck=false>"
       "<label class=check><input type=checkbox id=sp> Show password</label>";

  h += "<span class=label>How will it hang?</span><div class=hang>";
  h += hangTile("landscape", "Wide", "land", orient);
  h += hangTile("portrait", "Tall", "port", orient);
  h += "</div>";

  // The frame's own details: whoever sets it up first enters them. After that they're tucked
  // away, so someone given the frame only sees the Wi-Fi. The key and code are never shown.
  String details =
      "<label class=sub for=id>Frame ID</label><input class=field id=id name=id maxlength=32 autocapitalize=off "
      "autocorrect=off spellcheck=false value='" + esc(id) + "'" + (needsDetails ? " required" : "") + ">"
      "<label class=sub for=key>Device key</label><input class=field id=key name=key maxlength=64 autocomplete=off "
      "autocapitalize=off autocorrect=off spellcheck=false" + (in_->hasKey ? " placeholder='Leave blank to keep it'" : " required") + ">";
  if (in_->hasCode) {
    details += "<label class=sub for=code>Frame code</label><input class=field id=code name=code maxlength=24 autocomplete=off "
               "autocapitalize=characters autocorrect=off spellcheck=false placeholder='Leave blank to keep it'>"
               "<label class=check><input type=checkbox name=newcode value=1> Make a new frame code</label>"
               "<p class=hint>The old code stops working and its pictures are put away. Typing the old code here "
               "within 30 days brings them back.</p>";
  } else {
    details += "<label class=sub for=code>Frame code, if it had one before</label><input class=field id=code name=code "
               "maxlength=24 autocomplete=off autocapitalize=characters autocorrect=off spellcheck=false>"
               "<p class=hint>Keeps the pictures sent with it. Leave blank for a new code.</p>";
  }
  if (needsDetails) {
    h += "<span class=label>This frame</span><p class=hint style=margin-top:0>From the admin page at domiframe.art.</p>" + details;
  } else {
    h += "<details><summary>Frame details</summary>" + details + "</details>";
  }

  h += "<button class=go>Connect</button></form>";
  h += R"JS(<script>
var p=document.getElementById('p');
function u(){var r=document.querySelector('input[name=s]:checked'),o=r&&r.hasAttribute('data-open');
p.disabled=!!o;p.placeholder=o?'No password needed':r&&r.hasAttribute('data-saved')?'Leave blank to keep the saved one':'';}
document.querySelectorAll('input[name=s]').forEach(function(r){r.addEventListener('change',u)});u();
document.getElementById('sp').onchange=function(){p.type=this.checked?'text':'password'};
document.querySelector('form').addEventListener('submit',function(){var b=document.querySelector('.go');setTimeout(function(){b.disabled=true;b.textContent='Connecting…'},0)});
</script>)JS";
  h += FOOT;
  send(h);
}

void fail(const String& note, const String& onScreen) {
  failNote = note;
  screenNote = onScreen;
  state = Try::Failed;
  tryEnd = millis();
  resultSeen = false;
}

void handleConnect() {
  activity();
  if (state == Try::Connecting) return redirect("/result", 303);

  String ssid = server->arg("s");
  if (!ssid.length()) ssid = server->arg("hs");
  String pass = server->arg("p");
  if (!pass.length() && ssid == in_->savedSsid) pass = in_->savedPass;

  String id = server->arg("id");
  id.trim();
  out_->frameId = id.length() ? id : in_->frameId;
  out_->deviceKey = server->arg("key");
  out_->code = server->arg("code");
  out_->newCode = server->arg("newcode") == "1";
  out_->orientation = server->arg("orient");

  trySsid = ssid;
  if (!ssid.length() || ssid.length() > 32) {
    fail("Pick your Wi-Fi network, or type its name next to <b>Other network</b>.", "");
    resultSeen = true;
    return redirect("/", 303);
  }
  if (!out_->frameId.length() || (!in_->hasKey && !out_->deviceKey.length())) {
    fail("Enter the frame ID and device key from the admin page.", "");
    resultSeen = true;
    return redirect("/", 303);
  }

  tryPass = pass;
  state = Try::Connecting;
  resultSeen = false;
  tryStart = millis();
  WiFi.disconnect(false);
  lastReason = 0;
  WiFi.begin(trySsid.c_str(), tryPass.length() ? tryPass.c_str() : nullptr);
  redirect("/result", 303);
}

void pollTry() {
  if (state != Try::Connecting) return;
  if (WiFi.status() == WL_CONNECTED) {
    state = Try::Joined;
    tryEnd = millis();
    return;
  }
  uint8_t r = lastReason;
  uint32_t t = millis() - tryStart;
  // The driver keeps retrying by itself: give it a few goes before deciding
  if (!(r && t > 8000) && t < 20000) return;

  WiFi.disconnect(false);
  String name = "&ldquo;" + esc(trySsid) + "&rdquo;";
  String shortName = "\"" + plain(trySsid, 18) + "\"";
  bool wrongPass = r == WIFI_REASON_AUTH_FAIL || r == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT ||
                   r == WIFI_REASON_HANDSHAKE_TIMEOUT || r == WIFI_REASON_AUTH_EXPIRE || r == WIFI_REASON_MIC_FAILURE;
  if (wrongPass) {
    fail("That password didn't work for " + name + ". Check it and try again.",
         "Wrong password for " + shortName + ".");
  } else if (r == WIFI_REASON_NO_AP_FOUND) {
    fail("The frame couldn't find " + name + ". Is it close enough? Frames can only use 2.4 GHz Wi-Fi.",
         "Couldn't find " + shortName + ".");
  } else {
    fail("The frame couldn't join " + name + ". Try again, or pick another network.",
         "Couldn't join " + shortName + ".");
  }
}

void handleResult() {
  activity();
  if (state == Try::Connecting) {
    String h = head("Connecting", 2);
    h += "<div class=spin aria-hidden=true></div><h1>Connecting to &ldquo;" + esc(trySsid) +
         "&rdquo;&hellip;</h1><p class=lede>This takes a few seconds.</p>";
    send(h + FOOT);
  } else if (state == Try::Joined) {
    if (!resultSeen) joinedSeenAt = millis();
    resultSeen = true;
    String h = head("All set");
    h += "<h1>All set</h1><p class='msg ok'>Your frame is on &ldquo;" + esc(trySsid) + "&rdquo;.</p>";
    h += in_->hasCode && !out_->newCode
             ? "<p>Its picture will be back on the screen in a minute or so.</p>"
             : "<p>In a minute or so it shows its frame code. Type it at domiframe.art to send it pictures.</p>";
    h += "<p class=lede>You can close this page.</p>";
    send(h + FOOT);
  } else {
    redirect("/");
  }
}

}  // namespace

bool runPortal(const char* apName, const char* apPassword, const PortalSettings& in, PortalResult& out,
               uint32_t timeoutS, std::function<void(const String& note)> redraw) {
  in_ = &in;
  out_ = &out;
  out = PortalResult();
  state = Try::None;
  failNote = screenNote = "";

  WiFi.persistent(false);  // the frame saves the network itself, once it has joined it
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false);
  scan();

  // The frame's network has to share a channel with the one it joins, so a phone on it can drop
  // off when the frame switches. Start where it'll most likely end up: the saved network's
  // channel, or else the strongest network's.
  int channel = nets.empty() ? 1 : nets[0].channel;
  for (const Net& n : nets) if (n.ssid == in.savedSsid) channel = n.channel;

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAPConfig(AP_IP, AP_IP, IPAddress(255, 255, 255, 0));
  if (!WiFi.softAP(apName, apPassword, channel)) {
    WiFi.mode(WIFI_OFF);
    return false;
  }
  dns.setErrorReplyCode(DNSReplyCode::NoError);
  dns.start(53, "*", AP_IP);  // every name leads here, which is what opens the phone's sign-in sheet

  WebServer srv(80);
  server = &srv;
  srv.on("/", HTTP_GET, handleHome);
  srv.on("/connect", HTTP_POST, handleConnect);
  srv.on("/result", HTTP_GET, handleResult);
  // Anything else (the phone checking for internet, say) goes to the page
  srv.onNotFound([] { redirect("http://192.168.4.1/"); });
  srv.begin();

  wifi_event_id_t onDrop = WiFi.onEvent(
      [](WiFiEvent_t, WiFiEventInfo_t info) {
        uint8_t r = info.wifi_sta_disconnected.reason;
        if (r != WIFI_REASON_ASSOC_LEAVE) lastReason = r;  // that one's the frame's own disconnect
      },
      ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

  activity();
  bool joined = false, redrawn = false;
  uint32_t failedAt = 0;
  for (;;) {
    dns.processNextRequest();
    srv.handleClient();
    pollTry();

    if (state == Try::Joined) {
      // Let the page show it worked, if the phone's still there, then close
      if ((resultSeen && millis() - joinedSeenAt > 2000) || millis() - tryEnd > 10000) {
        joined = true;
        break;
      }
    } else if (state == Try::Failed) {
      if (tryEnd != failedAt) { failedAt = tryEnd; redrawn = false; }
      // Nobody came back to the page: the phone probably dropped off, so say it on the screen
      if (!resultSeen && !redrawn && screenNote.length() && millis() - tryEnd > 8000) {
        redraw(screenNote);
        redrawn = true;
        activity();
      }
    }
    if (state != Try::Connecting && state != Try::Joined && millis() - lastActivity > timeoutS * 1000UL) break;
    delay(2);
  }

  WiFi.removeEvent(onDrop);
  srv.stop();
  dns.stop();
  server = nullptr;
  WiFi.softAPdisconnect(true);  // stays joined to the network it picked, if it did
  if (joined) {
    out.ssid = trySsid;
    out.pass = tryPass;
  } else {
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
  }
  nets.clear();
  return joined;
}
