import { PALETTE, PANELS } from "/dither.js";
import { frameKeys, unseal, SEAL_OVERHEAD } from "/seal.js";
import { ask } from "/dialog.js";

const $ = (id) => document.getElementById(id);
// Everything is drawn on a "panel" canvas in the panel's own pixel layout, exactly as the
// hardware does (7.3": 800×480, 13.3": 1200×1600). The screen shows it upright for how the
// frame hangs (the server says so in X-Orientation).
const panel = document.createElement("canvas");
const ctx = panel.getContext("2d");
let W = 800, H = 480, screenSize = "7.3";
function setScreen(id) {
  const p = PANELS[id] || PANELS["7.3"];
  screenSize = PANELS[id] ? id : "7.3";
  [W, H] = p.native === "landscape" ? [p.w, p.h] : [p.h, p.w];
  panel.width = W;
  panel.height = H;
  ctx.fillStyle = "rgb(232,232,232)";
  ctx.fillRect(0, 0, W, H);
}
let hang = "landscape";
let hangPending = null; // chosen here, not yet confirmed by the server
// Same for the screen size. Unlike the firmware (built for one screen, so it always says), the
// virtual frame only reports a size when one is picked here; otherwise it takes the server's,
// which is the size chosen when the frame was created on the admin page.
let screenPending = null;
// Hung the other way from how the panel's rows run: pictures arrive turned 90° clockwise
const turned = () => (hang === "portrait") !== (H > W);
function show() {
  const screen = $("screen");
  const [w, h] = turned() ? [H, W] : [W, H];
  if (screen.width !== w || screen.height !== h) { screen.width = w; screen.height = h; }
  screen.style.aspectRatio = `${w} / ${h}`;
  $("device").classList.toggle("portrait", h > w);
  $("chin-model").textContent = `${PANELS[$("screen-size").value]?.name || ""} Spectra 6`;
  const sctx = screen.getContext("2d");
  // Turn the panel back, so the picture is upright
  if (turned()) sctx.setTransform(0, -1, 1, 0, 0, W);
  else sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.drawImage(panel, 0, 0);
}
const FW = "sim-0.4";
const store = {
  get: (k) => { try { return localStorage.getItem("sim:" + k) || ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem("sim:" + k, v); } catch {} },
};

// Settings come from the URL fragment (the admin page's link, or `npm run local`), else from
// last time. The fragment holds the device key, so it's cleared from the address bar once read.
const hash = new URLSearchParams(location.hash.slice(1));
$("id").value = hash.get("id") || store.get("id");
$("key").value = hash.get("key") || store.get("key");
if (location.hash) history.replaceState(null, "", location.pathname);
// Not persisted: unlike real e-paper, this canvas is blank after a reload, so redownload.
let etag = "";
for (const f of ["id", "key"]) $(f).addEventListener("change", () => { store.set(f, $(f).value.trim()); etag = ""; });
store.set("id", $("id").value); store.set("key", $("key").value);

// ---- The frame code: made here, like the firmware does (newFrameCode in main.cpp) --------
// 16 random Crockford base32 characters. Only the SHA-256 of the access token derived from it
// is sent to the server; the code itself, and the key that opens pictures, stay here.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const frameCode = (id) => store.get(`code:${id}`);
function newFrameCode(id) {
  const code = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => CODE_ALPHABET[b & 31]).join("").match(/.{4}/g).join("-");
  store.set(`code:${id}`, code);
  store.set(`pending:${id}`, "1"); // tell the server at the next wake
  etag = "";
  log(`made a new frame code`);
  return code;
}
const sha256hex = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Register the code's token hash. Returns the HTTP status (0 on a network error). */
async function registerCode(id, key) {
  const { auth } = await frameKeys(id, frameCode(id));
  const res = await fetch(`/api/frames/${encodeURIComponent(id)}/code`, {
    method: "POST",
    headers: { "X-Device-Key": key, "content-type": "application/json" },
    body: JSON.stringify({ hash: await sha256hex(auth) }),
  });
  log(`POST /api/frames/${id}/code -> ${res.status}`);
  if (res.ok) {
    store.set(`pending:${id}`, "");
    const { cleared } = await res.json();
    if (cleared) log(`server removed ${cleared} picture(s) sealed with the old code`);
  }
  return res.status;
}

function showUploadLink(id) {
  const a = $("open-upload");
  a.hidden = !frameCode(id);
  if (!a.hidden) a.href = `/f/${id}#k=${frameCode(id)}`;
}

