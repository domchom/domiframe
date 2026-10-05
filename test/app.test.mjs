// Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobsServer } from "@netlify/blobs/server";
import { setEnvironmentContext } from "@netlify/blobs";
import { createHash } from "node:crypto";

import { ditherToPalette, adjust, DITHER_METHODS, rotatePortraitToPanel, pack, PANEL_W, PANEL_H } from "../web/dither.js";
import { frameKeys, seal, unseal, sealText, unsealText, SEAL_OVERHEAD } from "../web/seal.js";

const ADMIN = "test-admin-token";
let server, dir, admin, frameImage, frameInfo, frameCode;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "blobs-"));
  server = new BlobsServer({ directory: dir, token: "tok" });
  const { port } = await server.start();
  setEnvironmentContext({ siteID: "site", token: "tok", edgeURL: `http://localhost:${port}`, uncachedEdgeURL: `http://localhost:${port}` });
  process.env.ADMIN_TOKEN = ADMIN;
  globalThis.Netlify = { env: { get: (k) => process.env[k] } };
  admin = (await import("../netlify/functions/admin-frames.mjs")).default;
  frameImage = (await import("../netlify/functions/frame-image.mjs")).default;
  frameInfo = (await import("../netlify/functions/frame-info.mjs")).default;
  frameCode = (await import("../netlify/functions/frame-code.mjs")).default;
});

after(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

const url = (p) => `https://domiframe.art${p}`;

test("dithering produces valid indices and packs to 192000 bytes", () => {
  const w = PANEL_W, h = PANEL_H;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = (i % w) * 255 / w;          // red gradient left->right
    rgba[i * 4 + 1] = Math.floor(i / w) * 255 / h; // green gradient top->bottom
    rgba[i * 4 + 2] = 128;
    rgba[i * 4 + 3] = 255;
  }
  const idx = ditherToPalette(rgba, w, h);
  assert.equal(idx.length, w * h);
  assert.ok(idx.every((v) => v >= 0 && v <= 5));
  assert.ok(new Set(idx).size >= 4, "gradient should use several inks");
  assert.equal(pack(idx).length, 192000);
});

test("solid white and black map to the white and black inks", () => {
  const px = (r, g, b) => new Uint8ClampedArray([r, g, b, 255]);
  assert.equal(ditherToPalette(px(255, 255, 255), 1, 1, { saturation: 1, contrast: 1 })[0], 1);
  assert.equal(ditherToPalette(px(0, 0, 0), 1, 1, { saturation: 1, contrast: 1 })[0], 0);
});

test("color balance, shadows and sharpen move pixels the right way", () => {
  const grey = new Uint8ClampedArray([128, 128, 128, 255]);
  const neutral = { saturation: 1, contrast: 1 };
  const [r0, g0, b0] = adjust(grey, 1, 1, neutral);
  const [rw, , bw] = adjust(grey, 1, 1, { ...neutral, temperature: 1 });
  assert.ok(rw > r0 && bw < b0, "warm raises red, lowers blue");
  const [, gm] = adjust(grey, 1, 1, { ...neutral, tint: 1 });
  assert.ok(gm < g0, "magenta tint lowers green");
  assert.ok(adjust(grey, 1, 1, { ...neutral, shadows: 1 })[0] > r0, "lifting shadows brightens mid-grey");
  assert.ok(adjust(grey, 1, 1, { ...neutral, shadows: -1 })[0] < r0);

  // a dark dot on white gets darker with sharpening
  const w = 3, rgba = new Uint8ClampedArray(w * w * 4).fill(255);
  rgba.set([100, 100, 100], 4 * 4);
  assert.ok(adjust(rgba, w, w, { ...neutral, sharpen: 1 })[4 * 3] < 100);
});

test("color boost 0 uses only the black and white inks", () => {
  const w = 32, h = 32, rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([200, 60, 40, 255], i * 4); // a red
  const idx = ditherToPalette(rgba, w, h, { saturation: 0 });
  assert.ok(idx.every((v) => v === 0 || v === 1));
});

test("every dither mode returns valid palette indices", () => {
  const w = 64, h = 32, rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([(i * 7) % 256, (i * 3) % 256, (i * 11) % 256, 255], i * 4);
  for (const dither of DITHER_METHODS) {
    const idx = ditherToPalette(rgba, w, h, { dither, strength: 0.7, sharpen: 0.5 });
    assert.ok(idx.every((v) => v <= 5), dither);
  }
  // with no dithering, a flat mid-grey maps to a single ink
  const flat = new Uint8ClampedArray(w * h * 4).fill(140);
  assert.equal(new Set(ditherToPalette(flat, w, h, { dither: "none" })).size, 1);
  // ordered dithering mixes inks for the same grey, in a repeating 8x8 pattern
  const bayer = ditherToPalette(flat, w, h, { dither: "bayer" });
  assert.ok(new Set(bayer).size > 1);
  assert.equal(bayer[0], bayer[8]);
});

