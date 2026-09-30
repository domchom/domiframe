# DomiFrame

Battery-powered color e-paper photo frames. Friends send pictures from a link on their phone; the frame picks them up on its next check-in.

- **Frame:** one of
  - Seeed XIAO ePaper Display Board **EE04** (XIAO ESP32-S3 Plus) + Seeed **7.3"** E Ink Spectra 6 panel (800×480), or
  - Seeed XIAO ePaper Display Board **EE02** (XIAO ESP32-S3 Plus) + Seeed **13.3"** E Ink Spectra 6 panel (1200×1600)
  - plus a 3.7 V LiPo
- **Server:** Netlify (static site + Functions + Blobs) at `domiframe.com`
- **Upload page:** dithers the photo to the panel's 6 inks in the browser, so the server just stores bytes

```
Friend's phone ──POST image──▶ domiframe.com ──▶ Netlify Blobs (picture queue per frame)
                                                      │
Frame (wakes on schedule or KEY1) ──GET + ETag────────┘
   304 unchanged → sleep     200 new picture → redraw (~20 s) → sleep
   Every reply says how long to sleep (X-Sleep-Minutes)
```

Each frame keeps up to 200 pictures, optionally sorted into folders; the frame cycles through one folder or all of them, in order or shuffled. New ones go up at the next check-in; any picture can be put up next on demand; otherwise the frame rotates through them on a schedule (every hour, 3/6/12 hours, day, 3 days, week, or only when something new arrives). The server also decides when the frame wakes next: the check-in interval, quiet hours overnight, and fewer check-ins when the battery is low. All of this is set per frame on the upload or admin page, with no reflashing.

## Repo layout

| Path | What it is |
|---|---|
| `web/` | Static site: landing page, friend upload page, dithering (`dither.js`) |
| `netlify/functions/` | API endpoints |
| `netlify/lib/common.mjs` | Shared helpers (stores, key hashing, picture queue storage) |
| `netlify/lib/schedule.mjs` | Which picture to show and when the frame wakes (pure functions) |
| `web/admin.html` | Admin page: create frames, see battery and check-ins, replace keys |
| `firmware/` | PlatformIO project for the EE04 |
| `test/` | `npm test`: dithering, scheduling, full API flow against a local Blobs server |
| `scripts/` | `npm run local`: local server + virtual frame |
| `.github/workflows/ci.yml` | Runs the tests and compiles the firmware on every push |

## API

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/admin/frames` `{id, name}` | admin | Create a frame; returns `uploadLink` and `deviceKey` (shown once) |
| `GET /api/admin/frames` | admin | List frames: check-ins, battery, settings, pictures |
| `DELETE /api/admin/frames/:id` | admin | Delete a frame and its pictures |
| `POST /api/admin/frames/:id/keys` `{key: "upload"\|"device"}` | admin | Replace a key (old one stops working), shown once |
| `GET /api/frames/:id/image` | `X-Device-Key` | Frame download (`ETag` / `304`, `204` if empty), always with `X-Sleep-Minutes` |
| `POST /api/frames/:id/image` | upload key or admin | Add a picture: packed image, preview PNG, and optionally original JPEG, `edits`, `from`, `album`, `queue` |
| `GET /api/frames/:id/info` | upload key or admin | Name, check-ins, battery, settings, picture queue |
| `GET /api/frames/:id/preview` | upload key or admin | PNG of the picture on the frame now |
| `PUT /api/frames/:id/settings` | upload key or admin | `rotateHours`, `checkMinutes`, `album`, `order`, `quiet`, `quietStart`, `quietEnd`, `tz` |
| `GET /api/frames/:id/pictures/:pic` | upload key or admin | One picture's PNG preview |
| `GET /api/frames/:id/pictures/:pic/original` | upload key or admin | The photo as uploaded (JPEG), for editing again |
| `PUT /api/frames/:id/pictures/:pic` | upload key or admin | Replace with an edited version (keeps place and folder) |
| `POST /api/frames/:id/pictures/:pic/show` | upload key or admin | Put it up at the next check-in |
| `DELETE /api/frames/:id/pictures/:pic` | upload key or admin | Remove one picture |
| `DELETE /api/frames/:id/pictures` `{ids}\|{album}\|{all: true}` | upload key or admin | Remove several |
| `PATCH /api/frames/:id/pictures` `{ids, album}` | upload key or admin | Move to a folder (`album: null` = none) |
| `POST /api/frames/:id/albums` `{name}` | upload key or admin | New folder |
| `PATCH`/`DELETE /api/frames/:id/albums/:album` | upload key or admin | Rename / delete (`?pictures=keep\|delete`) |

"admin" means `Authorization: Bearer <ADMIN_TOKEN>`; "upload key" means `Authorization: Bearer <uploadKey>`.

Image format: 4 bits per pixel, two pixels per byte (high nibble = left), rows in the panel's own layout: 7.3" = 800×480 (192,000 bytes), 13.3" = 1200×1600 (960,000 bytes). Pictures made for the frame's orientation are turned 90° clockwise when it hangs the other way from the panel's rows (`toPanelOrder` in `web/dither.js`). Each frame has a `panel` setting (`"7.3"` or `"13.3"`); the firmware reports it on every check-in (`X-Panel`), and pictures made for another screen size are never sent.
Palette indices: `0 black, 1 white, 2 yellow, 3 red, 4 blue, 5 green` (shared by `web/dither.js` and `firmware/src/main.cpp`).

Keys are stored as SHA-256 hashes. The upload key travels in the link's `#fragment`, so it isn't sent in page requests or server logs.

