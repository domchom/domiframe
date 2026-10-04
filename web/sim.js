import { PALETTE, PANELS } from "/dither.js";
import { frameKeys, unseal, SEAL_OVERHEAD } from "/seal.js";
import { ask } from "/dialog.js";
import { layout, CAP, CODE_GLYPHS, CODE_W, CODE_H } from "/pixelfont.js";

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
    const { putAway, restored } = await res.json();
    if (putAway) log(`server put aside ${putAway} picture(s) sealed with the old code`);
    if (restored) log(`server brought back ${restored} picture(s) sealed with this code`);
  }
  return res.status;
}

function showUploadLink(id) {
  const a = $("open-upload");
  a.hidden = !frameCode(id);
  if (!a.hidden) a.href = `/f/${id}#k=${frameCode(id)}`;
}

// ---- The code screen (the firmware's showCodeScreen) -----------------------------------
// A friendly card for setting the frame up, in the six inks: the app's icon and the wordmark,
// a headline, the frame ID and then the code in pale fields (sparse blue dots on white read as
// pale blue), the QR code in a card under a blue SCAN TO OPEN bar, and a little picture of a
// frame on a shelf. The code reads like a line of text: red dashes between its groups, two lines
// when it doesn't fit on one. Everything is drawn from rectangles, as on the frame.

// Pixel art, one letter an ink: k black, w white, r red, y yellow, g green, b blue, o orange
// (red and yellow dithered), . nothing. The same in firmware/src/main.cpp.
const ART_PAINTING = [ // the app icon's painting: sunset, hills, water
  "rrrrrrrrrrrrrrrr", "ooooooooooowwwoo", "oooooooooowwwwwo", "yyyyyyyyyyywwwyy",
  "yyyyggyyyyyyyyyy", "yyygggggyyggyyyy", "yygggggggggggyyy", "gggggggggggggggg",
  "bbbbbbbbbbbwbbbb", "bbbbbbbbbbwbwbbb", "bbbbbbbbbbbwbbbb", "bbbbbbbbbbbbbbbb",
];
const ART_PLANT = [
  ".....g..g.....", "....gg..gg....", "...ggg..ggg...", "g..gggggggg..g", "gg..gggggg..gg", "ggg..gggg..ggg", ".ggg.gggg.ggg.", "..gggggggggg..", "...gggggggg...", "....gggggg....", ".....gggg.....", "......gg......",
];
const ART_POT = [
  "kkkkkkkkkkkk", "kooooooooook", "kkkkkkkkkkkk", ".kooooooook.", ".kooooooook.", ".kooooooook.", "..kooooook..", "..kkkkkkkk..",
];
const ART_PHONE = [
  ".kkkkkkkkk.", "kkkkwwwkkkk", "kkkkkkkkkkk", "kbbbbbbbbbk", "kbwwwwwwwbk", "kbwkkwkkwbk", "kbwkkwkkwbk", "kbwwwwwwwbk", "kbwkkwkwwbk", "kbwkkwwkwbk", "kbwwwwwwwbk", "kbbbbbbbbbk", "kkkkkkkkkkk", "kkkkwwwkkkk", ".kkkkkkkkk.",
];
const ART_INK = { k: 0, w: 1, y: 2, r: 3, b: 4, g: 5 };