test("portrait rotation maps corners correctly", () => {
  const p = new Uint8Array(PANEL_H * PANEL_W); // 480 wide x 800 tall
  p[0] = 2;                        // portrait top-left
  p[PANEL_H * PANEL_W - 1] = 3;    // portrait bottom-right
  const r = rotatePortraitToPanel(p);
  assert.equal(r[PANEL_W - 1], 2);             // panel top-right
  assert.equal(r[(PANEL_H - 1) * PANEL_W], 3); // panel bottom-left
});

// ---- helpers: a frame as the admin, the frame itself and its owner's browser see it ----------

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const makeCode = () =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => CODE_ALPHABET[b & 31]).join("").match(/.{4}/g).join("-");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const adminReq = (path, init = {}, token = ADMIN) =>
  admin(new Request(url(path), { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } }),
    { params: path.match(/frames\/([^/]+)/) ? { id: path.match(/frames\/([^/]+)/)[1] } : {} });

/** The frame registers a code it made: only the hash of the derived token goes to the server. */
async function claim(id, deviceKey, code = makeCode()) {
  const { auth } = await frameKeys(id, code);
  const res = await frameCode(new Request(url(`/api/frames/${id}/code`), {
    method: "POST", headers: { "x-device-key": deviceKey, "content-type": "application/json" }, body: JSON.stringify({ hash: sha256(auth) }),
  }), { params: { id } });
  return { res, code };
}

/** Create a frame (admin), let it make its code (frame), and open it (owner). */
async function newFrame(id, body = {}) {
  const res = await adminReq("/api/admin/frames", { method: "POST", body: JSON.stringify({ id, name: id, ...body }) });
  assert.equal(res.status, 201);
  const { deviceKey, ...rest } = await res.json();
  assert.ok(!("uploadKey" in rest) && !("uploadLink" in rest), "the admin never gets a frame code");
  const { res: claimed, code } = await claim(id, deviceKey);
  assert.equal(claimed.status, 200);
  const { auth, key } = await frameKeys(id, code);
  const ctx = { params: { id } };
  const f = {
    id, deviceKey, code, auth, key, ctx,
    dev: (extra = {}, dk = deviceKey) =>
      frameImage(new Request(url(`/api/frames/${id}/image`), { headers: { "x-device-key": dk, "x-battery-mv": "3900", ...extra } }), ctx),
    call: (path, init = {}, token = auth) =>
      frameInfo(new Request(url(`/api/frames/${id}/${path}`), {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init.headers },
      }), ctx),
    post: (form, token = auth) =>
      frameImage(new Request(url(`/api/frames/${id}/image`), { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form }), ctx),
    /** A picture as the upload page sends it: everything sealed. */
    form: async (fill, { bytes = 192000, from, album, queue, original, thumb, edits } = {}) => {
      const sealed = async (data) => new Blob([await seal(key, data)]);
      const fd = new FormData();
      fd.append("image", await sealed(new Uint8Array(bytes).fill(fill)));
      fd.append("preview", await sealed(new Uint8Array([137, 80, 78, 71, fill])));
      if (original) fd.append("original", await sealed(new Uint8Array([255, 216, fill])));
      if (thumb) fd.append("thumb", await sealed(new Uint8Array([255, 216, 255, fill])));
      if (edits) fd.append("edits", await sealText(key, JSON.stringify(edits)));
      if (from) fd.append("from", await sealText(key, from));
      if (album) fd.append("album", album);
      if (queue) fd.append("queue", queue);
      return fd;
    },
    upload: async (fill, opts) => (await f.post(await f.form(fill, opts))).json(),
    /** What the frame draws: the download, opened with the code's key. */
    drawn: async (res) => new Uint8Array(await unseal(key, await res.arrayBuffer())),
    opened: async (res) => new Uint8Array(await unseal(key, await res.arrayBuffer())),
    info: async () => (await f.call("info")).json(),
    sealName: (name) => sealText(key, name),
  };
  return f;
}
const jsonBody = (method, body) => ({ method, body: JSON.stringify(body) });

