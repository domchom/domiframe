// Image pipeline for a 7.3" E Ink Spectra 6 panel (800x480, 6 colors).
// Pure functions, no DOM, so they can be tested in Node.

export const PANEL_W = 800;
export const PANEL_H = 480;

// Index order is shared with the firmware (see firmware/src/main.cpp).
// RGB values approximate how each ink actually looks on the panel, which gives
// better dithering than pure #000/#fff/#f00... Tweak after seeing real prints.
export const PALETTE = [
  { name: "black", rgb: [25, 30, 33] },
  { name: "white", rgb: [232, 232, 232] },
  { name: "yellow", rgb: [239, 222, 68] },
  { name: "red", rgb: [178, 19, 24] },
  { name: "blue", rgb: [33, 87, 186] },
  { name: "green", rgb: [18, 95, 32] },
];

// Defaults for the upload page's controls. Neutral values (0, or 1 for factors) leave the photo unchanged.
export const DEFAULTS = {
  brightness: 1.0,  // multiplier
  contrast: 1.1,    // around mid-grey
  saturation: 1.3,  // 1 = unchanged
  shadows: 0,       // -1..1, lifts (+) or deepens (-) dark tones
  temperature: 0,   // -1 cool .. +1 warm
  tint: 0,          // -1 green .. +1 magenta
  sharpen: 0,       // 0..2, unsharp mask amount
  dither: "floyd",  // see DITHER_METHODS
  strength: 1,      // 0..1, how much error to diffuse
};

/**
 * Apply tone and color adjustments. Returns float RGB (w*h*3, not clamped) ready for dithering,
 * so the same pipeline also drives the undithered "original" preview.
 * @param {Uint8ClampedArray} rgba  w*h*4
 */
export function adjust(rgba, w, h, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const bri = o.brightness, sat = o.saturation, con = o.contrast;
  // White balance as channel gains; small ranges keep it photographic.
  const gr = 1 + 0.18 * o.temperature + 0.08 * o.tint;
  const gg = 1 - 0.12 * o.tint;
  const gb = 1 - 0.18 * o.temperature + 0.08 * o.tint;
  // Shadows as a gamma curve: +1 -> gamma 0.6 (brighter darks), -1 -> 1.6
  const gamma = o.shadows >= 0 ? 1 - 0.4 * o.shadows : 1 - 0.6 * o.shadows;
  const curve = new Float32Array(257);
  for (let v = 0; v < 256; v++) curve[v] = 255 * Math.pow(v / 255, gamma);
  curve[256] = curve[255];

  // Hot loop: runs for every pixel on every slider move, so the tone curve is inlined.
  const n = w * h;
  const buf = new Float32Array(n * 3);
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
    let r = rgba[j] * bri, g = rgba[j + 1] * bri, b = rgba[j + 2] * bri;
    const a = rgba[j + 3] / 255; // composite transparency onto white
    r = r * a + 255 * (1 - a);
    g = g * a + 255 * (1 - a);
    b = b * a + 255 * (1 - a);
    // tone curve with linear interpolation
    let v = r * gr, t;
    v = v < 0 ? 0 : v > 255 ? 255 : v; t = v | 0; r = t >= 255 ? curve[255] : curve[t] + (curve[t + 1] - curve[t]) * (v - t);
    v = g * gg;
    v = v < 0 ? 0 : v > 255 ? 255 : v; t = v | 0; g = t >= 255 ? curve[255] : curve[t] + (curve[t + 1] - curve[t]) * (v - t);
    v = b * gb;
    v = v < 0 ? 0 : v > 255 ? 255 : v; t = v | 0; b = t >= 255 ? curve[255] : curve[t] + (curve[t + 1] - curve[t]) * (v - t);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = lum + (r - lum) * sat;
    g = lum + (g - lum) * sat;
    b = lum + (b - lum) * sat;
    buf[k] = (r - 128) * con + 128;
    buf[k + 1] = (g - 128) * con + 128;
    buf[k + 2] = (b - 128) * con + 128;
  }
  if (o.sharpen > 0) sharpen(buf, w, h, o.sharpen);
  return buf;
}

// Unsharp mask with a 3x3 box blur. Dithering softens edges, so a little sharpening helps.
// Vertical 3-row sums first, then a sliding horizontal window: ~6 adds per value instead of 9.
function sharpen(buf, w, h, amount) {
  const src = buf.slice();
  const col = new Float32Array(w * 3); // sum of up to 3 rows at this x
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
    const rows = y1 - y0 + 1;
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let yy = y0; yy <= y1; yy++) sum += src[(yy * w + x) * 3 + c];
        col[x * 3 + c] = sum;
      }
    }
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
      const cnt = rows * (x1 - x0 + 1);
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let xx = x0; xx <= x1; xx++) sum += col[xx * 3 + c];
        const k = (y * w + x) * 3 + c;
        buf[k] = src[k] + amount * (src[k] - sum / cnt);
      }
    }
  }
}

