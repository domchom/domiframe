# DomiFrame

Battery-powered color e-paper photo frames. Friends send pictures from a link on their phone; the frame picks them up on its next check-in.

- **Frame:** one of
  - Seeed XIAO ePaper Display Board **EE04** (XIAO ESP32-S3 Plus) + Seeed **7.3"** E Ink Spectra 6 panel (800×480), or
  - Seeed XIAO ePaper Display Board **EE02** (XIAO ESP32-S3 Plus) + Seeed **13.3"** E Ink Spectra 6 panel (1200×1600)
  - plus a 3.7 V LiPo
- **Server:** Netlify (static site + Functions + Blobs) at `domiframe.art`
- **Upload page:** dithers the photo to the panel's 6 inks in the browser, then **encrypts it there** with the frame's code, so the server only stores ciphertext

```
Friend's phone ──POST image──▶ domiframe.art ──▶ Netlify Blobs (picture queue per frame)
                                                      │
Frame (wakes on schedule or KEY1) ──GET + ETag────────┘
   304 unchanged → sleep     200 new picture → redraw (~20 s) → sleep
   Every reply says how long to sleep (X-Sleep-Minutes)
```

Each frame keeps up to 200 pictures, optionally sorted into folders; the frame cycles through one folder or all of them, in order or shuffled. New ones go up at the next check-in; any picture can be put up next on demand; otherwise the frame rotates through them on a schedule (every hour, 3/6/12 hours, day, 3 days, week, or only when something new arrives). The server also decides when the frame wakes next: the check-in interval, quiet hours overnight, and fewer check-ins when the battery is low. All of this is set per frame on the upload or admin page, with no reflashing.

## Repo layout

| Path | What it is |
|---|---|
| `web/` | Static site: home page (about + My frame), friend upload page, dithering (`dither.js`), encryption (`seal.js`), virtual frame (`sim.html`) |
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
| `POST /api/admin/frames` `{id, name, panel?}` | admin | Create a frame; returns `deviceKey` (shown once). No frame code: the frame makes that |
| `GET /api/admin/frames` | admin | List frames: check-ins, battery, settings, picture counts (nothing uploaded) |
| `DELETE /api/admin/frames/:id` | admin | Delete a frame and its pictures |
| `POST /api/admin/frames/:id/keys` `{key: "device"}` | admin | Replace the device key (old one stops working), shown once |
| `PUT /api/admin/frames/:id/settings` | admin | Settings other than the folder, e.g. `orientation` |
| `POST /api/frames/:id/code` `{hash}` | `X-Device-Key` | The frame registers a new code (SHA-256 of the token derived from it); clears the frame's pictures |
| `GET /api/frames/:id/image` | `X-Device-Key` | Frame download, sealed (`ETag` / `304`, `204` if empty), always with `X-Sleep-Minutes` |
| `POST /api/frames/:id/image` | upload key | Add a picture: packed image, preview PNG, and optionally `thumb` JPEG, original JPEG, `edits`, `from`, `album`, `queue` |
| `GET /api/frames/:id/info` | upload key | Name, check-ins, battery, settings, picture queue |
| `GET /api/frames/:id/preview` | upload key | PNG of the picture on the frame now |
| `PUT /api/frames/:id/settings` | upload key | `rotateHours`, `checkMinutes`, `album`, `order`, `quiet`, `quietStart`, `quietEnd`, `tz` |
| `GET /api/frames/:id/pictures/:pic` | upload key | One picture's PNG preview |
| `GET /api/frames/:id/pictures/:pic/thumb` | upload key | Small JPEG for the picture grid (the PNG preview for older pictures) |
| `GET /api/frames/:id/pictures/:pic/original` | upload key | The photo as uploaded (JPEG), for editing again |
| `PUT /api/frames/:id/pictures/:pic` | upload key | Replace with an edited version (keeps place and folder) |
| `POST /api/frames/:id/pictures/:pic/show` | upload key | Put it up at the next check-in |
| `DELETE /api/frames/:id/pictures/:pic` | upload key | Remove one picture |
| `DELETE /api/frames/:id/pictures` `{ids}\|{album}\|{all: true}` | upload key | Remove several |
| `PATCH /api/frames/:id/pictures` `{ids, album}` | upload key | Move to a folder (`album: null` = none) |
| `POST /api/frames/:id/albums` `{name}` | upload key | New folder |
| `PATCH`/`DELETE /api/frames/:id/albums/:album` | upload key | Rename / delete (`?pictures=keep\|delete`) |

"admin" means `Authorization: Bearer <ADMIN_TOKEN>`; "upload key" means `Authorization: Bearer <token derived from the frame code>` (below). The admin token does **not** open any frame's pictures.