test("full flow: create frame, frame makes its code, queue pictures, rotate, settings, admin", async () => {
  // admin auth
  assert.equal((await admin(new Request(url("/api/admin/frames")), { params: {} })).status, 401);

  const f = await newFrame("emma", { name: "Emma's frame" });

  // nothing uploaded yet; every device reply says when to wake
  let res = await f.dev();
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("x-sleep-minutes"), "60");
  assert.equal(res.headers.get("x-retry-minutes"), "60");
  assert.equal(res.headers.get("x-orientation"), "landscape");
  // the frame can say how it hangs; the server remembers it
  res = await f.dev({ "x-set-orientation": "portrait" });
  assert.equal(res.headers.get("x-orientation"), "portrait");
  assert.equal((await f.dev({ "x-set-orientation": "sideways" })).headers.get("x-orientation"), "portrait", "bad values are ignored");
  assert.equal((await f.dev({ "x-set-orientation": "landscape" })).headers.get("x-orientation"), "landscape");
  assert.equal((await f.dev({}, "nope")).status, 401);

  // uploads: wrong token, the code itself (never valid: only the derived token is), unsealed size, then two good ones
  assert.equal((await f.post(await f.form(0x11), "wrong")).status, 401);
  assert.equal((await f.post(await f.form(0x11), f.code)).status, 401);
  const plain = new FormData();
  plain.append("image", new Blob([new Uint8Array(192000).fill(0x11)]));
  assert.equal((await f.post(plain)).status, 400, "an unsealed picture is the wrong size");
  const first = await f.upload(0x11, { from: "Mom" });
  const second = await f.upload(0x22, { from: "Dad" });

  // the frame gets the first, then the second (new pictures each get a turn), then 304
  res = await f.dev();
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers.get("content-length")), 192000 + SEAL_OVERHEAD);
  assert.equal((await f.drawn(res))[0], 0x11);
  const etag1 = res.headers.get("etag");
  res = await f.dev({ "if-none-match": etag1 });
  assert.equal(res.status, 200);
  assert.equal((await f.drawn(res))[0], 0x22);
  const etag2 = res.headers.get("etag");
  assert.equal((await f.dev({ "if-none-match": etag2 })).status, 304);

  // rotate hourly: an hour later it wraps back to the first picture
  res = await f.call("settings", jsonBody("PUT", { rotateHours: 1 }));
  assert.equal(res.status, 200);
  assert.equal((await f.call("settings", jsonBody("PUT", { rotateHours: 5 }))).status, 400);
  // owners can rename the frame; an empty name is refused and changes nothing
  res = await f.call("settings", jsonBody("PUT", { name: "  Kitchen wall  " }));
  assert.equal((await res.json()).name, "Kitchen wall");
  assert.equal((await f.call("settings", jsonBody("PUT", { name: " " }))).status, 400);
  assert.equal((await (await f.call("info")).json()).name, "Kitchen wall");
  await f.call("settings", jsonBody("PUT", { name: "Emma's frame" }));
  res = await f.dev({ "if-none-match": etag2 });
  assert.equal(res.status, 304);
  assert.ok(Number(res.headers.get("x-sleep-minutes")) <= 60);
  globalThis.__domiframeClockOffset = 61 * 60e3;
  res = await f.dev({ "if-none-match": etag2 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("etag"), etag1);
  globalThis.__domiframeClockOffset = 0;

  // info: queue, sender names (sealed: only the code opens them), battery, next check-in
  let info = await f.info();
  assert.equal(info.name, "Emma's frame");
  assert.equal(info.batteryMv, 3900);
  assert.equal(info.settings.rotateHours, 1);
  assert.ok(!JSON.stringify(info).includes("Mom"), "the server never sees sender names");
  assert.deepEqual(await Promise.all(info.pictures.map((p) => unsealText(f.key, p.from))), ["Mom", "Dad"]);
  assert.equal(info.current, first.id);
  assert.ok(info.lastSeen && info.nextCheckIn);

  // previews: current and per picture, sealed, never served as something to render
  res = await f.call("preview");
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.equal((await f.opened(res))[4], 0x11);
  assert.equal((await f.opened(await f.call(`pictures/${second.id}`)))[4], 0x22);

  // delete the picture on the frame: the frame moves to the other one
  assert.equal((await f.call(`pictures/${first.id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual((await f.info()).trash.map((p) => p.id), [first.id], "kept in the trash for now");
  res = await f.dev({ "if-none-match": etag1 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("etag"), etag2);

  // a bulk import joins the rotation instead of jumping the queue
  const imported = await f.upload(0x33, { queue: "rotation" });
  assert.equal((await f.dev({ "if-none-match": etag2 })).status, 304);
  info = await f.info();
  assert.ok(info.pictures.find((p) => p.id === imported.id).seen);

  // the admin can't open the frame's pictures or change them...
  assert.equal((await f.call("info", {}, ADMIN)).status, 404);
  assert.equal((await f.call(`pictures/${second.id}`, {}, ADMIN)).status, 404);
  assert.equal((await f.post(await f.form(0x44), ADMIN)).status, 401);
  // ...only sees how the frame is doing, without key hashes or anything uploaded
  res = await adminReq("/api/admin/frames");
  const { frames } = await res.json();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].pictures, 2);
  assert.equal(frames[0].claimed, true);
  assert.ok(!JSON.stringify(frames).includes("KeyHash"));
  assert.ok(!JSON.stringify(frames).includes(info.pictures[0].from), "no sealed names either");
  // it can still turn the frame, but not pick its (sealed) folders
  res = await adminReq("/api/admin/frames/emma/settings", { method: "PUT", body: JSON.stringify({ orientation: "portrait", album: "abcdef0000" }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).settings.album, null);
  // and there's no such thing as a new upload link from the admin
  assert.equal((await adminReq("/api/admin/frames/emma/keys", { method: "POST", body: JSON.stringify({ key: "upload" }) })).status, 400);

  // new device key: the old one stops working, the code and pictures stay
  res = await adminReq("/api/admin/frames/emma/keys", { method: "POST", body: JSON.stringify({ key: "device" }) });
  const { deviceKey: newDeviceKey } = await res.json();
  assert.equal((await f.dev()).status, 401);
  assert.equal((await f.dev({}, newDeviceKey)).status, 200);
  assert.equal((await f.info()).pictures.length, 2);

  // delete the frame
  assert.equal((await adminReq("/api/admin/frames/emma", { method: "DELETE" })).status, 200);
  assert.equal((await f.dev({}, newDeviceKey)).status, 404);
});

test("a new frame code: only the device key can set it, the old code stops working, its pictures are put aside", async () => {
  const f = await newFrame("recode");
  const pic = await f.upload(0x11, { from: "Mom" });
  const { album } = await (await f.call("albums", jsonBody("POST", { name: await f.sealName("Beach") }))).json();
  assert.ok(album.id);

  // without the device key: nothing changes
  let { res } = await claim("recode", "not-the-device-key");
  assert.equal(res.status, 401);
  assert.equal((await f.info()).pictures.length, 1);
  const bad = await frameCode(new Request(url("/api/frames/recode/code"), {
    method: "POST", headers: { "x-device-key": f.deviceKey, "content-type": "application/json" }, body: JSON.stringify({ hash: "nope" }),
  }), f.ctx);
  assert.equal(bad.status, 400);

  // the frame makes a new code: the old one stops working, its pictures are put aside
  const { res: ok, code } = await claim("recode", f.deviceKey);
  assert.deepEqual(await ok.json(), { ok: true, putAway: 1, restored: 0 });
  assert.equal((await f.call("info")).status, 404, "the old code stops working");
  const { auth } = await frameKeys("recode", code);
  const info = await (await f.call("info", {}, auth)).json();
  assert.equal(info.pictures.length, 0);
  assert.equal(info.albums.length, 0);
  assert.equal((await f.dev()).status, 204);
  // sending the same code again (a retry) changes nothing
  const again = await frameCode(new Request(url("/api/frames/recode/code"), {
    method: "POST", headers: { "x-device-key": f.deviceKey, "content-type": "application/json" },
    body: JSON.stringify({ hash: sha256(auth) }),
  }), f.ctx);
  assert.deepEqual(await again.json(), { ok: true, putAway: 0, restored: 0 });

  // a third code before anything was sent under the second: the first code's pictures stay aside
  const { res: third } = await claim("recode", f.deviceKey);
  assert.deepEqual(await third.json(), { ok: true, putAway: 0, restored: 0 });

  // the old code typed back into the frame: its pictures and folder come back, and open again
  const back = await claim("recode", f.deviceKey, f.code);
  assert.deepEqual(await back.res.json(), { ok: true, putAway: 0, restored: 1 });
  const restored = await f.info();
  assert.deepEqual(restored.pictures.map((p) => p.id), [pic.id]);
  assert.equal(restored.albums.length, 1);
  assert.equal((await f.opened(await f.call(`pictures/${pic.id}`))).length, 5);
});

test("default pictures: one browser adds them, once per frame code, and never to a frame that's had pictures", async () => {
  const f = await newFrame("defaults");
  const claimDefaults = async (auth = f.auth) => (await (await f.call("defaults", { method: "POST" }, auth)).json()).claimed;
  assert.equal((await f.info()).defaultsDone, false);
  // two browsers open the page at once: only one adds them
  assert.deepEqual(await Promise.all([claimDefaults(), claimDefaults()]).then((c) => c.sort()), [false, true]);
  assert.equal((await f.info()).defaultsDone, true);
  // emptied out later: still not again
  await f.upload(0x21);
  await f.call("pictures", jsonBody("DELETE", { all: true }));
  await f.call("trash", jsonBody("DELETE", { all: true }));
  assert.equal(await claimDefaults(), false);

  // a frame that got a picture before anyone opened its page never gets them
  const g = await newFrame("defaults-late");
  await g.upload(0x22);
  assert.equal((await g.info()).defaultsDone, true);
  assert.equal((await (await g.call("defaults", { method: "POST" })).json()).claimed, false);

  // a new frame code starts over: the new owner gets them
  const { code } = await claim("defaults", f.deviceKey);
  const { auth } = await frameKeys("defaults", code);
  assert.equal(await claimDefaults(auth), true);
});

test("pictures put aside with an old code are deleted once its time is up", async () => {
  const f = await newFrame("expire");
  const pic = await f.upload(0x11);
  const { code } = await claim("expire", f.deviceKey);
  const { auth } = await frameKeys("expire", code);
  globalThis.__domiframeClockOffset = 31 * 864e5;
  try {
    assert.equal((await f.dev()).status, 204); // a check-in tidies up
    // too late to go back: the old code works again, but its pictures are gone
    const back = await claim("expire", f.deviceKey, f.code);
    assert.deepEqual(await back.res.json(), { ok: true, putAway: 0, restored: 0 });
    assert.equal((await f.info()).pictures.length, 0);
    assert.equal((await f.call(`pictures/${pic.id}`)).status, 404);
    assert.equal((await f.call("info", {}, auth)).status, 404);
  } finally {
    globalThis.__domiframeClockOffset = 0;
  }
});

test("firmware updates: offered to frames on an older version of the same build", async () => {
  const f = await newFrame("ota");
  globalThis.__domiframeFirmware = {
    ee04: { version: "0.7.0", file: "ee04-0.7.0.bin", size: 1234567, sig: "MEUCIQ" },
  };
  try {
    const offer = (await f.dev({ "x-fw": "0.6.0", "x-fw-env": "ee04" })).headers;
    assert.equal(offer.get("x-fw-update"), "0.7.0");
    assert.equal(offer.get("x-fw-url"), "/firmware/ee04-0.7.0.bin");
    assert.equal(offer.get("x-fw-size"), "1234567");
    assert.equal(offer.get("x-fw-sig"), "MEUCIQ");
    for (const extra of [
      { "x-fw": "0.7.0", "x-fw-env": "ee04" },         // up to date
      { "x-fw": "0.10.0", "x-fw-env": "ee04" },        // newer (compared as numbers, not text)
      { "x-fw": "0.6.0", "x-fw-env": "ee02-13in3" },   // another build: nothing released
      { "x-fw": "0.6.0" },                             // older firmware that can't update itself
    ]) {
      assert.equal((await f.dev(extra)).headers.get("x-fw-update"), null, JSON.stringify(extra));
    }
  } finally {
    delete globalThis.__domiframeFirmware;
  }
  const { newerVersion } = await import("../netlify/lib/firmware.mjs");
  assert.ok(newerVersion("0.10.0", "0.9.9"));
  assert.ok(!newerVersion("0.6.0", "0.6.0"));
  assert.ok(!newerVersion("1.0", "0.6.0"));
});

test("the frame's buttons: next picture, and a status check that changes nothing", async () => {
  const f = await newFrame("buttons");
  await f.upload(1, { queue: "rotation" });
  await f.upload(2, { queue: "rotation" });
  const first = await f.dev();
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.match(first.headers.get("x-local-time"), /^\w{3} \d{1,2} \w{3}, \d{2}:\d{2}/);

  const status = await f.dev({ "x-status": "1", "if-none-match": etag });
  assert.equal(status.status, 204);
  assert.equal(status.headers.get("x-frame-name"), "buttons");
  assert.equal(status.headers.get("x-pictures"), "2");
  assert.ok(status.headers.get("x-sleep-minutes"));
  assert.equal((await f.dev({ "if-none-match": etag })).status, 304, "the status check didn't move the picture on");
  assert.ok((await f.info()).lastSeen, "it counts as a check-in");

  const next = await f.dev({ "x-next": "1", "if-none-match": etag });
  assert.equal(next.status, 200);
  assert.notEqual(next.headers.get("etag"), etag);
});

test("a frame the admin just made has no code yet: nothing opens it", async () => {
  const created = await adminReq("/api/admin/frames", { method: "POST", body: JSON.stringify({ id: "fresh" }) });
  assert.equal(created.status, 201);
  const guess = await frameKeys("fresh", makeCode());
  assert.equal((await frameInfo(new Request(url("/api/frames/fresh/info"), { headers: { authorization: `Bearer ${guess.auth}` } }), { params: { id: "fresh" } })).status, 404);
  assert.equal((await adminReq("/api/admin/frames")).status, 200);
  const listed = (await (await adminReq("/api/admin/frames")).json()).frames.find((x) => x.id === "fresh");
  assert.equal(listed.claimed, false);
});

test("folders, show next, replace, bulk move and delete", async () => {
  const f = await newFrame("gran");
  const { call, dev, info } = f;

  // folders: names are sealed
  const { album: beach } = await (await call("albums", jsonBody("POST", { name: await f.sealName("Beach") }))).json();
  assert.equal((await call("albums", jsonBody("POST", { name: "Beach" }))).status, 400, "names must be sealed");
  assert.equal((await call("albums", jsonBody("POST", { name: "  " }))).status, 400);
  assert.equal((await f.upload(0x11, { album: "nope000000" })).error, "no such folder");
  const a = await f.upload(0x11, { album: beach.id, original: true, edits: { zoom: 1.5 } });
  const b = await f.upload(0x22, { original: true, edits: { zoom: 1.5 } });
  const c = await f.upload(0x33, { album: beach.id, queue: "rotation" });

  // original and edits are kept, sealed, for editing later
  let res = await call(`pictures/${a.id}/original`);
  assert.equal((await f.opened(res))[2], 0x11);
  let i = await info();
  assert.deepEqual(JSON.parse(await unsealText(f.key, i.pictures[0].edits)), { zoom: 1.5 });
  assert.equal(i.pictures[0].hasOriginal, true);
  assert.equal(await unsealText(f.key, i.albums[0].name), "Beach");
  assert.equal(i.albums[0].count, 2);

  // rename
  assert.equal((await call(`albums/${beach.id}`, jsonBody("PATCH", { name: await f.sealName("Sea") }))).status, 200);
  assert.equal(await unsealText(f.key, (await info()).albums[0].name), "Sea");

  // cycle only through the folder: the frame gets a, never b
  assert.equal((await call("settings", jsonBody("PUT", { album: beach.id, rotateHours: 1 }))).status, 200);
  assert.equal((await call("settings", jsonBody("PUT", { album: "abcdef0000" }))).status, 400);
  res = await dev();
  assert.equal((await f.drawn(res))[0], 0x11);
  let etag = res.headers.get("etag");

  // show next: b (outside the folder) goes up at the next check-in
  assert.equal((await call(`pictures/${b.id}/show`, { method: "POST" })).status, 200);
  res = await dev({ "if-none-match": etag });
  assert.equal((await f.drawn(res))[0], 0x22);
  etag = res.headers.get("etag");

  // replace b while it's up: the frame redraws with the new version; place and sender kept
  res = await frameInfo(new Request(url(`/api/frames/gran/pictures/${b.id}`), {
    method: "PUT", headers: { authorization: `Bearer ${f.auth}` }, body: await f.form(0x44),
  }), f.ctx);
  const { id: b2 } = await res.json();
  i = await info();
  assert.deepEqual(i.pictures.map((p) => p.id), [a.id, b2, c.id]);
  assert.equal(i.current, b2);
  assert.equal((await call(`pictures/${b.id}`)).status, 404, "old version gone");
  res = await dev({ "if-none-match": etag });
  assert.equal(res.status, 200);
  assert.equal((await f.drawn(res))[0], 0x44);

  // bulk move, then delete a folder but keep its pictures
  assert.equal((await call("pictures", jsonBody("PATCH", { ids: [b2], album: beach.id }))).status, 200);
  assert.equal((await info()).albums[0].count, 3);
  assert.equal((await call(`albums/${beach.id}?pictures=keep`, { method: "DELETE" })).status, 200);
  i = await info();
  assert.equal(i.albums.length, 0);
  assert.equal(i.settings.album, null, "frame goes back to all pictures");
  assert.ok(i.pictures.every((p) => p.album === null));

  // bulk delete: needs an explicit choice
  assert.equal((await call("pictures", jsonBody("DELETE", {}))).status, 400);
  assert.equal((await (await call("pictures", jsonBody("DELETE", { ids: [a.id] }))).json()).removed, 1);
  assert.equal((await (await call("pictures", jsonBody("DELETE", { all: true }))).json()).removed, 2);
  assert.equal((await info()).pictures.length, 0);
  assert.equal((await dev()).status, 204);
});

test("the trash and pictures for a day, through the API", async () => {
  const f = await newFrame("dora");
  const { call, info } = f;
  const a = await f.upload(0x11), b = await f.upload(0x22), c = await f.upload(0x33);

  // removing moves to the trash; the files stay so it can come back
  assert.deepEqual(await (await call("pictures", jsonBody("DELETE", { ids: [a.id, b.id] }))).json(), { ok: true, removed: 2, ids: [a.id, b.id] });
  let i = await info();
  assert.deepEqual(i.pictures.map((p) => p.id), [c.id]);
  assert.deepEqual(i.trash.map((p) => p.id), [a.id, b.id]);
  assert.equal((await call(`pictures/${a.id}`)).status, 200);
  assert.equal((await call("restore", jsonBody("POST", {}))).status, 400);
  assert.equal((await call("restore", jsonBody("POST", { ids: [a.id] }))).status, 200);
  assert.deepEqual((await info()).pictures.map((p) => p.id), [a.id, c.id]);
  // deleting for good removes the files
  assert.equal((await call("trash", jsonBody("DELETE", {}))).status, 400);
  assert.deepEqual(await (await call("trash", jsonBody("DELETE", { all: true }))).json(), { ok: true, removed: 1 });
  assert.equal((await call(`pictures/${b.id}`)).status, 404);
  assert.deepEqual((await info()).trash, []);

  // a day: validated, kept through an edit, cleared with null
  for (const day of ["13-01", "02-30", "2026-2-1", "tomorrow", 5]) {
    assert.equal((await call("pictures", jsonBody("PATCH", { ids: [c.id], day }))).status, 400, String(day));
  }
  assert.equal((await call("pictures", jsonBody("PATCH", { ids: [c.id], day: "02-29" }))).status, 200);
  const res = await frameInfo(new Request(url(`/api/frames/dora/pictures/${c.id}`), {
    method: "PUT", headers: { authorization: `Bearer ${f.auth}` }, body: await f.form(0x44),
  }), f.ctx);
  const { id: c2 } = await res.json();
  assert.equal((await info()).pictures.find((p) => p.id === c2).day, "02-29");
  assert.equal((await call("pictures", jsonBody("PATCH", { ids: [c2], day: null }))).status, 200);
  assert.equal((await info()).pictures.find((p) => p.id === c2).day, undefined);
});

test("13.3-inch frames: bigger pictures, and never a picture made for the other screen", async () => {
  const bad = await adminReq("/api/admin/frames", { method: "POST", body: JSON.stringify({ id: "bad", panel: "42" }) });
  assert.equal(bad.status, 400);
  const f = await newFrame("big", { panel: "13.3" });

  assert.equal((await f.post(await f.form(0x23, { bytes: 192000 }))).status, 400, "a 7.3-inch picture doesn't fit");
  assert.equal((await f.post(await f.form(0x23, { bytes: 960000 }))).status, 200);

  // A check-in that doesn't say its size (the virtual frame) keeps the size chosen at creation,
  // and the reply says what it is
  let res = await f.dev();
  assert.equal(res.headers.get("x-panel"), "13.3");
  assert.equal((await f.drawn(res)).byteLength, 960000);
  assert.equal((await f.info()).settings.panel, "13.3");

  res = await f.dev({ "x-panel": "13.3" });
  assert.equal(res.status, 200);
  assert.equal((await f.drawn(res)).byteLength, 960000);

  // The frame says it's a 7.3" after all: the 13.3" picture is not sent
  res = await f.dev({ "x-panel": "7.3" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("x-panel"), "7.3");
  const info = await f.info();
  assert.equal(info.settings.panel, "7.3");
  assert.equal(info.pictures[0].panel, "13.3");
});

test("uploads at the same time as check-ins all land; thumbnails and caching", async () => {
  const f = await newFrame("busy");
  const forms = await Promise.all([1, 2, 3, 4, 5, 0x10, 0x12, 0x14].map((fill, i) => f.form(fill, { thumb: i % 2 === 0 })));

  // 8 uploads racing 4 check-ins: none is lost
  const replies = await Promise.all([...forms.map((fd) => f.post(fd)), f.dev(), f.dev(), f.dev(), f.dev()]);
  assert.ok(replies.every((r) => r.ok), "every request succeeded");
  const info = await f.info();
  assert.equal(info.pictures.length, 8);

  // thumbnail when one was sent, else the preview; both cacheable forever (ids never change)
  const all = await Promise.all(info.pictures.map((p) => f.call(`pictures/${p.id}/thumb`)));
  const opened = await Promise.all(all.map((r) => f.opened(r)));
  assert.equal(opened.filter((b) => b[0] === 255).length, 4, "4 JPEG thumbnails");
  assert.equal(opened.filter((b) => b[0] === 137).length, 4, "4 fall back to the preview");
  assert.match(all[0].headers.get("cache-control"), /immutable/);
  assert.equal(all[0].headers.get("content-disposition"), "attachment");
  await f.dev();
  assert.match((await f.call("preview")).headers.get("cache-control"), /no-cache/, "the current picture changes");

  // unsealed side files are refused, not stored
  const fd = await f.form(0x11);
  fd.set("edits", JSON.stringify({ zoom: 2 }));
  assert.equal((await f.post(fd)).status, 400);
});

test("frame codes: typed codes are forgiving; the code never leaves the browser", async () => {
  const { normalizeCode, parseLink, isFrameCode } = await import("../web/code.js");
  const f = await newFrame("typed");
  assert.match(f.code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  assert.ok(isFrameCode(f.code));

  // typed in lowercase with spaces, O for 0 and I for 1: still the same code, same keys
  const messy = f.code.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "i");
  assert.equal(normalizeCode(messy), f.code);
  const { auth } = await frameKeys("typed", normalizeCode(messy));
  assert.equal((await f.call("info", {}, auth)).status, 200);
  assert.equal((await f.call("info", {}, (await frameKeys("typed", "AAAA-BBBB-CCCC-DDDD")).auth)).status, 404);
  // the same code on another frame ID gives other keys
  assert.notEqual((await frameKeys("other", f.code)).auth, f.auth);

  // a picture sealed with another code can't be opened
  const other = await frameKeys("typed", makeCode());
  await assert.rejects(unseal(other.key, await seal(f.key, new Uint8Array([1, 2, 3]))));

  assert.deepEqual(parseLink(`https://domiframe.art/f/typed#k=${f.code}`), { id: "typed", key: f.code });
  assert.equal(parseLink("not a link"), null);
  assert.equal(isFrameCode("abc_DEF-ghi123456789012345678901"), false);
});

test("sealing matches the firmware: HKDF-SHA256 token and AES-256-GCM layout", async () => {
  // Known answer, computed independently with node:crypto (as main.cpp does with mbedtls)
  const { hkdfSync, createDecipheriv } = await import("node:crypto");
  const code = "K7PX-92QD-M4TR-8WZN";
  const okm = (info) => Buffer.from(hkdfSync("sha256", "K7PX92QDM4TR8WZN", "domiframe:emma", info, 32));
  const { auth, key } = await frameKeys("emma", code);
  assert.equal(auth, okm("auth").toString("base64url"));

  const sealed = await seal(key, new Uint8Array([0x01, 0x23, 0x45]));
  assert.equal(sealed.length, 3 + SEAL_OVERHEAD);
  const d = createDecipheriv("aes-256-gcm", okm("content"), sealed.subarray(0, 12));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  assert.deepEqual([...Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()])], [0x01, 0x23, 0x45]);
});

