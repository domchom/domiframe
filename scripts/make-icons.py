# Draws the site's icons and link-preview image in the frame's six inks, as pixel art:
#   python3 scripts/make-icons.py [path/to/IBMPlexSansCondensed-Bold.ttf] [path/to/IBMPlexMono-Medium.ttf]
# Needs Pillow and numpy. Writes into web/. The fonts are only for the preview image
# (fonts.google.com/specimen/IBM+Plex+Sans+Condensed); without them it falls back to Helvetica.
# Inks match PALETTE in web/dither.js.

import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

WEB = Path(__file__).resolve().parent.parent / "web"
INK = {
    "k": (25, 30, 33),     # black
    "w": (232, 232, 232),  # white
    "y": (239, 222, 68),   # yellow
    "r": (178, 19, 24),    # red
    "b": (33, 87, 186),    # blue
    "g": (18, 95, 32),     # green
}
PALETTE = np.array(list(INK.values()), dtype=float)
BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]

# ---- The mark: a framed picture, 16×16 ink dots -------------------------------------
# Black frame, white mat, and a landscape in the other four inks: blue sky, yellow sun,
# a red mountain behind a green hill.
def mark():
    g = [["k"] * 16 for _ in range(16)]
    for y in range(1, 15):
        for x in range(1, 15):
            g[y][x] = "w"
    for y in range(12):
        for x in range(12):
            c = "b"
            if (x - 8.5) ** 2 + (y - 2.5) ** 2 <= 2.6:
                c = "y"
            if y >= 3 + abs(x - 3.5) * 0.9 and y < 12:  # mountain
                c = "r"
            if y >= min(10, 6.9 + ((x - 9.5) / 3) ** 2):  # hill
                c = "g"
            g[y + 2][x + 2] = c
    return g

def render(grid, dot, size=None, bg=None):
    n = len(grid)
    size = size or n * dot
    img = Image.new("RGBA", (size, size), bg + (255,) if bg else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    off = (size - n * dot) // 2
    for y, row in enumerate(grid):
        for x, c in enumerate(row):
            d.rectangle([off + x * dot, off + y * dot, off + (x + 1) * dot - 1, off + (y + 1) * dot - 1], fill=INK[c])
    return img

def svg(grid):
    # one rect per run of same-ink dots on a row
    hexes = {k: "#%02x%02x%02x" % v for k, v in INK.items()}
    rects = []
    for y, row in enumerate(grid):
        x = 0
        while x < len(row):
            x2 = x
            while x2 < len(row) and row[x2] == row[x]:
                x2 += 1
            rects.append(f'<rect x="{x}" y="{y}" width="{x2 - x}" height="1" fill="{hexes[row[x]]}"/>')
            x = x2
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">'
            + "".join(rects) + "</svg>\n")

# ---- Link preview image -------------------------------------------------------------
def floyd(img):
    """Floyd–Steinberg dither an RGB image to the six inks."""
    a = np.asarray(img.convert("RGB"), dtype=float).copy()
    h, w, _ = a.shape
    out = np.zeros((h, w, 3), dtype=np.uint8)
    for y in range(h):
        for x in range(w):
            old = a[y, x]
            i = int(((PALETTE - old) ** 2).sum(1).argmin())
            new = PALETTE[i]
            out[y, x] = new
            e = old - new
            if x + 1 < w: a[y, x + 1] += e * 7 / 16
            if y + 1 < h:
                if x > 0: a[y + 1, x - 1] += e * 3 / 16
                a[y + 1, x] += e * 5 / 16
                if x + 1 < w: a[y + 1, x + 1] += e * 1 / 16
    return Image.fromarray(out)

def checker_shadow(d, box, depth, color):
    """A hard shadow down-right of box, filled with a 50% checkerboard, like the site's cards."""
    x0, y0, x1, y1 = box
    for y in range(y0 + depth, y1 + depth + 1):
        for x in range(x0 + depth, x1 + depth + 1):
            if (x > x1 or y > y1) and (x + y) % 2 == 0:
                d.point((x, y), fill=color)

def font(path, size, fallback="/System/Library/Fonts/Helvetica.ttc"):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        print(f"warning: can't open font {path!r}, using Helvetica for og.png", file=sys.stderr)
        return ImageFont.truetype(fallback, size)