const showCode = (id) => screen(({ w, h, rect, text, width }) => {
  const code = frameCode(id), qrText = `${location.origin}/f/${id}#k=${code}`;
  let qr = null;
  if (window.qrcode) {
    qr = window.qrcode(0, "M");
    qr.addData(qrText);
    qr.make();
  }
  const dot = (x, y, ink) => rect(x, y, 1, 1, ink);
  // A rounded rectangle, a row at a time: pick(x, y) -> ink, or null for none
  const round = (x, y, rw, rh, r, pick) => {
    for (let dy = 0; dy < rh; dy++) {
      const e = dy < r ? r - dy - 0.5 : dy >= rh - r ? dy - (rh - r) + 0.5 : 0;
      const inset = e ? Math.round(r - Math.sqrt(Math.max(0, r * r - e * e))) : 0;
      for (let dx = inset; dx < rw - inset; dx++) {
        const ink = pick(x + dx, y + dy);
        if (ink != null) dot(x + dx, y + dy, ink);
      }
    }
  };
  const solid = (ink) => () => ink;
  // Pale blue: 1 dot in 8, on a staggered grid so it reads as a flat tint, not stripes
  const tint = (xx, yy) => ((yy & 1) === 0 && (xx & 3) === (yy & 2) ? 4 : 1);
  const checker = (ink) => (xx, yy) => ((xx + yy) & 1 ? null : ink);
  const art = (rows, x, y, sc) => rows.forEach((r, ry) => [...r].forEach((c, rx) => {
    if (c === ".") return;
    if (c === "o") { for (let a = 0; a < sc; a++) for (let b = 0; b < sc; b++) dot(x + rx * sc + a, y + ry * sc + b, (a + b) & 1 ? 2 : 3); return; }
    rect(x + rx * sc, y + ry * sc, sc, sc, ART_INK[c]);
  }));
  const pixelWord = (t, x, top, sc, ink) => {
    const rows = layout(t);
    rows.forEach((r, y) => [...r].forEach((d, x2) => d === "#" && round(x + (x2 + 1) * sc, top + (y + 1) * sc, sc, sc, 0, checker(3))));
    rows.forEach((r, y) => [...r].forEach((d, x2) => d === "#" && rect(x + x2 * sc, top + y * sc, sc, sc, ink)));
    return rows[0].length * sc;
  };
  const codeLines = (sc, perLine) => {
    const groupW = 4 * CODE_W * sc + 3 * sc + CODE_BOLD, dashW = 5 * sc; // a space, the dash, a space
    return { groupW, dashW, lineW: perLine * groupW + (perLine - 1) * dashW + (perLine < 4 ? dashW : 0) };
  };

  // Header: the icon, the wordmark and what it is, the inks at the right, over a rule
  round(MARGIN, 24, 44, 36, 5, solid(0));
  rect(MARGIN + 3, 27, 38, 30, 1);
  art(ART_PAINTING, MARGIN + 6, 30, 2);
  pixelWord("DomiFrame", MARGIN + 58, 24, 3, 0);
  text("COLOR E-PAPER PHOTO FRAMES", MARGIN + 58, 74, LABEL, 0);
  const sx = w - MARGIN - 6 * 16 - 4;
  rect(sx, 31, 6 * 16 + 4, 16, 0); // centred on the wordmark
  [0, 4, 5, 2, 3, 1].forEach((ink, i) => rect(sx + 2 + i * 16, 33, 16, 12, ink));
  rect(MARGIN, 92, w - 2 * MARGIN, 2, 0);

  const wide = w > h;
  const n = qr ? qr.getModuleCount() : 0, qside = qr ? (n + 4) * QR_MODULE : 0;
  const cardW = qside + 24, cardH = qside + 24 + 30;
  const cardX = wide ? w - MARGIN - cardW - CARD_SHADOW : Math.floor((w - cardW) / 2);
  const colW = (qr && wide ? cardX - 30 : w - MARGIN) - MARGIN;

  // A taller screen (the 13.3" landscape) has room to spare: some above, a little between
  const ex = Math.max(0, h - 480);

  // Headline
  let y = 134 + Math.floor(ex * 2 / 5);
  text("Add this frame", MARGIN, y, SANS_18, 0);
  text("to your phone", MARGIN, (y += 36), SANS_18, 0);

  // The frame ID, in a pale field
  text("FRAME ID", MARGIN, (y += 40 + Math.floor(ex / 10)), LABEL, 3);
  round(MARGIN, (y += 8), colW, 48, 7, tint);
  const idFont = [ID_L, ID_M, ID_S].find((f) => width(id, f) + 32 <= colW) || ID_S;
  text(id, MARGIN + 16, y + 34, idFont, 0);

  // The code, in a pale field: one line at the biggest size that fits, else two
  text("FRAME CODE", MARGIN, (y += 48 + 30 + Math.floor(ex / 10)), LABEL, 3);
  const pad = 14;
  let sc = [6, 5, 4].find((k) => codeLines(k, 4).lineW + 2 * pad <= colW), perLine = 4;
  if (!sc) { perLine = 2; sc = [6, 5, 4, 3].find((k) => codeLines(k, 2).lineW + 2 * pad <= colW) || 3; }
  const { groupW, dashW } = codeLines(sc, perLine), lines = 4 / perLine, lineH = CODE_H * sc, gap = 3 * sc;
  const fieldH = lines * lineH + (lines - 1) * gap + 2 * pad;
  round(MARGIN, (y += 8), colW, fieldH, 7, tint);
  code.split("-").forEach((g, k) => {
    const gx = MARGIN + pad + (k % perLine) * (groupW + dashW), gy = y + pad + Math.floor(k / perLine) * (lineH + gap);
    [...g].forEach((c, i) => {
      const rows = CODE_GLYPHS[c] || [], ink = /[0-9]/.test(c) ? 4 : 0;
      rows.forEach((r, ry) => [...r].forEach((d, rx) => d === "#" &&
        rect(gx + i * (CODE_W + 1) * sc + rx * sc, gy + ry * sc, sc + CODE_BOLD, sc, ink)));
    });
    if (k < 3) rect(gx + groupW + sc, gy + 3 * sc, 3 * sc, sc, 3);
  });
  y += fieldH;

  // The QR code, in a card under a blue bar, with blue corner marks
  let cardY = 104 + Math.floor(ex * 2 / 5);
  if (qr) {
    if (!wide) cardY = y + 28;
    round(cardX + CARD_SHADOW, cardY + CARD_SHADOW, cardW, cardH, 10, checker(0));
    round(cardX, cardY, cardW, cardH, 10, (xx, yy) => (yy < cardY + 30 ? 4 : 1));
    // its outline, in blue
    round(cardX, cardY, cardW, cardH, 10, (xx, yy) => {
      const inside = (x2, y2) => x2 >= cardX + 2 && x2 < cardX + cardW - 2 && y2 >= cardY + 2 && y2 < cardY + cardH - 2;
      return inside(xx, yy) ? null : 4;
    });
    const label = "SCAN TO OPEN";
    text(label, cardX + Math.floor((cardW - width(label, LABEL)) / 2), cardY + 21, LABEL, 1);
    const qx = cardX + 12, qy = cardY + 30 + 12;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) rect(qx + (c + 2) * QR_MODULE, qy + (r + 2) * QR_MODULE, QR_MODULE, QR_MODULE, 0);
    }
    const L = 18, T = 4, x1 = qx - 2, y1 = qy - 2, x2 = qx + qside + 2, y2 = qy + qside + 2;
    for (const [cx, cy, sx2, sy2] of [[x1, y1, 1, 1], [x2, y1, -1, 1], [x1, y2, 1, -1], [x2, y2, -1, -1]]) {
      rect(sx2 > 0 ? cx : cx - L, sy2 > 0 ? cy : cy - T, L, T, 4);
      rect(sx2 > 0 ? cx : cx - T, sy2 > 0 ? cy : cy - L, T, L, 4);
    }
  }

  // How to use it, by a phone: level with the shelf, so the bottom reads as one band
  const shelfY = h - MARGIN, shelfW = 190, shelfX = w - MARGIN - shelfW;
  const ty = Math.max((wide || !qr ? y : cardY + cardH) + 46, wide ? shelfY - 28 : 0);
  art(ART_PHONE, MARGIN, ty - 22, 2);
  text(qr ? "Scan the QR code with a phone's camera," : "Enter the ID and code at", MARGIN + 38, ty, SANS_12, 0);
  text(qr ? "or enter the ID and code at domiframe.art." : "domiframe.art, under My frame.", MARGIN + 38, ty + 26, SANS_12, 0);

  // A frame on a shelf, beside a plant: in the corner, where there's room
  if (wide && qr && shelfY - 64 > cardY + cardH + CARD_SHADOW + 8) {
    round(shelfX, shelfY, shelfW, 10, 3, (xx, yy) => ((xx + yy) & 1 ? 2 : 3));
    rect(shelfX, shelfY, shelfW, 2, 0);
    const fx = shelfX + shelfW - 82, fy = shelfY - 56;
    round(fx, fy, 72, 56, 6, solid(0));
    art(ART_PAINTING, fx + 4, fy + 4, 4);
    art(ART_POT, shelfX + 18, shelfY - 16, 2);
    art(ART_PLANT, shelfX + 16, shelfY - 16 - 24, 2);
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
// The code screen's cards
const CODE_BOLD = 2, CARD_PAD = 14, CARD_SHADOW = 6;
// IBM Plex, as on the website and on the frame (firmware/tools/make_fonts.py makes its fonts)
const TITLE = "700 34px 'IBM Plex Sans Condensed'", BODY = "500 20px 'IBM Plex Sans'";
const LABEL = "700 14px 'IBM Plex Mono'", LABEL_TRACKING = 2;
const ID_L = "600 28px 'IBM Plex Mono'", ID_M = "600 22px 'IBM Plex Mono'", ID_S = "600 16px 'IBM Plex Mono'";
await Promise.all([TITLE, BODY, LABEL, ID_L].map((f) => document.fonts.load(f).catch(() => {})));
const SANS_18 = TITLE, SANS_12 = BODY;
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
  const track = (f, kk) => { c.letterSpacing = f === LABEL ? `${LABEL_TRACKING * kk}px` : "0px"; };
  const text = (t, x, y, f, ink) => { c.font = font(f); track(f, k); c.fillStyle = rgb(ink); c.fillText(t, x * k, y * k); };
  const width = (t, f) => { c.font = f; track(f, 1); return c.measureText(t).width; };
  // A 50% checkerboard of one ink: the site's dithered shadows
  const dither = (x, y, rw, rh, ink) => {
    for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) if ((xx + yy) % 2 === 0) rect(xx, yy, 1, 1, ink);
  };
  // Pixel letters (web/pixelfont.js), s units a dot, with a red dithered shadow one dot down
  // and right; returns their width
  const pixelWord = (t, x, top, s, ink) => {
    const rows = layout(t);
    rows.forEach((r, y) => [...r].forEach((d, x2) => d === "#" && dither(x + (x2 + 1) * s, top + (y + 1) * s, s, s, 3)));
    rows.forEach((r, y) => [...r].forEach((d, x2) => d === "#" && rect(x + x2 * s, top + y * s, s, s, ink)));
    return rows[0].length * s;
  };
  // The wordmark and the six inks beside it, over a rule
  const header = () => {
    const x = MARGIN + pixelWord("DomiFrame", MARGIN, 34, 3, 0) + 22;
    rect(x - 2, 41, 6 * 16 + 4, 16, 0);
    [0, 4, 5, 2, 3, 1].forEach((ink, i) => rect(x + i * 16, 43, 16, 12, ink));
    rect(MARGIN, HEAD - 3, w - 2 * MARGIN, 3, 0);
  };
  // A card on the page: a black border on white, with a dithered shadow
  const card = (x, y, cw, ch) => {
    dither(x + CARD_SHADOW, y + CARD_SHADOW, cw, ch, 0);
    rect(x, y, cw, ch, 0);
    rect(x + 3, y + 3, cw - 6, ch - 6, 1);
  };
  // The frame code in one card, read like a line of text: groups of four apart, with a red dash
  // between them; on one line at the biggest size that fits maxW, or else on two (the dash at the
  // end of the first). Digits blue, letters black; each character CODE_W×CODE_H dots of `sc`
  // units, CODE_BOLD wider so the strokes are heavier than the gaps. Returns the card's height.
  const codeCard = (code, x, y, maxW) => {
    const groups = code.split("-");
    const groupW = (sc) => 4 * CODE_W * sc + 3 * sc + CODE_BOLD;
    const dashW = (sc) => 4 * sc + 2 * 2 * sc; // the dash and the space each side
    const lineW = (sc, n) => n * groupW(sc) + (n - 1) * dashW(sc) + 2 * CARD_PAD;
    let sc = [6, 5, 4].find((k) => lineW(k, 4) <= maxW), perLine = 4;
    if (!sc) { perLine = 2; sc = [6, 5, 4, 3].find((k) => lineW(k, 2) + dashW(k) <= maxW) || 3; }
    const lines = groups.length / perLine;
    const cw = lineW(sc, perLine) + (lines > 1 ? dashW(sc) : 0), lineH = CODE_H * sc, gap = 3 * sc;
    const ch = lines * lineH + (lines - 1) * gap + 2 * CARD_PAD;
    card(x, y, cw, ch);
    groups.forEach((g, n) => {
      const line = Math.floor(n / perLine), col = n % perLine;
      const gx = x + CARD_PAD + col * (groupW(sc) + dashW(sc)), gy = y + CARD_PAD + line * (lineH + gap);
      [...g].forEach((c, i) => {
        const rows = CODE_GLYPHS[c] || [], ink = /[0-9]/.test(c) ? 4 : 0;
        rows.forEach((r, ry) => [...r].forEach((d, rx) => d === "#" &&
          rect(gx + i * (CODE_W + 1) * sc + rx * sc, gy + ry * sc, sc + CODE_BOLD, sc, ink)));
      });
      if (n < groups.length - 1) rect(gx + groupW(sc) + 2 * sc, gy + 3 * sc, 4 * sc, sc, 3); // the dash
    });
    return ch;
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
  paint({ w, h, rect, text, width, header, footer, card, codeCard });
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
    message: "The old code stops working, and this frame's pictures and folders are put away on the server for 30 days (they were locked with the old code).",
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
