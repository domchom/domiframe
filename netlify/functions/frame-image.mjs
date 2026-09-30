// /api/frames/:id/image
//   GET  (the frame)   header X-Device-Key, optional If-None-Match, X-Battery-Mv, X-Fw
//        -> 200 packed image | 304 unchanged | 204 nothing uploaded yet
//   POST (upload page) Authorization: Bearer <uploadKey>, multipart form:
//        image   = 192000-byte packed 4bpp palette image (800x480)
//        preview = PNG of what the frame will show (for the upload page)

import { createHash } from "node:crypto";
import { IMAGE_BYTES, MAX_PREVIEW_BYTES, images, status, loadFrame, keyMatches, bearer, json } from "../lib/common.mjs";

export const config = { path: "/api/frames/:id/image" };

export default async (req, context) => {
  const id = context.params.id;
  const frame = await loadFrame(id);
  if (!frame) return json({ error: "not found" }, 404);

  if (req.method === "GET") return deviceFetch(req, id, frame);
  if (req.method === "POST") return upload(req, id, frame);
  return json({ error: "method not allowed" }, 405, { allow: "GET, POST" });
};

async function deviceFetch(req, id, frame) {
  if (!keyMatches(frame, req.headers.get("x-device-key"), "deviceKeyHash")) {
    return json({ error: "unauthorized" }, 401);
  }

  const mv = parseInt(req.headers.get("x-battery-mv") || "", 10);
  await status().setJSON(id, {
    lastSeen: new Date().toISOString(),
    batteryMv: Number.isFinite(mv) && mv > 0 ? mv : null,
    fw: (req.headers.get("x-fw") || "").slice(0, 20) || null,
  });

  const meta = await images().getMetadata(`${id}.bin`);
  if (!meta) return new Response(null, { status: 204 });

  const etag = `"${meta.metadata.etag}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const data = await images().get(`${id}.bin`, { type: "arrayBuffer" });
  return new Response(data, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(data.byteLength),
      "cache-control": "no-store",
      etag,
    },
  });
}

async function upload(req, id, frame) {
  if (!keyMatches(frame, bearer(req), "uploadKeyHash")) return json({ error: "unauthorized" }, 401);

  let form;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "expected multipart form data" }, 400);
  }
  const image = form.get("image");
  const preview = form.get("preview");
  if (!(image instanceof Blob) || image.size !== IMAGE_BYTES) {
    return json({ error: `image must be exactly ${IMAGE_BYTES} bytes` }, 400);
  }

  const bin = new Uint8Array(await image.arrayBuffer());
  for (const b of bin) {
    if ((b >> 4) > 5 || (b & 0x0f) > 5) return json({ error: "invalid palette index" }, 400);
  }

  const etag = createHash("sha256").update(bin).digest("hex").slice(0, 16);
  const uploadedAt = new Date().toISOString();
  await images().set(`${id}.bin`, bin.buffer, { metadata: { etag, uploadedAt } });

  if (preview instanceof Blob && preview.size > 0 && preview.size <= MAX_PREVIEW_BYTES) {
    await images().set(`${id}.png`, await preview.arrayBuffer(), { metadata: { etag, uploadedAt } });
  }

  return json({ ok: true, etag, uploadedAt });
}