Image format: 4 bits per pixel, two pixels per byte (high nibble = left), rows in the panel's own layout: 7.3" = 800×480 (192,000 bytes), 13.3" = 1200×1600 (960,000 bytes). Pictures made for the frame's orientation are turned 90° clockwise when it hangs the other way from the panel's rows (`toPanelOrder` in `web/dither.js`). Each frame has a `panel` setting (`"7.3"` or `"13.3"`); the firmware reports it on every check-in (`X-Panel`), and pictures made for another screen size are never sent.
Palette indices: `0 black, 1 white, 2 yellow, 3 red, 4 blue, 5 green` (shared by `web/dither.js` and `firmware/src/main.cpp`).

Picture files never change (editing a picture gives it a new id), so they're served with `Cache-Control: immutable` and browsers only download each one once. Changes to a frame's picture queue are conditional writes (`onlyIfMatch`), retried on conflict, so a frame checking in during an upload can't lose a picture.

## Privacy: pictures are end-to-end encrypted

Nobody who runs the server (including you, the developer) can see what people send. Each frame makes its own **frame code** like `K7PX-92QD-M4TR-8WZN` (16 characters of Crockford base32, 80 random bits from the ESP32's hardware RNG) and shows it on its screen. The code never goes to the server:

- From the code and frame ID, `web/seal.js` derives two unrelated keys with HKDF-SHA256: an **access token** (sent as the bearer token; the server stores only its SHA-256) and an **AES-256-GCM key**.
- The upload page seals everything before it leaves the browser: the frame picture, preview, thumbnail, original photo, edit settings, sender name and folder names. The server stores and serves ciphertext (`application/octet-stream`).
- The frame derives the same key (`frameKey` in `firmware/src/main.cpp`, mbedtls) and opens the picture before drawing it. The virtual frame does the same with WebCrypto.
- The admin page creates frames and device keys, and shows battery, check-ins and picture counts. It never gets a frame code and can't open, replace or delete anyone's pictures.

The frame's code screen also has a QR code of `https://domiframe.art/f/<id>#k=<code>` (drawn with ESP-IDF's built-in QR encoder), so a phone can open the frame straight away. Codes can also be typed: the home page's **My frame** tab takes a frame ID and code (or a pasted link) and remembers frames opened on that device. Codes are forgiving about case, spaces, dashes and O/I/L (`web/code.js`). In links the code travels in the `#fragment`, which browsers never send, and the upload page removes it from the address bar once saved.

**New code:** in the frame's setup portal (hold KEY3 and press reset), tick *Make a new frame code*. The old code stops working, and the frame's pictures and folders are deleted, since they were sealed with the old code. Changing the frame ID also makes a new code. If you set a frame up before gifting it, have the new owner do this so only they have the code. **Show the code again:** hold KEY1 while pressing reset.

**What this protects against:** anyone reading the stored data, the database, logs, or the admin page. **What it can't:** the server also serves the web pages, so whoever controls the site could in principle ship changed JavaScript that reads codes as they're typed. The CSP (below) stops pages loading code from anywhere else, but the site's own code has to be trusted. What the server does see: frame names, when pictures were uploaded, how many there are, and settings.

## Other protections

