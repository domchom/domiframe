// Admin: create and list frames.
//   GET  /api/admin/frames              -> list frames with last check-in
//   POST /api/admin/frames {id, name}   -> create a frame, returns its keys ONCE
// Auth: Authorization: Bearer <ADMIN_TOKEN>  (set ADMIN_TOKEN in Netlify env vars)

import { FRAME_ID_RE, frames, status, images, newKey, hashKey, isAdmin, json } from "../lib/common.mjs";

export const config = { path: "/api/admin/frames" };

export default async (req) => {
  if (!Netlify.env.get("ADMIN_TOKEN")) return json({ error: "ADMIN_TOKEN is not configured" }, 500);
  if (!isAdmin(req)) return json({ error: "unauthorized" }, 401);

  if (req.method === "GET") {
    const { blobs } = await frames().list();
    const list = await Promise.all(
      blobs.map(async ({ key }) => {
        const f = await frames().get(key, { type: "json" });
        const s = (await status().get(key, { type: "json" })) || {};
        const img = await images().getMetadata(`${key}.bin`);
        return {
          id: key,
          name: f?.name,
          createdAt: f?.createdAt,
          lastSeen: s.lastSeen || null,
          batteryMv: s.batteryMv ?? null,
          fw: s.fw || null,
          imageUploadedAt: img?.metadata?.uploadedAt || null,
        };
      })
    );
    return json({ frames: list });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "expected JSON body" }, 400);
    }
    const id = String(body.id || "").toLowerCase();
    const name = String(body.name || id).slice(0, 60);
    if (!FRAME_ID_RE.test(id)) {
      return json({ error: "id must be 2-32 chars: lowercase letters, digits, dashes" }, 400);
    }
    if (await frames().get(id)) return json({ error: "frame already exists" }, 409);

    const uploadKey = newKey();
    const deviceKey = newKey();
    await frames().setJSON(id, {
      name,
      uploadKeyHash: hashKey(uploadKey),
      deviceKeyHash: hashKey(deviceKey),
      createdAt: new Date().toISOString(),
    });

    const base = Netlify.env.get("PUBLIC_URL") || new URL(req.url).origin;
    return json(
      {
        id,
        name,
        uploadKey,
        deviceKey,
        uploadLink: `${base}/f/${id}#k=${uploadKey}`,
        note: "Keys are shown only once. Give uploadLink to your friend; enter id + deviceKey in the frame's setup portal.",
      },
      201
    );
  }

  return json({ error: "method not allowed" }, 405, { allow: "GET, POST" });
};