// The firmware's showCodeScreen(): the code in two big lines, the frame ID under it, and a QR
// code that opens the frame's page with the code filled in (after the #, so it's never sent to
// the server): beside them on a wide screen, under them on a tall one
const showCode = (id) => screen(({ w, h, rect, text, width, header, footer }) => {
  const code = frameCode(id), qrText = `${location.origin}/f/${id}#k=${code}`;
  const split = code.length === 19;
  header();
  let qr = null;
  if (window.qrcode) {
    qr = window.qrcode(0, "M");
    qr.addData(qrText);
    qr.make();
  }
  const foot = footer(qr ? "Scan with a phone camera, or" : `Enter both at ${location.host},`,
    qr ? `enter both at ${location.host}.` : "under My frame.");
  text("FRAME CODE", MARGIN, HEAD + 44, MONO_9, 3);
  let y = HEAD + 94;
  text(split ? code.slice(0, 9) : code, MARGIN, y, MONO_24, 0);
  if (split) text(code.slice(10), MARGIN, (y += 48), MONO_24, 0);
  const wide = w > h, n = qr ? qr.getModuleCount() : 0, side = qr ? (n + 8) * QR_MODULE + 6 : 0;
  const room = (qr && wide ? w - MARGIN - side - 24 : w - MARGIN) - MARGIN;
  text("FRAME ID", MARGIN, (y += 48), MONO_9, 3);
  const idFont = [MONO_18, MONO_12, MONO_9].find((f) => width(id, f) <= room) || MONO_9;
  text(id, MARGIN, (y += 34), idFont, 0);
  if (qr) {
    const top = wide ? HEAD : y + 20;
    const x0 = wide ? w - MARGIN - side : Math.floor((w - side) / 2), y0 = top + Math.floor((foot - top - side) / 2);
    rect(x0, y0, side, side, 0);
    rect(x0 + 3, y0 + 3, side - 6, side - 6, 1);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) rect(x0 + 3 + (c + 4) * QR_MODULE, y0 + 3 + (r + 4) * QR_MODULE, QR_MODULE, QR_MODULE, 0);
    }
  }
});

const showMv = () => ($("mvText").textContent = `${$("mv").value} mV`);
$("mv").addEventListener("input", showMv); showMv();

