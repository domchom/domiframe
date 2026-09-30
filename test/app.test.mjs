// Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobsServer } from "@netlify/blobs/server";
import { setEnvironmentContext } from "@netlify/blobs";

import { ditherToPalette, rotatePortraitToPanel, pack, PANEL_W, PANEL_H } from "../web/dither.js";

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

const url = (p) => `https://domiframe.com${p}`;

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

test("portrait rotation maps corners correctly", () => {
  const p = new Uint8Array(PANEL_H * PANEL_W); // 480 wide x 800 tall
  p[0] = 2;                        // portrait top-left
  p[PANEL_H * PANEL_W - 1] = 3;    // portrait bottom-right
  const r = rotatePortraitToPanel(p);
  assert.equal(r[PANEL_W - 1], 2);             // panel top-right
  assert.equal(r[(PANEL_H - 1) * PANEL_W], 3); // panel bottom-left
});

test("full flow: create frame, upload, device fetch with ETag", async () => {
  // admin auth
  let res = await admin(new Request(url("/api/admin/frames"), { method: "GET" }));
  assert.equal(res.status, 401);

  res = await admin(new Request(url("/api/admin/frames"), {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "emma", name: "Emma's frame" }),
  }));
  assert.equal(res.status, 201);
  const { uploadKey, deviceKey, uploadLink } = await res.json();
  assert.match(uploadLink, /\/f\/emma#k=/);

  const ctx = { params: { id: "emma" } };
  const dev = (extra = {}) =>
    frameImage(new Request(url("/api/frames/emma/image"), { headers: { "x-device-key": deviceKey, "x-battery-mv": "3900", ...extra } }), ctx);

  // nothing uploaded yet
  assert.equal((await dev()).status, 204);
  // wrong device key
  assert.equal((await frameImage(new Request(url("/api/frames/emma/image"), { headers: { "x-device-key": "nope" } }), ctx)).status, 401);

  // upload with wrong key / wrong size
  const good = new Uint8Array(192000).fill(0x11);
  const form = (bytes) => {
    const f = new FormData();
    f.append("image", new Blob([bytes]), "image.bin");
    f.append("preview", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), "p.png");
    return f;
  };
  const post = (key, bytes) =>
    frameImage(new Request(url("/api/frames/emma/image"), { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form(bytes) }), ctx);

  assert.equal((await post("wrong", good)).status, 401);
  assert.equal((await post(uploadKey, new Uint8Array(10))).status, 400);
  assert.equal((await post(uploadKey, new Uint8Array(192000).fill(0x77))).status, 400); // index 7 invalid
  res = await post(uploadKey, good);
  assert.equal(res.status, 200);

  // device downloads, then gets 304 with the ETag
  res = await dev();
  assert.equal(res.status, 200);
  const etag = res.headers.get("etag");
  assert.equal((await res.arrayBuffer()).byteLength, 192000);
  assert.equal((await dev({ "if-none-match": etag })).status, 304);

  // info shows battery + last seen
  res = await frameInfo(new Request(url("/api/frames/emma/info"), { headers: { authorization: `Bearer ${uploadKey}` } }), ctx);
  const info = await res.json();
  assert.equal(info.name, "Emma's frame");
  assert.equal(info.batteryMv, 3900);
  assert.ok(info.lastSeen && info.imageUploadedAt);

  // preview
  res = await frameInfo(new Request(url("/api/frames/emma/preview"), { headers: { authorization: `Bearer ${uploadKey}` } }), ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");

  // admin list
  res = await admin(new Request(url("/api/admin/frames"), { headers: { authorization: `Bearer ${ADMIN}` } }));
  const { frames } = await res.json();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, "emma");
  assert.ok(!("uploadKeyHash" in frames[0]));
});
