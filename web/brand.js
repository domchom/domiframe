// The wordmark and the ink test strip, drawn like the frame draws: whole ink dots only, no
// anti-aliasing, shown with every dot visible. Inks match PALETTE in dither.js.
import { PALETTE } from "./dither.js";

const DOT = 2; // CSS px per ink dot
const INK = Object.fromEntries(PALETTE.map((p) => [p.name, p.rgb]));
const dark = () => (document.documentElement.dataset.theme ||
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";

// 4×4 Bayer thresholds (0..1): the regular crosshatch ordered dithering makes
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x, y) => BAYER[(y & 3) * 4 + (x & 3)];

/** A canvas of w×h ink dots, colored by pick(x, y) -> rgb or null (transparent). */
function dots(w, h, pick) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const rgb = pick(x, y);
      if (!rgb) continue;
      const i = (y * w + x) * 4;
      img.data.set(rgb, i);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  c.style.width = `${w * DOT}px`;
  c.style.height = `${h * DOT}px`;
  c.className = "dithered";
  c.setAttribute("aria-hidden", "true");
  return c;
}

/**
 * A heading as crisp bitmap letters in solid ink, with a red shadow dithered 50% (a
 * checkerboard of dots), the way a 1-bit screen fakes a shadow. The text stays for screen readers.
 */
async function wordmark(h) {
  const cs = getComputedStyle(h);
  const px = Math.round(parseFloat(cs.fontSize) / DOT);
  const font = `${cs.fontWeight} ${px}px ${cs.fontFamily}`;
  try { await document.fonts.load(font); } catch {}
  const text = (h.dataset.text ??= h.textContent.trim());
  const shadow = Math.max(2, Math.round(px / 9)); // in dots

  const m = document.createElement("canvas").getContext("2d");
  m.font = font;
  const w = Math.ceil(m.measureText(text).width) + 2 + shadow, hgt = Math.ceil(px * 1.2) + shadow;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = hgt;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 1, Math.round(px * 0.6) + 1);
  const a = ctx.getImageData(0, 0, w, hgt).data;
  const on = (x, y) => x >= 0 && y >= 0 && a[(y * w + x) * 4 + 3] >= 128; // no half-dots

  const letters = dark() ? INK.white : INK.black;
  const label = document.createElement("span");
  label.className = "sr-only";
  label.textContent = text;
  h.replaceChildren(label, dots(w, hgt, (x, y) =>
    on(x, y) ? letters : on(x - shadow, y - shadow) && (x + y) % 2 === 0 ? INK.red : null));
  h.classList.add("has-art");
}

/**
 * The six inks as solid blocks with ordered-dither blends between them, like the color bar at the
 * edge of a test print.
 */
function strip(el) {
  const order = ["black", "blue", "green", "yellow", "red", "white"].map((n) => INK[n]);
  const w = Math.max(24, Math.round(el.clientWidth / DOT)), h = Math.max(4, Math.round(el.clientHeight / DOT));
  const span = w / (order.length - 1);
  el.replaceChildren(dots(w, h, (x, y) => {
    const t = (x + 0.5) / span, i = Math.min(order.length - 2, Math.floor(t));
    // flat ink for the middle of each block, a Bayer blend across the joins
    const f = Math.min(1, Math.max(0, ((t - i) - 0.3) / 0.4));
    return f > bayer(x, y) ? order[i + 1] : order[i];
  }));
}

const draw = () => {
  for (const el of document.querySelectorAll(".mark")) strip(el);
  for (const h of document.querySelectorAll(".brand h1, .hero h1")) wordmark(h);
};
draw();
// Letters are black ink on light pages and white on dark: redraw if the theme changes
// (theme.js fires this for the button and for system changes)
document.addEventListener("themechange", draw);
