# DomiFrame

Battery-powered color e-paper photo frames. Friends send pictures from a link on their phone; the frame picks them up on its next check-in.

- **Frame:** Seeed XIAO ePaper Display Board EE04 (XIAO ESP32-S3 Plus) + Seeed 7.3" E Ink Spectra 6 panel (800×480) + 3.7 V LiPo
- **Server:** Netlify (static site + Functions + Blobs) at `domiframe.com`
- **Upload page:** dithers the photo to the panel's 6 inks in the browser, so the server just stores bytes

```
Friend's phone ──POST image──▶ domiframe.com ──▶ Netlify Blobs
                                                      │
Frame (wakes hourly or on KEY1) ──GET + ETag──────────┘
   304 unchanged → sleep     200 new picture → redraw (~20 s) → sleep
```

## Repo layout

| Path | What it is |
|---|---|
| `web/` | Static site: landing page, friend upload page, dithering (`dither.js`) |
| `netlify/functions/` | API endpoints |
| `netlify/lib/common.mjs` | Shared helpers (stores, key hashing) |
| `firmware/` | PlatformIO project for the EE04 |
| `test/` | `npm test`: dithering + full API flow against a local Blobs server |

## API

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/admin/frames` `{id, name}` | `Bearer ADMIN_TOKEN` | Create a frame; returns `uploadLink` and `deviceKey` (shown once) |
| `GET /api/admin/frames` | `Bearer ADMIN_TOKEN` | List frames, last check-in, battery |
| `GET /api/frames/:id/image` | `X-Device-Key` | Frame download (`ETag` / `304`, `204` if empty) |
| `POST /api/frames/:id/image` | `Bearer uploadKey` | Upload packed image + preview PNG |
| `GET /api/frames/:id/info` | `Bearer uploadKey` | Name, last check-in, battery |
| `GET /api/frames/:id/preview` | `Bearer uploadKey` | PNG of the current picture |

Image format: 800×480, 4 bits per pixel, two pixels per byte (high nibble = left), 192,000 bytes.
Palette indices: `0 black, 1 white, 2 yellow, 3 red, 4 blue, 5 green` (shared by `web/dither.js` and `firmware/src/main.cpp`).

Keys are stored as SHA-256 hashes. The upload key travels in the link's `#fragment`, so it isn't sent in page requests or server logs.

## Deploy (Netlify)

1. New site from this GitHub repo. Build settings come from `netlify.toml` (publish `web`, functions `netlify/functions`).
2. **Site configuration → Environment variables:** add `ADMIN_TOKEN` (a long random string, e.g. `openssl rand -base64 32`). Optionally `PUBLIC_URL=https://domiframe.com`.
3. **Domain management:** add `domiframe.com` and follow Netlify's DNS instructions at your registrar.

## Add a frame

```bash
curl -X POST https://domiframe.com/api/admin/frames \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"emma","name":"Emma'\''s frame"}'
```

Save the response: send `uploadLink` to your friend, and enter `id` + `deviceKey` on the frame (below).

## Flash and set up a frame

1. Set the EE04 jumper to **50-pin** for the Seeed 7.3" panel.
2. `cd firmware && pio run -t upload` (PlatformIO), with the board on USB-C.
3. On first boot the screen says **Wi-Fi setup**. Join the `DomiFrame-Setup` Wi-Fi from a phone, pick the home network, and fill in **Frame ID** and **Device key**.
4. To redo setup later (new home Wi-Fi), hold **KEY3** while pressing reset.
5. **KEY1** wakes the frame to check for a new picture immediately.

You can do step 3 yourself with your own Wi-Fi before gifting it, then have your friend redo just the Wi-Fi part at home.

## Local development

```bash
npm install
npm test        # dithering + API flow
npx netlify dev # site + functions locally (needs netlify-cli)
```

## Status / to verify on real hardware

- Firmware has **not been compiled or run yet**. Pins come from Seeed's `Seeed_GFX` EE04 setup and the EE04 wiki; the display uses GxEPD2's `GxEPD2_730c_GDEP073E01` driver, which targets the same ED2208 controller as Seeed's 7.3" Spectra 6 panel.
- TLS: the frame currently skips certificate verification (`setInsecure()`). Pin the Let's Encrypt root before giving frames away.
- Portrait photos are rotated 90° clockwise onto the panel. If the picture is upside down on a portrait-hung frame, flip the rotation in `web/dither.js`.
- Palette RGB values in `web/dither.js` are approximations of the real inks; tune them after comparing the preview with the panel.
- Battery reading uses Seeed's `raw / 4096 × 7.16` formula; check against a multimeter.
