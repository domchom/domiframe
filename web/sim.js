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

// The same words as the firmware's code screen
const showCode = (id) =>
  message(frameCode(id), `Frame ID: ${id}`, `Use both at ${location.host}`);

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

// Same layout as showMessage() in firmware/src/main.cpp (doubled on the 13.3"), drawn upright
// however the frame hangs (rotation 1 when turned: the text's top is the panel's right edge)
const message = (title, line1, line2) => refresh(() => {
  const m = document.createElement("canvas");
  m.width = turned() ? H : W;
  m.height = turned() ? W : H;
  const k = screenSize === "13.3" ? 2 : 1;
  const c = m.getContext("2d");
  c.fillStyle = rgb(1); c.fillRect(0, 0, m.width, m.height);
  c.fillStyle = rgb(0);
  c.font = `bold ${34 * k}px Helvetica, Arial, sans-serif`; c.fillText(title, 40 * k, 120 * k);
  c.font = `${24 * k}px Helvetica, Arial, sans-serif`; c.fillText(line1, 40 * k, 190 * k);
  if (line2) c.fillText(line2, 40 * k, 230 * k);
  [3, 2, 5, 4].forEach((b, i) => { c.fillStyle = rgb(b); c.fillRect((40 + i * 60) * k, 400 * k, 60 * k, 12 * k); });
  ctx.save();
  if (turned()) ctx.setTransform(0, 1, -1, 0, W, 0);
  ctx.drawImage(m, 0, 0);
  ctx.restore();
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
    headers["X-Panel"] = screenSize; // the firmware reports the screen it was built for
    const res = await fetch(`/api/frames/${encodeURIComponent(id)}/image`, { headers, cache: "no-store" });
    const sleep = Number(res.headers.get("x-sleep-minutes")) || 0;
    if (res.ok || res.status === 304) hangPending = null; // the server has it now
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
  store.set("screen", screenSize);
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
setScreen(hash.get("screen") || store.get("screen") || "7.3");
$("screen-size").value = screenSize;
ctx.fillStyle = rgb(1); ctx.fillRect(0, 0, W, H);
show();
if ($("id").value && $("key").value) wake("boot");
else message("Wi-Fi setup", "Enter the frame ID and device key below,", "then press KEY1.");