def og_image(display_font, mono_font):
    W, H, M = 1200, 630, 72
    img = Image.new("RGB", (W, H), INK["w"])
    d = ImageDraw.Draw(img)
    for x in range(0, W, 6):  # the panel's pixel grid, faintly
        d.line([(x, 0), (x, H)], fill=(219, 220, 220))
    for y in range(0, H, 6):
        d.line([(0, y), (W, y)], fill=(219, 220, 220))

    # Wordmark: bitmap letters, 3 px per dot, with a red checkerboard shadow
    DOT, px = 3, 34
    f = font(display_font, px)
    tw = int(d.textlength("DomiFrame", font=f)) + 8
    m = Image.new("L", (tw, px + 8), 0)
    ImageDraw.Draw(m).text((2, 0), "DomiFrame", font=f, fill=255)
    on = np.asarray(m) >= 128
    mh, mw = on.shape
    sh = 3
    word = Image.new("RGBA", ((mw + sh) * DOT, (mh + sh) * DOT), (0, 0, 0, 0))
    wd = ImageDraw.Draw(word)
    for y in range(mh + sh):
        for x in range(mw + sh):
            c = None
            if y < mh and x < mw and on[y, x]:
                c = INK["k"]
            elif 0 <= y - sh < mh and 0 <= x - sh < mw and on[y - sh, x - sh] and (x + y) % 2 == 0:
                c = INK["r"]
            if c:
                wd.rectangle([x * DOT, y * DOT, x * DOT + DOT - 1, y * DOT + DOT - 1], fill=c)
    img.paste(word, (M - 6, M - 6), word)

    # Headline and line
    hf = font(display_font, 50)
    y = M + word.height + 26
    for line in ["Pictures from the people", "you love, printed in ink", "that stays put."]:
        d.text((M, y), line, font=hf, fill=INK["k"])
        y += 60
    mf = font(mono_font, 22)
    d.text((M, H - M - 22), "domiframe.art · color e-paper photo frames", font=mf, fill=(92, 97, 102))

    # The sample photo in the frame's shape, dithered like the upload page's defaults
    # (contrast 1.1, color boost 1.3), 2 px per dot, in a print with a black border
    pw, ph = 240, 144  # dots
    src = Image.open(WEB / "sample.jpg").convert("RGB").resize((pw, ph), Image.LANCZOS)
    a = np.asarray(src, dtype=float)
    a = (a - 128) * 1.1 + 128
    grey = a @ [0.299, 0.587, 0.114]
    a = grey[..., None] + (a - grey[..., None]) * 1.3
    pic = floyd(Image.fromarray(a.clip(0, 255).astype(np.uint8))).resize((pw * 2, ph * 2), Image.NEAREST)
    mat = 16
    bx1 = W - M
    bx0 = bx1 - pw * 2 - mat * 2 - 2
    by0 = (H - ph * 2 - mat * 2) // 2 - 6
    by1 = by0 + ph * 2 + mat * 2 + 2
    checker_shadow(d, (bx0, by0, bx1, by1), 12, INK["k"])
    d.rectangle([bx0, by0, bx1, by1], fill=(251, 251, 248), outline=INK["k"], width=3)
    img.paste(pic, (bx0 + mat + 1, by0 + mat + 1))
    cf = font(mono_font, 17)
    d.text((bx0, by1 + 26), "Six inks. Every other color is made of dots.", font=cf, fill=(92, 97, 102))

    # Ink strip under the headline: the six inks with ordered-dither blends
    order = [INK[c] for c in "kbgyrw"]
    sx0, sy0, sw, shh = M, H - M - 70, 300, 14
    span = sw / (len(order) - 1)
    for yy in range(0, shh, 2):
        for xx in range(0, sw, 2):
            t = (xx / 2 + 0.5) / (span / 2)
            i = min(len(order) - 2, int(t))
            fr = min(1, max(0, ((t - i) - 0.3) / 0.4))
            c = order[i + 1] if fr > (BAYER[(yy // 2) & 3][(xx // 2) & 3] + 0.5) / 16 else order[i]
            d.rectangle([sx0 + xx, sy0 + yy, sx0 + xx + 1, sy0 + yy + 1], fill=c)
    d.rectangle([sx0 - 2, sy0 - 2, sx0 + sw + 1, sy0 + shh + 1], outline=INK["k"], width=2)
    return img

if __name__ == "__main__":
    display_font = sys.argv[1] if len(sys.argv) > 1 else ""
    mono_font = sys.argv[2] if len(sys.argv) > 2 else display_font
    g = mark()
    (WEB / "favicon.svg").write_text(svg(g))
    render(g, 3).save(WEB / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)],
                      append_images=[render(g, 1), render(g, 2)])  # exact dots at each size
    # home screen icons: the mark on the panel's white, with room for the OS to round corners
    render(g, 10, 180, INK["w"]).convert("RGB").save(WEB / "apple-touch-icon.png")
    render(g, 11, 192, INK["w"]).convert("RGB").save(WEB / "icon-192.png")
    render(g, 30, 512, INK["w"]).convert("RGB").save(WEB / "icon-512.png")
    # maskable: the mark inside the middle 80% circle, so any mask shape keeps it whole
    render(g, 18, 512, INK["w"]).convert("RGB").save(WEB / "icon-maskable.png")
    og_image(display_font, mono_font).save(WEB / "og.png", optimize=True)
    print("wrote icons and og.png to", WEB)
