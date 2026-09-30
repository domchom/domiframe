// Admin: create, list, delete frames and replace their keys.
//   GET    /api/admin/frames                -> list frames with last check-in, battery, queue
//   POST   /api/admin/frames {id, name}     -> create a frame, returns its keys ONCE
//   DELETE /api/admin/frames/:id            -> delete a frame and its pictures
//   POST   /api/admin/frames/:id/keys {key: "upload"|"device"}
//                                           -> new key (the old one stops working), returned ONCE
// Auth: Authorization: Bearer <ADMIN_TOKEN>  (set ADMIN_TOKEN in Netlify env vars)

import {
  FRAME_ID_RE, frames, status, states, newKey, hashKey, isAdmin, json, loadFrame, loadState,
  deletePictureFiles, frameSummary,
} from "../lib/common.mjs";

export const config = { path: ["/api/admin/frames", "/api/admin/frames/:id", "/api/admin/frames/:id/keys"] };

const uploadLink = (req, id, key) => `${Netlify.env.get("PUBLIC_URL") || new URL(req.url).origin}/f/${id}#k=${key}`;

export default async (req, context) => {
  if (!Netlify.env.get("ADMIN_TOKEN")) return json({ error: "ADMIN_TOKEN is not configured" }, 500);
  if (!isAdmin(req)) return json({ error: "unauthorized" }, 401);

  const id = context.params?.id;
  if (!id) {
    if (req.method === "GET") return list();
    if (req.method === "POST") return create(req);
    return json({ error: "method not allowed" }, 405, { allow: "GET, POST" });
  }

  const frame = await loadFrame(id);
  if (!frame) return json({ error: "not found" }, 404);
  const keys = new URL(req.url).pathname.endsWith("/keys");
  if (keys && req.method === "POST") return replaceKey(req, id, frame);
  if (!keys && req.method === "DELETE") return remove(id);
  return json({ error: "method not allowed" }, 405);
};

async function list() {
  const { blobs } = await frames().list();
  const list = await Promise.all(
    blobs.map(async ({ key }) => frameSummary(key, await frames().get(key, { type: "json" })))
  );
  list.sort((a, b) => a.id.localeCompare(b.id));
  return json({ frames: list });
}

async function create(req) {
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

  return json(
    {
      id,
      name,
      uploadKey,
      deviceKey,
      uploadLink: uploadLink(req, id, uploadKey),
      note: "Keys are shown only once. Give uploadLink to your friend; enter id + deviceKey in the frame's setup portal.",
    },
    201
  );
}

async function replaceKey(req, id, frame) {
  const body = await req.json().catch(() => ({}));
  if (body.key !== "upload" && body.key !== "device") return json({ error: 'key must be "upload" or "device"' }, 400);
  const key = newKey();
  await frames().setJSON(id, { ...frame, [`${body.key}KeyHash`]: hashKey(key) });
  return json(
    body.key === "upload"
      ? { id, uploadKey: key, uploadLink: uploadLink(req, id, key) }
      : { id, deviceKey: key, note: "Enter the new key in the frame's setup portal (hold KEY3 and press reset)." }
  );
}

async function remove(id) {
  const state = await loadState(id);
  await deletePictureFiles(id, state.pictures.map((p) => p.id));
  await Promise.all([frames().delete(id), status().delete(id), states().delete(id)]);
  return json({ ok: true });
}