// Error diffusion kernels as [dx, dy, weight], dx relative to the scan direction.
const weights = (div, rows) => rows.map(([dx, dy, w]) => [dx, dy, w / div]);
const KERNELS = {
  floyd: weights(16, [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]]),
  // Atkinson diffuses only 3/4 of the error: cleaner, punchier, loses some shadow detail.
  atkinson: weights(8, [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]]),
  // Wider kernels spread error further: smoother gradients, softer fine detail.
  jarvis: weights(48, [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
    [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]]),
  stucki: weights(42, [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
    [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]]),
  burkes: weights(32, [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]]),
  sierra: weights(32, [[1, 0, 5], [2, 0, 3], [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2],
    [-1, 2, 2], [0, 2, 3], [1, 2, 2]]),
  "sierra-lite": weights(4, [[1, 0, 2], [-1, 1, 1], [0, 1, 1]]),
  none: [],
};
export const DITHER_METHODS = [...Object.keys(KERNELS), "bayer"];

// 8x8 Bayer matrix, normalized to -0.5..0.5, for ordered dithering.
const BAYER = (() => {
  const m = [[0]];
  let b = m;
  for (let n = 1; n < 8; n *= 2) {
    const next = Array.from({ length: n * 2 }, () => new Array(n * 2));
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const v = b[y][x] * 4;
      next[y][x] = v; next[y][x + n] = v + 2; next[y + n][x] = v + 3; next[y + n][x + n] = v + 1;
    }
    b = next;
  }
  return b.map((row) => row.map((v) => (v + 0.5) / 64 - 0.5));
})();

/**
 * Adjust and dither RGBA pixels to palette indices (serpentine error diffusion).
 * @param {Uint8ClampedArray} rgba  w*h*4
 * @param {Partial<typeof DEFAULTS>} opts
 * @returns {Uint8Array} palette index per pixel
 */
export function ditherToPalette(rgba, w, h, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const buf = adjust(rgba, w, h, o);
  const ordered = o.dither === "bayer";
  const kernel = ordered ? [] : KERNELS[o.dither] || KERNELS.floyd;
  const strength = o.strength;
  const spread = 96 * strength; // Bayer threshold amplitude

  // Flat arrays keep the per-pixel loops free of allocations and iterators.
  const PR = PALETTE.map((p) => p.rgb[0]), PG = PALETTE.map((p) => p.rgb[1]), PB = PALETTE.map((p) => p.rgb[2]);
  // Black and white photos (no color at all) use only the black and white inks; otherwise
  // dithering fakes grey with speckles of red, blue and yellow.
  const inks = o.saturation <= 0 ? [0, 1] : PALETTE.map((_, i) => i);
  const nInks = inks.length;
  const nK = kernel.length;
  const KX = kernel.map((k) => k[0]), KY = kernel.map((k) => k[1]), KW = kernel.map((k) => k[2]);
  const out = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    const ltr = y % 2 === 0;
    const dir = ltr ? 1 : -1;
    const bayerRow = BAYER[y & 7];
    for (let n = 0; n < w; n++) {
      const x = ltr ? n : w - 1 - n;
      const i = (y * w + x) * 3;
      const t = ordered ? bayerRow[x & 7] * spread : 0;
      let r = buf[i] + t, g = buf[i + 1] + t, b = buf[i + 2] + t;
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;

      // weighted RGB distance (cheap perceptual approximation)
      let best = 0, bestD = Infinity;
      for (let q = 0; q < nInks; q++) {
        const p = inks[q];
        const pr = PR[p];
        const dr = r - pr, dg = g - PG[p], db = b - PB[p];
        const rm = (r + pr) / 2;
        const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
        if (d < bestD) { bestD = d; best = p; }
      }
      out[y * w + x] = best;
      if (!nK) continue;

      const er = (r - PR[best]) * strength;
      const eg = (g - PG[best]) * strength;
      const eb = (b - PB[best]) * strength;
      for (let q = 0; q < nK; q++) {
        const xx = x + KX[q] * dir, yy = y + KY[q];
        if (xx < 0 || xx >= w || yy >= h) continue;
        const f = KW[q];
        const j = (yy * w + xx) * 3;
        buf[j] += er * f;
        buf[j + 1] += eg * f;
        buf[j + 2] += eb * f;
      }
    }
  }
  return out;
}

/** Float RGB from adjust() -> RGBA, for showing the adjusted photo before dithering. */
export function floatToRGBA(buf) {
  const out = new Uint8ClampedArray((buf.length / 3) * 4);
  for (let i = 0, j = 0; i < buf.length; i += 3, j += 4) {
    out[j] = buf[i]; out[j + 1] = buf[i + 1]; out[j + 2] = buf[i + 2]; out[j + 3] = 255;
  }
  return out;
}

/** Portrait (480x800) indices -> panel (800x480), rotated 90° clockwise. */
export function rotatePortraitToPanel(idx) {
  const out = new Uint8Array(PANEL_W * PANEL_H);
  const pw = PANEL_H, ph = PANEL_W; // portrait dims
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      out[x * PANEL_W + (ph - 1 - y)] = idx[y * pw + x];
    }
  }
  return out;
}

/** 800x480 indices -> 192000 bytes, two pixels per byte, high nibble = left pixel. */
export function pack(idx) {
  const out = new Uint8Array(idx.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (idx[2 * i] << 4) | idx[2 * i + 1];
  return out;
}

/** Palette indices -> RGBA for an on-screen preview. */
export function indicesToRGBA(idx) {
  const out = new Uint8ClampedArray(idx.length * 4);
  for (let i = 0; i < idx.length; i++) {
    const [r, g, b] = PALETTE[idx[i]].rgb;
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
  }
  return out;
}
