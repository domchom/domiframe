// Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobsServer } from "@netlify/blobs/server";
import { setEnvironmentContext } from "@netlify/blobs";

import { ditherToPalette, adjust, DITHER_METHODS, rotatePortraitToPanel, pack, PANEL_W, PANEL_H } from "../web/dither.js";

const ADMIN = "test-admin-token";
let server, dir, admin, frameImage, frameInfo;

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

test("full flow: create frame, queue pictures, rotate, settings, admin", async () => {
  const adminReq = (path, init = {}) =>
    admin(new Request(url(path), { ...init, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", ...init.headers } }),
      { params: path.match(/frames\/([^/]+)/) ? { id: path.match(/frames\/([^/]+)/)[1] } : {} });

  // admin auth
  assert.equal((await admin(new Request(url("/api/admin/frames")), { params: {} })).status, 401);

  let res = await adminReq("/api/admin/frames", { method: "POST", body: JSON.stringify({ id: "emma", name: "Emma's frame" }) });
  assert.equal(res.status, 201);
  const { uploadKey, deviceKey, uploadLink } = await res.json();
  assert.match(uploadLink, /\/f\/emma#k=/);

  const ctx = { params: { id: "emma" } };
  const dev = (extra = {}, key = deviceKey) =>
    frameImage(new Request(url("/api/frames/emma/image"), { headers: { "x-device-key": key, "x-battery-mv": "3900", ...extra } }), ctx);
  const manage = (path, init = {}, key = uploadKey) => {
    const [, pic] = path.match(/pictures\/([^/]+)/) || [];
    return frameInfo(new Request(url(`/api/frames/emma/${path}`), { ...init, headers: { authorization: `Bearer ${key}`, ...init.headers } }),
      { params: pic ? { id: "emma", pic } : { id: "emma" } });
  };

  // nothing uploaded yet; every device reply says when to wake
  res = await dev();
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("x-sleep-minutes"), "60");
  assert.equal(res.headers.get("x-orientation"), "landscape");
  // the frame can say how it hangs; the server remembers it
  res = await dev({ "x-set-orientation": "portrait" });
  assert.equal(res.headers.get("x-orientation"), "portrait");
  assert.equal((await dev({ "x-set-orientation": "sideways" })).headers.get("x-orientation"), "portrait", "bad values are ignored");
  assert.equal((await dev({ "x-set-orientation": "landscape" })).headers.get("x-orientation"), "landscape");
  assert.equal((await dev({}, "nope")).status, 401);

  // uploads: wrong key, wrong size, bad palette index, then two good ones
  const form = (fill, from) => {
    const f = new FormData();
    f.append("image", new Blob([new Uint8Array(192000).fill(fill)]), "image.bin");
    f.append("preview", new Blob([new Uint8Array([137, 80, 78, 71, fill])], { type: "image/png" }), "p.png");
    if (from) f.append("from", from);
    return f;
  };
  const post = (key, body) =>
    frameImage(new Request(url("/api/frames/emma/image"), { method: "POST", headers: { authorization: `Bearer ${key}` }, body }), ctx);
  assert.equal((await post("wrong", form(0x11))).status, 401);
  const short = new FormData();
  short.append("image", new Blob([new Uint8Array(10)]));
  assert.equal((await post(uploadKey, short)).status, 400);
  assert.equal((await post(uploadKey, form(0x77))).status, 400); // index 7 invalid
  const first = await (await post(uploadKey, form(0x11, "Mom"))).json();
  const second = await (await post(uploadKey, form(0x22, "Dad"))).json();

  // the frame gets the first, then the second (new pictures each get a turn), then 304
  res = await dev();
  assert.equal(res.status, 200);
  assert.equal(new Uint8Array(await res.arrayBuffer())[0], 0x11);
  const etag1 = res.headers.get("etag");
  res = await dev({ "if-none-match": etag1 });
  assert.equal(res.status, 200);
  assert.equal(new Uint8Array(await res.arrayBuffer())[0], 0x22);
  const etag2 = res.headers.get("etag");
  assert.equal((await dev({ "if-none-match": etag2 })).status, 304);

  // rotate hourly: an hour later it wraps back to the first picture
  res = await manage("settings", { method: "PUT", body: JSON.stringify({ rotateHours: 1 }) });
  assert.equal(res.status, 200);
  assert.equal((await manage("settings", { method: "PUT", body: JSON.stringify({ rotateHours: 5 }) })).status, 400);
  res = await dev({ "if-none-match": etag2 });
  assert.equal(res.status, 304);
  assert.ok(Number(res.headers.get("x-sleep-minutes")) <= 60);
  globalThis.__domiframeClockOffset = 61 * 60e3;
  res = await dev({ "if-none-match": etag2 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("etag"), etag1);
  globalThis.__domiframeClockOffset = 0;

  // info: queue, sender names, battery, next check-in
  let info = await (await manage("info")).json();
  assert.equal(info.name, "Emma's frame");
  assert.equal(info.batteryMv, 3900);
  assert.equal(info.settings.rotateHours, 1);
  assert.deepEqual(info.pictures.map((p) => p.from), ["Mom", "Dad"]);
  assert.equal(info.current, first.id);
  assert.ok(info.lastSeen && info.nextCheckIn);

  // previews: current and per picture
  res = await manage("preview");
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(new Uint8Array(await res.arrayBuffer())[4], 0x11);
  assert.equal(new Uint8Array(await (await manage(`pictures/${second.id}`)).arrayBuffer())[4], 0x22);

  // delete the picture on the frame: the frame moves to the other one
  assert.equal((await manage(`pictures/${first.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await manage(`pictures/${first.id}`)).status, 404);
  res = await dev({ "if-none-match": etag1 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("etag"), etag2);

  // a bulk import joins the rotation instead of jumping the queue
  const bulk = form(0x33);
  bulk.append("queue", "rotation");
  const imported = await (await post(uploadKey, bulk)).json();
  assert.equal((await dev({ "if-none-match": etag2 })).status, 304);
  info = await (await manage("info")).json();
  assert.ok(info.pictures.find((p) => p.id === imported.id).seen);

  // admin can manage too; list shows the frame without key hashes
  assert.equal((await manage("info", {}, ADMIN)).status, 200);
  res = await adminReq("/api/admin/frames");
  const { frames } = await res.json();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].pictures.length, 2);
  assert.ok(!JSON.stringify(frames).includes("KeyHash"));

  // new upload key: old link stops working
  res = await adminReq("/api/admin/frames/emma/keys", { method: "POST", body: JSON.stringify({ key: "upload" }) });
  const { uploadKey: newUploadKey } = await res.json();
  assert.equal((await manage("info")).status, 404);
  assert.equal((await manage("info", {}, newUploadKey)).status, 200);

  // delete the frame
  assert.equal((await adminReq("/api/admin/frames/emma", { method: "DELETE" })).status, 200);
  assert.equal((await dev()).status, 404);
});

test("folders, show next, replace, bulk move and delete", async () => {
  let res = await admin(new Request(url("/api/admin/frames"), {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "gran", name: "Gran" }),
  }), { params: {} });
  const { uploadKey, deviceKey } = await res.json();
  const ctx = { params: { id: "gran" } };
  const call = (path, init = {}) =>
    frameInfo(new Request(url(`/api/frames/gran/${path}`), {
      ...init,
      headers: { authorization: `Bearer ${uploadKey}`, ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init.headers },
    }), ctx);
  const jsonBody = (method, body) => ({ method, body: JSON.stringify(body) });
  const form = (fill, extra = {}) => {
    const f = new FormData();
    f.append("image", new Blob([new Uint8Array(192000).fill(fill)]));
    f.append("preview", new Blob([new Uint8Array([137, fill])], { type: "image/png" }));
    f.append("original", new Blob([new Uint8Array([255, 216, fill])], { type: "image/jpeg" }));
    f.append("edits", JSON.stringify({ zoom: 1.5 }));
    for (const [k, v] of Object.entries(extra)) f.append(k, v);
    return f;
  };
  const upload = async (fill, extra) =>
    (await (await frameImage(new Request(url("/api/frames/gran/image"), { method: "POST", headers: { authorization: `Bearer ${uploadKey}` }, body: form(fill, extra) }), ctx)).json());
  const dev = (etag) =>
    frameImage(new Request(url("/api/frames/gran/image"), { headers: { "x-device-key": deviceKey, ...(etag ? { "if-none-match": etag } : {}) } }), ctx);
  const info = async () => (await call("info")).json();

  // folders
  const { album: beach } = await (await call("albums", jsonBody("POST", { name: "Beach" }))).json();
  assert.equal((await call("albums", jsonBody("POST", { name: "  " }))).status, 400);
  assert.equal((await upload(0x11, { album: "nope000000" })).error, "no such folder");
  const a = await upload(0x11, { album: beach.id });
  const b = await upload(0x22);
  const c = await upload(0x33, { album: beach.id, queue: "rotation" });

  // original and edits are kept for editing later
  res = await call(`pictures/${a.id}/original`);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  let i = await info();
  assert.deepEqual(i.pictures[0].edits, { zoom: 1.5 });
  assert.equal(i.pictures[0].hasOriginal, true);
  assert.deepEqual(i.albums.map((x) => [x.name, x.count]), [["Beach", 2]]);

  // cycle only through Beach: the frame gets a, never b
  assert.equal((await call("settings", jsonBody("PUT", { album: beach.id, rotateHours: 1 }))).status, 200);
  assert.equal((await call("settings", jsonBody("PUT", { album: "abcdef0000" }))).status, 400);
  res = await dev();
  assert.equal(new Uint8Array(await res.arrayBuffer())[0], 0x11);
  let etag = res.headers.get("etag");

  // show next: b (outside the folder) goes up at the next check-in
  assert.equal((await call(`pictures/${b.id}/show`, { method: "POST" })).status, 200);
  res = await dev(etag);
  assert.equal(new Uint8Array(await res.arrayBuffer())[0], 0x22);
  etag = res.headers.get("etag");

  // replace b while it's up: the frame redraws with the new version; place and sender kept
  const edited = new FormData();
  edited.append("image", new Blob([new Uint8Array(192000).fill(0x44)]));
  res = await frameInfo(new Request(url(`/api/frames/gran/pictures/${b.id}`), { method: "PUT", headers: { authorization: `Bearer ${uploadKey}` }, body: edited }), ctx);
  const { id: b2 } = await res.json();
  i = await info();
  assert.deepEqual(i.pictures.map((p) => p.id), [a.id, b2, c.id]);
  assert.equal(i.current, b2);
  assert.equal((await call(`pictures/${b.id}`)).status, 404, "old version gone");
  res = await dev(etag);
  assert.equal(res.status, 200);
  assert.equal(new Uint8Array(await res.arrayBuffer())[0], 0x44);

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

test("13.3-inch frames: bigger pictures, and never a picture made for the other screen", async () => {
  let res = await admin(new Request(url("/api/admin/frames"), {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "big", name: "Big", panel: "13.3" }),
  }), { params: {} });
  assert.equal(res.status, 201);
  const { uploadKey, deviceKey } = await res.json();
  const bad = await admin(new Request(url("/api/admin/frames"), {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "bad", panel: "42" }),
  }), { params: {} });
  assert.equal(bad.status, 400);

  const ctx = { params: { id: "big" } };
  const post = (bytes) => {
    const f = new FormData();
    f.append("image", new Blob([new Uint8Array(bytes).fill(0x23)]));
    return frameImage(new Request(url("/api/frames/big/image"), { method: "POST", headers: { authorization: `Bearer ${uploadKey}` }, body: f }), ctx);
  };
  const dev = (extra = {}) =>
    frameImage(new Request(url("/api/frames/big/image"), { headers: { "x-device-key": deviceKey, ...extra } }), ctx);

  assert.equal((await post(192000)).status, 400, "a 7.3-inch picture doesn't fit");
  assert.equal((await post(960000)).status, 200);

  res = await dev({ "x-panel": "13.3" });
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, 960000);

  // The frame says it's a 7.3" after all: the 13.3" picture is not sent
  res = await dev({ "x-panel": "7.3" });
  assert.equal(res.status, 204);
  const info = await (await frameInfo(new Request(url("/api/frames/big/info"), { headers: { authorization: `Bearer ${uploadKey}` } }), ctx)).json();
  assert.equal(info.settings.panel, "7.3");
  assert.equal(info.pictures[0].panel, "13.3");
});

test("uploads at the same time as check-ins all land; thumbnails and caching", async () => {
  const res = await admin(new Request(url("/api/admin/frames"), {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "busy", name: "Busy" }),
  }), { params: {} });
  const { uploadKey, deviceKey } = await res.json();
  const ctx = { params: { id: "busy" } };
  const post = (fill, thumb) => {
    const f = new FormData();
    f.append("image", new Blob([new Uint8Array(192000).fill(fill)]));
    f.append("preview", new Blob([new Uint8Array([137, fill])], { type: "image/png" }));
    if (thumb) f.append("thumb", new Blob([new Uint8Array([255, 216, fill])], { type: "image/jpeg" }));
    return frameImage(new Request(url("/api/frames/busy/image"), { method: "POST", headers: { authorization: `Bearer ${uploadKey}` }, body: f }), ctx);
  };
  const dev = () => frameImage(new Request(url("/api/frames/busy/image"), { headers: { "x-device-key": deviceKey } }), ctx);
  const get = (path) => frameInfo(new Request(url(`/api/frames/busy/${path}`), { headers: { authorization: `Bearer ${uploadKey}` } }), ctx);

  // 8 uploads racing 4 check-ins: none is lost
  const replies = await Promise.all([
    ...[1, 2, 3, 4, 5, 0x10, 0x12, 0x14].map((fill, i) => post(fill, i % 2 === 0)),
    dev(), dev(), dev(), dev(),
  ]);
  assert.ok(replies.every((r) => r.ok), "every request succeeded");
  const info = await (await get("info")).json();
  assert.equal(info.pictures.length, 8);

  // thumbnail when one was sent, else the PNG preview; both cacheable forever (ids never change)
  const all = await Promise.all(info.pictures.map(async (p) => (await get(`pictures/${p.id}/thumb`))));
  const types = all.map((r) => r.headers.get("content-type"));
  assert.equal(types.filter((t) => t === "image/jpeg").length, 4);
  assert.equal(types.filter((t) => t === "image/png").length, 4);
  assert.match(all[0].headers.get("cache-control"), /immutable/);
  await dev();
  assert.match((await get("preview")).headers.get("cache-control"), /no-cache/, "the current picture changes");

  // palette check catches a bad nibble anywhere
  for (const bad of [0x06, 0x60, 0x07, 0x80, 0x0f]) {
    const f = new FormData();
    const bytes = new Uint8Array(192000).fill(0x11);
    bytes[191999] = bad;
    f.append("image", new Blob([bytes]));
    const r = await frameImage(new Request(url("/api/frames/busy/image"), { method: "POST", headers: { authorization: `Bearer ${uploadKey}` }, body: f }), ctx);
    assert.equal(r.status, 400, `0x${bad.toString(16)} rejected`);
  }
});

test("frame codes: new upload keys are typeable, and typed codes are forgiving", async () => {
  const { normalizeCode, parseLink, isFrameCode } = await import("../web/code.js");
  const res = await admin(new Request(url("/api/admin/frames"), {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "typed", name: "Typed" }),
  }), { params: {} });
  const { uploadKey, uploadLink } = await res.json();
  assert.match(uploadKey, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  assert.ok(isFrameCode(uploadKey));

  // typed in lowercase with spaces, O for 0 and I for 1: still the same code
  const messy = uploadKey.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "i");
  assert.equal(normalizeCode(messy), uploadKey);
  const info = (key) => frameInfo(new Request(url("/api/frames/typed/info"), { headers: { authorization: `Bearer ${key}` } }), { params: { id: "typed" } });
  assert.equal((await info(normalizeCode(messy))).status, 200);
  assert.equal((await info("AAAA-BBBB-CCCC-DDDD")).status, 404);

  // older long keys pass through untouched; links are understood
  assert.equal(normalizeCode("abc_DEF-ghi123456789012345678901"), "abc_DEF-ghi123456789012345678901");
  assert.deepEqual(parseLink(uploadLink), { id: "typed", key: uploadKey });
  assert.equal(parseLink("not a link"), null);
});
