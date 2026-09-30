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

/**
 * Adjust and dither RGBA pixels to palette indices (Floyd–Steinberg, serpentine).
 * @param {Uint8ClampedArray} rgba  w*h*4
 * @param {{saturation?: number, contrast?: number, brightness?: number}} opts  1 = unchanged
 * @returns {Uint8Array} palette index per pixel
 */
export function ditherToPalette(rgba, w, h, opts = {}) {
  const sat = opts.saturation ?? 1.3;
  const con = opts.contrast ?? 1.1;
  const bri = opts.brightness ?? 1.0;

  const buf = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    let r = rgba[j] * bri, g = rgba[j + 1] * bri, b = rgba[j + 2] * bri;
    const a = rgba[j + 3] / 255; // composite transparency onto white
    r = r * a + 255 * (1 - a);
    g = g * a + 255 * (1 - a);
    b = b * a + 255 * (1 - a);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = lum + (r - lum) * sat;
    g = lum + (g - lum) * sat;
    b = lum + (b - lum) * sat;
    buf[i * 3] = (r - 128) * con + 128;
    buf[i * 3 + 1] = (g - 128) * con + 128;
    buf[i * 3 + 2] = (b - 128) * con + 128;
  }

  const pal = PALETTE.map((p) => p.rgb);
  const out = new Uint8Array(w * h);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  const spread = (x, y, er, eg, eb, f) => {
    if (x < 0 || x >= w || y >= h) return;
    const k = (y * w + x) * 3;
    buf[k] += er * f;
    buf[k + 1] += eg * f;
    buf[k + 2] += eb * f;
  };

  for (let y = 0; y < h; y++) {
    const ltr = y % 2 === 0;
    for (let n = 0; n < w; n++) {
      const x = ltr ? n : w - 1 - n;
      const k = (y * w + x) * 3;
      const r = clamp(buf[k]), g = clamp(buf[k + 1]), b = clamp(buf[k + 2]);

      // weighted RGB distance (cheap perceptual approximation)
      let best = 0, bestD = Infinity;
      for (let p = 0; p < pal.length; p++) {
        const dr = r - pal[p][0], dg = g - pal[p][1], db = b - pal[p][2];
        const rm = (r + pal[p][0]) / 2;
        const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
        if (d < bestD) { bestD = d; best = p; }
      }
      out[y * w + x] = best;

      const er = r - pal[best][0], eg = g - pal[best][1], eb = b - pal[best][2];
      const dx = ltr ? 1 : -1;
      spread(x + dx, y, er, eg, eb, 7 / 16);
      spread(x - dx, y + 1, er, eg, eb, 3 / 16);
      spread(x, y + 1, er, eg, eb, 5 / 16);
      spread(x + dx, y + 1, er, eg, eb, 1 / 16);
    }
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