test("the date a photo was taken comes from its EXIF data", async () => {
  const { exifDate, dateTaken } = await import("../web/exif.js");
  /** A JPEG start with an EXIF block: IFD0 (optionally DateTime) -> Exif IFD (optionally DateTimeOriginal). */
  const jpeg = ({ le = false, original, plain } = {}) => {
    const b = new DataView(new ArrayBuffer(256));
    const u16 = (o, x) => b.setUint16(o, x, le), u32 = (o, x) => b.setUint32(o, x, le);
    const str = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
    b.setUint16(0, 0xffd8);
    b.setUint16(2, 0xffe1);
    b.setUint16(4, 200);
    str(6, "Exif");
    const t = 12; // TIFF header
    str(t, le ? "II" : "MM");
    u16(t + 2, 42);
    u32(t + 4, 8);
    const entry = (at, tag, type, count, value) => { u16(t + at, tag); u16(t + at + 2, type); u32(t + at + 4, count); u32(t + at + 8, value); };
    u16(t + 8, plain ? 2 : 1); // IFD0 entries
    entry(10, 0x8769, 4, 1, 60); // Exif IFD at 60
    if (plain) { entry(22, 0x0132, 2, 20, 120); str(t + 120, plain); }
    u16(t + 60, original ? 1 : 0);
    if (original) { entry(62, 0x9003, 2, 20, 90); str(t + 90, original); }
    return b;
  };
  assert.equal(exifDate(jpeg({ original: "2024:03:12 18:30:00" })), "2024-03-12");
  assert.equal(exifDate(jpeg({ le: true, original: "2019:12:31 23:59:59" })), "2019-12-31", "little-endian (most phones)");
  assert.equal(exifDate(jpeg({ plain: "2020:07:04 10:00:00" })), "2020-07-04", "falls back to DateTime");
  assert.equal(exifDate(jpeg({ original: "2024:03:12 18:30:00", plain: "2025:01:01 00:00:00" })), "2024-03-12", "taken wins over modified");
  assert.equal(exifDate(jpeg({ original: "0000:00:00 00:00:00" })), null, "blank dates");
  assert.equal(exifDate(jpeg()), null);
  assert.equal(exifDate(new DataView(new Uint8Array([137, 80, 78, 71]).buffer)), null, "not a JPEG");
  assert.equal(await dateTaken(new Blob([jpeg({ original: "2024:03:12 18:30:00" }).buffer])), "2024-03-12");
  assert.equal(await dateTaken(new Blob([])), null);
});

