#!/usr/bin/env python3
"""The frame's fonts: IBM Plex, as on the website (Plex Sans Condensed for headings, Plex Sans
for text, Plex Mono for labels and the frame ID), turned into Adafruit GFX bitmap fonts.

Each glyph is rendered by FreeType and thresholded to whole pixels: e-paper has no grey, so
crisp 1-bit letters look better than anti-aliased ones would. Every font is made twice: at the
7.3"'s size, and at twice that for the 13.3" (which draws everything at twice the size), so its
letters are drawn at full resolution rather than with doubled pixels.

    python3 tools/make_fonts.py      -> include/plex_fonts.h

The fonts are in tools/fonts/, under the SIL Open Font License (tools/fonts/OFL.txt).
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FONTS = HERE / "fonts"
OUT = HERE.parent / "include" / "plex_fonts.h"

# name, file, size in px (7.3"), weight for the variable font, extra space between letters
FACES = [
    ("PlexTitle", "IBMPlexSansCondensed-Bold.ttf", 34, None, 0),
    ("PlexBody", "IBMPlexSans[wdth,wght].ttf", 20, 500, 0),
    ("PlexLabel", "IBMPlexMono-Bold.ttf", 14, None, 2),
    ("PlexIdL", "IBMPlexMono-SemiBold.ttf", 28, None, 0),
    ("PlexIdM", "IBMPlexMono-SemiBold.ttf", 22, None, 0),
    ("PlexIdS", "IBMPlexMono-SemiBold.ttf", 16, None, 0),
]
FIRST, LAST = 0x20, 0x7E


def gfx(name, file, size, weight, tracking):
    font = ImageFont.truetype(str(FONTS / file), size)
    if weight:
        axes = [a["name"] for a in font.get_variation_axes()]
        font.set_variation_by_axes([weight if n == b"Weight" else 100 for n in axes])
    pad = size * 2
    bits, glyphs = [], []
    for code in range(FIRST, LAST + 1):
        ch = chr(code)
        img = Image.new("L", (size * 4, size * 4), 0)
        ImageDraw.Draw(img).text((pad, pad * 1.5), ch, font=font, fill=255, anchor="ls")
        img = img.point(lambda v: 255 if v >= 128 else 0)
        box = img.getbbox()
        advance = round(font.getlength(ch)) + tracking
        if not box:
            glyphs.append((len(bits) // 8, 0, 0, advance, 0, 0))
            continue
        l, t, r, b = box
        start = len(bits)
        for y in range(t, b):
            for x in range(l, r):
                bits.append(1 if img.getpixel((x, y)) else 0)
        while len(bits) % 8:
            bits.append(0)
        glyphs.append((start // 8, r - l, b - t, advance, l - pad, t - int(pad * 1.5)))
    data = bytes(int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8))
    ascent, descent = font.getmetrics()
    lines = [f"const uint8_t {name}_Bitmaps[] PROGMEM = {{"]
    for i in range(0, len(data), 24):
        lines.append("  " + ", ".join(f"0x{v:02X}" for v in data[i:i + 24]) + ",")
    lines.append("};")
    lines.append(f"const GFXglyph {name}_Glyphs[] PROGMEM = {{")
    for code, g in zip(range(FIRST, LAST + 1), glyphs):
        lines.append(f"  {{{g[0]}, {g[1]}, {g[2]}, {g[3]}, {g[4]}, {g[5]}}},  // 0x{code:02X} {chr(code)!r}")
    lines.append("};")
    lines.append(f"const GFXfont {name} PROGMEM = {{(uint8_t*){name}_Bitmaps, (GFXglyph*){name}_Glyphs, 0x{FIRST:02X}, 0x{LAST:02X}, {ascent + descent}}};")
    return "\n".join(lines), len(data)


def main():
    out = ['// Made by tools/make_fonts.py from IBM Plex (tools/fonts, SIL Open Font License): don\'t edit.',
           "// The frame's fonts at its own size: the 13.3\" ones are twice the 7.3\"'s, for its pixels.",
           "#pragma once", ""]
    total = {}
    for scale, guard in [(2, "#if defined(DOMIFRAME_PANEL_13IN3)"), (1, "#else")]:
        out.append(guard)
        total[scale] = 0
        for name, file, size, weight, tracking in FACES:
            text, n = gfx(name, file, size * scale, weight, tracking * scale)
            out += [text, ""]
            total[scale] += n
    out.append("#endif")
    OUT.write_text("\n".join(out) + "\n")
    print(f"{OUT}: {total[1]:,} bytes of letters (7.3\"), {total[2]:,} (13.3\")")


if __name__ == "__main__":
    main()