## Deploy (Netlify)

1. New site from this GitHub repo. Build settings come from `netlify.toml` (publish `web`, functions `netlify/functions`).
2. **Site configuration → Environment variables:** add `ADMIN_TOKEN` (a long random string, e.g. `openssl rand -base64 32`). Optionally `PUBLIC_URL=https://domiframe.com`.
3. **Domain management:** add `domiframe.com` and follow Netlify's DNS instructions at your registrar.

## Add a frame

Open `https://domiframe.com/admin.html`, sign in with `ADMIN_TOKEN`, and use **Add a frame**. It shows the upload link (with a QR code) and the device key once. **Open** on a frame shows its pictures and settings; **New upload link** / **New device key** replace a leaked key.

Or with curl:

```bash
curl -X POST https://domiframe.com/api/admin/frames \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"emma","name":"Emma'\''s frame"}'
```

Save the response: send `uploadLink` to your friend, and enter `id` + `deviceKey` on the frame (below).

## Flash and set up a frame

1. 7.3": set the EE04 jumper to **50-pin** for the Seeed 7.3" panel. 13.3": connect the panel to the EE02's 60-pin connector.
2. Flash the build for your screen (PlatformIO), with the board on USB-C:
   - 7.3" on EE04: `cd firmware && pio run -e ee04 -t upload`
   - 13.3" on EE02: `cd firmware && pio run -e ee02-13in3 -t upload`
3. On first boot the screen says **Wi-Fi setup**. Join the `DomiFrame-Setup` Wi-Fi from a phone, pick the home network, fill in **Frame ID** and **Device key**, and choose how the frame hangs (landscape or portrait). The orientation can also be changed later on the upload or admin page.
4. To redo setup later (new home Wi-Fi), hold **KEY3** while pressing reset.
5. **KEY1** wakes the frame to check for a new picture immediately.

You can do step 3 yourself with your own Wi-Fi before gifting it, then have your friend redo just the Wi-Fi part at home.

## Local development

```bash
npm install
npm test        # dithering + API flow
npm run local   # whole system locally, with a virtual frame (no hardware, no Netlify account)
npx netlify dev # site + functions locally (needs netlify-cli)
```

### Testing without hardware

`npm run local` starts the site and API on `http://localhost:8888` with a local Blobs store in `.local/`. It creates a `demo` frame and prints two links:

- **Upload page**: the friend's link. Pick a photo and send it.
- **Virtual frame** (`/sim.html`): a browser stand-in for the EE04. It makes the same request as the firmware (device key, battery, `If-None-Match`), decodes the packed 4bpp image with the same palette, and shows the same status screens. Press **KEY1** to check in, or turn on auto wake. Use the battery slider to test the upload page's battery display.

To start over, delete `.local/`. The admin page is at `/admin.html` with the token `local-admin`.

To test schedules, the virtual frame can follow the server's `X-Sleep-Minutes` in real time or sped up, or skip ahead an hour, day or week. The local server moves its clock to match (`/__dev/clock`, local only), so you can watch hourly or weekly rotation and quiet hours in seconds.

## Status / to verify on real hardware

- Firmware **compiles** (CI builds both screens on every push) but has **not run on hardware yet**. 7.3": pins come from Seeed's `Seeed_GFX` EE04 setup and the EE04 wiki; the display uses GxEPD2's `GxEPD2_730c_GDEP073E01` driver, which targets the same ED2208 controller as Seeed's 7.3" Spectra 6 panel. 13.3": uses Seeed's own `Seeed_GFX` (`BOARD_SCREEN_COMBO=510`, T133A01 driver), pinned to a known commit.
- EE02 buttons and battery pins aren't published; the 13.3" build assumes they match the EE04 (its display pins do). Check against the EE02 schematic.
- On a frame hung the other way from its panel's rows (a portrait 7.3", a landscape 13.3"), check that pictures and status messages are the right way up; if not, flip `rotateCW` in `web/dither.js` and the rotation in `showMessage()`.
- TLS: the frame currently skips certificate verification (`setInsecure()`). Pin the Let's Encrypt root before giving frames away.
- How each frame hangs (landscape or portrait) is a frame setting. Pictures for a portrait frame are packed turned 90° clockwise onto the panel; if they come out upside down on a real portrait-hung frame, flip the rotation in `web/dither.js` (`rotatePortraitToPanel`).
- Palette RGB values in `web/dither.js` are approximations of the real inks; tune them after comparing the preview with the panel.
- Battery reading uses Seeed's `raw / 4096 × 7.16` formula; check against a multimeter.