function log(msg) {
  const el = $("log");
  el.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

const rgb = (i) => `rgb(${PALETTE[i].rgb.join(",")})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// E-paper full refresh: a few flashes of the inks, then the image.
async function refresh(paint) {
  const total = Number($("speed").value) * 1000;
  if (total > 1000) {
    for (const i of [0, 1, 3, 2, 4, 5, 1]) {
      ctx.fillStyle = rgb(i); ctx.fillRect(0, 0, W, H);
      show();
      await sleep(total / 8);
    }
  }
  paint();
  show();
}

// Same layout as the messages in firmware/src/main.cpp (twice the size on the 13.3"), drawn
// upright however the frame hangs (rotation 1 when turned: the text's top is the panel's right
// edge). Fonts stand in for the firmware's Adafruit GFX ones at about the same size.
const MARGIN = 40, HEAD = 88, QR_MODULE = 5;
const SANS_18 = "bold 34px Helvetica, Arial, sans-serif", SANS_12 = "24px Helvetica, Arial, sans-serif";
const MONO_9 = "bold 18px 'Courier New', monospace", MONO_12 = "bold 23px 'Courier New', monospace";
const MONO_18 = "bold 35px 'Courier New', monospace", MONO_24 = "bold 47px 'Courier New', monospace";

const screen = (paint) => refresh(() => {
  const m = document.createElement("canvas");
  m.width = turned() ? H : W;
  m.height = turned() ? W : H;
  const k = screenSize === "13.3" ? 2 : 1;
  const c = m.getContext("2d");
  const w = m.width / k, h = m.height / k;
  const font = (f) => f.replace(/(\d+)px/, (_, px) => `${px * k}px`);
  const rect = (x, y, rw, rh, ink) => { c.fillStyle = rgb(ink); c.fillRect(x * k, y * k, rw * k, rh * k); };
  const text = (t, x, y, f, ink) => { c.font = font(f); c.fillStyle = rgb(ink); c.fillText(t, x * k, y * k); };
  const width = (t, f) => { c.font = f; return c.measureText(t).width; };
  // The wordmark with a red offset shadow and the six inks beside it, over a rule
  const header = () => {
    text("DomiFrame", MARGIN + 2, 68, SANS_18, 3);
    text("DomiFrame", MARGIN, 66, SANS_18, 0);
    const x = MARGIN + Math.ceil(width("DomiFrame", SANS_18)) + 20;
    rect(x - 2, 44, 6 * 16 + 4, 16, 0);
    [0, 4, 5, 2, 3, 1].forEach((ink, i) => rect(x + i * 16, 46, 16, 12, ink));
    rect(MARGIN, HEAD - 3, w - 2 * MARGIN, 3, 0);
  };
  // Two lines at the bottom under a thin rule; returns where the rule is
  const footer = (line1, line2) => {
    const y = h - MARGIN - 62;
    rect(MARGIN, y, w - 2 * MARGIN, 1, 0);
    text(line1, MARGIN, y + 32, SANS_12, 0);
    if (line2) text(line2, MARGIN, y + 62, SANS_12, 0);
    return y;
  };
  rect(0, 0, w, h, 1);
  paint({ w, h, rect, text, width, header, footer });
  ctx.save();
  if (turned()) ctx.setTransform(0, 1, -1, 0, W, 0);
  ctx.drawImage(m, 0, 0);
  ctx.restore();
});

const message = (title, line1, line2) => screen(({ text, header }) => {
  header();
  text(title, MARGIN, HEAD + 70, SANS_18, 0);
  text(line1, MARGIN, HEAD + 130, SANS_12, 0);
  if (line2) text(line2, MARGIN, HEAD + 166, SANS_12, 0);
});

// Same decoding as drawPacked(): 4 bpp, high nibble = left pixel
const drawPacked = (buf) => refresh(() => {
  const img = ctx.createImageData(W, H);
  const pal = PALETTE.map((p) => p.rgb);
  const d = img.data;
  for (let i = 0, o = 0; i < buf.length; i++) {
    const b = buf[i];
    let c = pal[(b >> 4) % 6];
    d[o++] = c[0]; d[o++] = c[1]; d[o++] = c[2]; d[o++] = 255;
    c = pal[(b & 0x0f) % 6];
    d[o++] = c[0]; d[o++] = c[1]; d[o++] = c[2]; d[o++] = 255;
  }
  ctx.putImageData(img, 0, 0);
});

let busy = false, drewSomething = false;
let sleepMinutes = 60; // firmware default until the server says otherwise
let serverTime = new Date();

// The local server's clock can be moved forward (scripts/local.mjs /__dev/clock).
async function clock(body) {
  const res = await fetch("/__dev/clock", body ? { method: "POST", body: JSON.stringify(body) } : {});
  return res.ok ? res.json() : null;
}
async function showClock() {
  const c = await clock();
  if (!c) {
    // Moving the clock is only for `npm run local`
    for (const el of document.querySelectorAll("[data-dev]")) el.hidden = true;
    $("clock").textContent = "";
    return;
  }
  serverTime = new Date(c.now);
  $("clock").textContent = c.offsetMinutes
    ? `Server clock: ${serverTime.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} (+${(c.offsetMinutes / 60).toFixed(1)} h)`
    : "Server clock: real time";
}
async function wake(reason) {
  if (busy) return;
  busy = true; $("key1").disabled = true; $("led").classList.add("on");
  const id = $("id").value.trim(), key = $("key").value.trim();
  log(`wake (${reason}) frame=${id} battery=${$("mv").value}mV etag=${etag || "-"}`);
  try {
    if (!frameCode(id)) newFrameCode(id);
    showUploadLink(id);
    if (store.get(`pending:${id}`)) {
      const status = await registerCode(id, key);
      if (status === 401 || status === 404) {
        await message("Frame not registered", "Hold KEY3 and press reset", "to re-enter the frame ID and key.");
        return;
      }
      if (status === 200) { await showCode(id); drewSomething = true; }
      return; // like the firmware: the code screen stays up until the next wake
    }
    const headers = { "X-Device-Key": key, "X-Battery-Mv": $("mv").value, "X-Fw": FW };
    if (etag) headers["If-None-Match"] = etag;
    if (hangPending) headers["X-Set-Orientation"] = hangPending; // like the real frame's setup portal
    if (screenPending) headers["X-Panel"] = screenPending;
    const res = await fetch(`/api/frames/${encodeURIComponent(id)}/image`, { headers, cache: "no-store" });
    const sleep = Number(res.headers.get("x-sleep-minutes")) || 0;
    if (res.ok || res.status === 304) hangPending = screenPending = null; // the server has them now
    const newScreen = res.headers.get("x-panel");
    if (newScreen && PANELS[newScreen] && newScreen !== screenSize) {
      setScreen(newScreen);
      store.set(`screen:${id}`, screenSize);
      $("screen-size").value = screenSize;
      etag = ""; // pictures for this screen size
      log(`server says the screen is ${screenSize}"`);
      show();
    }
    const newHang = res.headers.get("x-orientation");
    if (newHang && newHang !== hang) {
      hang = newHang;
      log(`frame hangs ${hang}`);
      show();
    }
    $("hang").value = hang;
    if (sleep) sleepMinutes = sleep;
    log(`GET /api/frames/${id}/image -> ${res.status}` + (sleep ? `, server says sleep ${sleep} min` : ""));
    if (res.status === 401 || res.status === 404) {
      await message("Frame not registered", "Hold KEY3 and press reset", "to re-enter the frame ID and key.");
    } else if (res.status === 200) {
      const sealed = new Uint8Array(await res.arrayBuffer());
      if (sealed.length !== (W * H) / 2 + SEAL_OVERHEAD) { log(`unexpected size ${sealed.length}`); return; }
      let buf;
      try {
        buf = new Uint8Array(await unseal((await frameKeys(id, frameCode(id))).key, sealed));
      } catch {
        log("couldn't open the picture with this frame's code; keeping the current one");
        return;
      }
      log("new picture, opened with the frame code, redrawing");
      await drawPacked(buf);
      etag = res.headers.get("etag") || "";
    } else if (res.status === 204 && !etag && !drewSomething) {
      await showCode(id); // what someone needs to send the first picture
    } else {
      log(res.status === 304 ? "unchanged, keeping picture" : "nothing to draw");
    }
    drewSomething = true;
  } catch (err) {
    log(`network error: ${err.message} (keeping current picture)`);
  } finally {
    log(`sleeping ${sleepMinutes} min`);
    await showClock();
    $("status").textContent = `Last check-in ${serverTime.toLocaleString()}, next in ${sleepMinutes} min.`;
    busy = false; $("key1").disabled = false; $("led").classList.remove("on");
    scheduleNext();
  }
}