// ---- Alerts --------------------------------------------------------------------------

test("alerts: sign up with the frame code, get told when it's late, stop with a new code", async () => {
  const frameAlerts = (await import("../netlify/functions/frame-alerts.mjs")).default;
  const { runAlerts } = await import("../netlify/functions/send-alerts.mjs");
  const f = await newFrame("alerted");
  const alerts = (method, body, token = f.auth) => frameAlerts(new Request(url(`/api/frames/${f.id}/alerts`), {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }), f.ctx);
  const apns = { apns: "ab".repeat(32), sandbox: true };
  const other = { apns: "cd".repeat(32) };

  assert.equal((await alerts("PUT", apns, "wrong")).status, 404);
  assert.equal((await alerts("PUT", { apns: "not-a-token" })).status, 400);
  // Signing up gives a frame still on UTC this device's time zone, for daytime-only alerts
  const tzs = ["UTC", "Europe/Berlin", "America/New_York", "Asia/Tokyo", "America/Los_Angeles", "Asia/Kolkata", "Australia/Sydney", "Pacific/Auckland"];
  const { localHour } = await import("../netlify/lib/schedule.mjs");
  const later = Date.now() + 6 * 3600e3;
  const tz = tzs.find((z) => { const h = localHour(later, z); return h >= 9 && h < 20; });
  assert.equal((await alerts("PUT", { ...apns, tz })).status, 200);
  assert.equal((await alerts("PUT", other)).status, 200);
  assert.equal((await (await f.call("info")).json()).settings.tz, tz);

  assert.equal((await f.dev()).status < 300, true); // checks in now, battery fine
  const got = [];
  const send = async (sub, payload) => { got.push({ sub, payload }); return sub.token === other.apns ? "gone" : "ok"; };
  assert.deepEqual(await runAlerts({ send }), [], "on time: nothing");
  const sent = await runAlerts({ at: later, send });
  assert.equal(sent.length, 1);
  assert.equal(got.length, 2);
  assert.equal(got[0].payload.title, "alerted is late");
  assert.equal(got[0].payload.frame, "alerted");
  got.length = 0;
  assert.deepEqual(await runAlerts({ at: later + 3600e3, send }), [], "told once");
  assert.equal(got.length, 0);

  // The other phone's token was gone, so only this one is left; then it stops too
  assert.equal((await alerts("DELETE", apns)).status, 200);
  await runAlerts({ at: later, send });
  assert.equal(got.length, 0);

  // A new code stops alerts asked for with the old one
  assert.equal((await alerts("PUT", apns)).status, 200);
  await claim(f.id, f.deviceKey);
  assert.equal((await alerts("PUT", apns)).status, 404, "the old code no longer works");
  const { pushes } = await import("../netlify/lib/common.mjs");
  assert.equal(await pushes().get(f.id), null);
});