- **Security headers** on every page and API reply (`netlify.toml`, also sent by `npm run local`): a strict Content-Security-Policy (only this site's own scripts, no inline code, requests only to this site, no framing), HSTS, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy`, `nosniff`, `no-referrer`. No third-party scripts: the virtual frame's QR library is a copy in `web/vendor/`.
- **Keys:** device keys and access tokens are stored only as SHA-256 hashes and compared in constant time. The admin token is kept in the browser tab's `sessionStorage` (gone when the tab closes), and it works only on `/api/admin/*`.
- **Setup portal:** the `DomiFrame-Setup` Wi-Fi has a new random password each time, shown on the frame's screen, so nobody nearby can join it without seeing the frame. The portal never shows the saved device key back.
- **Frame to server:** TLS is checked against Mozilla's root CAs (below). Sealed pictures that don't open with the frame's key (tampered with, or sealed with an old code) are never drawn.

## Deploy (Netlify)

1. New site from this GitHub repo. Build settings come from `netlify.toml` (publish `web`, functions `netlify/functions`). Pushes that only change firmware, tests or docs skip the deploy (`ignore` in `netlify.toml`), which saves credits on the Free plan.
2. **Site configuration → Environment variables:** add `ADMIN_TOKEN` (a long random string, e.g. `openssl rand -base64 32`). Optionally `PUBLIC_URL=https://domiframe.art`.
3. **Domain management:** add `domiframe.art` and follow Netlify's DNS instructions at your registrar.

## Add a frame

Open `https://domiframe.art/admin.html`, sign in with `ADMIN_TOKEN`, and use **Add a frame**. It shows the device key once, with a link to try it as a **virtual frame** right away. Once the frame (real or virtual) is set up, it makes its frame code and shows it on its screen: give that code and the frame ID to the owner. **New device key** replaces a leaked key.

Or with curl:

```bash
curl -X POST https://domiframe.art/api/admin/frames \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"emma","name":"Emma'\''s frame"}'
```

Save the response and enter `id` + `deviceKey` on the frame (below). The frame then shows its code.

## Flash and set up a frame

1. 7.3": set the EE04 jumper to **50-pin** for the Seeed 7.3" panel. 13.3": connect the panel to the EE02's 60-pin connector.
2. Flash the build for your screen (PlatformIO), with the board on USB-C:
   - 7.3" on EE04: `cd firmware && pio run -e ee04 -t upload`
   - 13.3" on EE02: `cd firmware && pio run -e ee02-13in3 -t upload`
3. On first boot the screen says **Wi-Fi setup** with a password. Join the `DomiFrame-Setup` Wi-Fi from a phone with that password, pick the home network, fill in **Frame ID** and **Device key**, and choose how the frame hangs (landscape or portrait). The orientation can also be changed later on the upload or admin page.
4. The frame connects, makes its **frame code** and shows it with the frame ID and a **QR code**. Scan the QR code to open the frame's page with the code filled in, or enter the ID and code under **My frame** on domiframe.art.
5. To redo setup later (new home Wi-Fi, or a new frame code), hold **KEY3** while pressing reset. Hold **KEY1** while pressing reset to show the code again.
6. **KEY1** wakes the frame to check for a new picture immediately.

You can do step 3 yourself with your own Wi-Fi before gifting it; then have your friend redo setup at home and tick *Make a new frame code*, so you never know their code.

## Local development

```bash
npm install
npm test        # dithering + API flow
npm run local   # whole system locally, with a virtual frame (no hardware, no Netlify account)
npx netlify dev # site + functions locally (needs netlify-cli)
```

### Testing without hardware

**Virtual frame** (`/sim.html`, also live at `https://domiframe.art/sim.html`): a browser stand-in for the frame that works against the real site too. Create a frame on the admin page and press **Open as a virtual frame** (or enter the frame ID and device key on the page). Like the firmware, it makes its own frame code, registers it, shows it on its screen, sends the device key, battery and `If-None-Match`, opens the sealed picture with its code, and decodes the packed 4bpp image with the same palette. **Open this frame's page** opens the upload page with the code. Press **KEY1** to check in, or turn on auto wake. The device key and code are kept in that browser's storage.

`npm run local` starts the site and API on `http://localhost:8888` with a local Blobs store in `.local/`. It creates a `demo` frame and prints a link to the virtual frame for it. Use the battery slider to test the upload page's battery display.

To start over, delete `.local/`. The admin page is at `/admin.html` with the token `local-admin`.

To test schedules, the virtual frame can follow the server's `X-Sleep-Minutes` in real time or sped up, or skip ahead an hour, day or week. The local server moves its clock to match (`/__dev/clock`, local only), so you can watch hourly or weekly rotation and quiet hours in seconds.

## Status / to verify on real hardware

- Firmware **compiles** (CI builds both screens on every push) but has **not run on hardware yet**. 7.3": pins come from Seeed's `Seeed_GFX` EE04 setup and the EE04 wiki; the display uses GxEPD2's `GxEPD2_730c_GDEP073E01` driver, which targets the same ED2208 controller as Seeed's 7.3" Spectra 6 panel. 13.3": uses Seeed's own `Seeed_GFX` (`BOARD_SCREEN_COMBO=510`, T133A01 driver), pinned to a known commit.
- EE02 buttons and battery pins aren't published; the 13.3" build assumes they match the EE04 (its display pins do). Check against the EE02 schematic.
- On a frame hung the other way from its panel's rows (a portrait 7.3", a landscape 13.3"), check that pictures and status messages are the right way up; if not, flip `rotateCW` in `web/dither.js` and the rotation in `showMessage()`.
- TLS: the frame checks the server's certificate against Mozilla's root CAs, embedded as `firmware/data/cert/x509_crt_bundle.bin` (`VERIFY_TLS` in `config.h`), so it keeps working whichever CA issues the certificate. Unlike a browser, the ESP32 only looks up the issuer of the *last* certificate the server sends, so after pointing domiframe.art at Netlify, check it: `python3 firmware/tools/make_ca_bundle.py --check domiframe.art` (CI also runs this weekly). If it names a missing root, add it to `firmware/tools/extra_roots.pem`, rebuild the bundle and reflash. Rebuild it every year or so anyway: `python3 firmware/tools/make_ca_bundle.py`.
- Wi-Fi: the frame remembers the access point and channel in RTC memory across deep sleep and reconnects without scanning, falling back to a normal connect if that fails within 5 s.
- How each frame hangs (landscape or portrait) is a frame setting. Pictures for a portrait frame are packed turned 90° clockwise onto the panel; if they come out upside down on a real portrait-hung frame, flip the rotation in `web/dither.js` (`rotatePortraitToPanel`).
- Palette RGB values in `web/dither.js` are approximations of the real inks; tune them after comparing the preview with the panel.
- Battery reading uses Seeed's `raw / 4096 × 7.16` formula; check against a multimeter.