$("key1").addEventListener("click", () => wake("KEY1"));
$("screen-size").addEventListener("change", () => {
  setScreen($("screen-size").value);
  screenPending = screenSize;
  store.set(`screen:${$("id").value.trim()}`, screenSize);
  etag = ""; // a new screen: fetch the picture made for it
  log(`screen is now ${screenSize}"; telling the server`);
  show();
  wake("screen");
});
$("hang").addEventListener("change", () => {
  hangPending = $("hang").value;
  log(`set to hang ${hangPending}; telling the server`);
  wake("orientation");
});
$("key3").addEventListener("click", () => { etag = ""; drewSomething = false; log("ETag cleared; next wake redownloads"); });
// Like holding KEY1 while pressing reset on the real frame
$("show-code").addEventListener("click", async () => {
  const id = $("id").value.trim();
  if (!frameCode(id)) return wake("new code");
  etag = ""; // the picture comes back at the next wake
  await showCode(id);
});
// Like "Make a new frame code" in the real frame's setup portal
$("new-code").addEventListener("click", async () => {
  const id = $("id").value.trim();
  if (!id) return;
  if (frameCode(id) && !(await ask({
    title: "Make a new frame code?",
    message: "The old code stops working, and all of this frame's pictures and folders are removed from the server (they were locked with the old code).",
    ok: "New code", danger: true,
  }))) return;
  newFrameCode(id);
  wake("new code");
});

// Sleep for sleepMinutes, sped up by the chosen factor (the server clock jumps to match).
let timer;
function scheduleNext() {
  clearTimeout(timer);
  const speed = Number($("auto").value);
  if (!speed) return;
  timer = setTimeout(async () => {
    if (speed > 1) await clock({ advanceMinutes: sleepMinutes });
    wake("timer");
  }, (sleepMinutes * 60e3) / speed);
}
$("auto").addEventListener("change", () => {
  const speed = Number($("auto").value);
  log(speed ? `auto wake on (${speed === 1 ? "real time" : `${speed}× speed`})` : "auto wake off");
  scheduleNext();
});
for (const b of document.querySelectorAll("[data-skip]")) {
  b.addEventListener("click", async () => {
    await clock({ advanceMinutes: Number(b.dataset.skip) });
    wake(`+${b.textContent.slice(1)}`);
  });
}
$("clock-reset").addEventListener("click", async () => { await clock({ reset: true }); showClock(); log("server clock reset to real time"); });
showClock();

// Blank panel until first wake, like a fresh device.
// The size from the admin page's link, or what this frame was last time; the server's reply
// to the first check-in settles it either way
setScreen(hash.get("screen") || store.get(`screen:${$("id").value.trim()}`) || "7.3");
$("screen-size").value = screenSize;
ctx.fillStyle = rgb(1); ctx.fillRect(0, 0, W, H);
show();
if ($("id").value && $("key").value) wake("boot");
else message("Wi-Fi setup", "Enter the frame ID and device key below,", "then press KEY1.");
