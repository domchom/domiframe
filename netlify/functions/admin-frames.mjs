// Admin: create, list, delete frames and replace device keys.
//   GET    /api/admin/frames                -> list frames: last check-in, battery, settings, counts
//   POST   /api/admin/frames {id, name, panel?} -> create a frame ("7.3" or "13.3" screen); device key shown ONCE
//   DELETE /api/admin/frames/:id            -> delete a frame and its pictures
//   POST   /api/admin/frames/:id/keys {key: "device"}
//                                           -> new device key (the old one stops working), returned ONCE
//   PUT    /api/admin/frames/:id/settings   -> change settings (e.g. how the frame hangs)
// Auth: Authorization: Bearer <ADMIN_TOKEN>  (set ADMIN_TOKEN in Netlify env vars)
//
// The admin never sees or makes frame codes, and can't open anyone's pictures: the frame makes
// its own code (POST /api/frames/:id/code) and everything uploaded is sealed with it.

import {
  FRAME_ID_RE, frames, status, states, newKey, hashKey, isAdmin, json, loadFrame, loadState,
  deletePictureFiles, adminSummary,
} from "../lib/common.mjs";
import { mergeSettings } from "../lib/schedule.mjs";

export const config = {
  path: ["/api/admin/frames", "/api/admin/frames/:id", "/api/admin/frames/:id/keys", "/api/admin/frames/:id/settings"],
};

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
  const sub = new URL(req.url).pathname.split("/")[5];
  if (sub === "keys" && req.method === "POST") return replaceKey(req, id, frame);
  if (sub === "settings" && req.method === "PUT") return putSettings(req, id, frame);
  if (!sub && req.method === "DELETE") return remove(id);
  return json({ error: "method not allowed" }, 405);
};

async function list() {
  const { blobs } = await frames().list();
  const list = await Promise.all(
    blobs.map(async ({ key }) => adminSummary(key, await frames().get(key, { type: "json" })))
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
  const { settings, error } = mergeSettings({}, body.panel ? { panel: String(body.panel) } : {});
  if (error) return json({ error }, 400);

  const deviceKey = newKey();
  await frames().setJSON(id, {
    name,
    uploadKeyHash: null, // set by the frame when it makes its code
    deviceKeyHash: hashKey(deviceKey),
    createdAt: new Date().toISOString(),
    settings,
  });

  return json(
    {
      id,
      name,
      deviceKey,
      note: "The device key is shown only once: enter id + deviceKey in the frame's setup portal. The frame then makes its own frame code and shows it on its screen; that code is what opens the frame on the website.",
    },
    201
  );
}

async function replaceKey(req, id, frame) {
  const body = await req.json().catch(() => ({}));
  if (body.key !== "device") {
    return json({ error: 'only the device key can be replaced here; the frame makes a new frame code itself (setup portal)' }, 400);
  }
  const key = newKey();
  await frames().setJSON(id, { ...frame, deviceKeyHash: hashKey(key) });
  return json({ id, deviceKey: key, note: "Enter the new key in the frame's setup portal (hold KEY3 and press reset)." });
}

async function putSettings(req, id, frame) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "expected JSON body" }, 400);
  // Folder choice refers to the owner's (sealed) folders: that stays theirs
  const { album, ...rest } = body;
  const { settings, error } = mergeSettings(frame.settings, rest);
  if (error) return json({ error }, 400);
  await frames().setJSON(id, { ...frame, settings });
  return json({ ok: true, settings });
}

async function remove(id) {
  const state = await loadState(id);
  await deletePictureFiles(id, [...state.pictures, ...state.trash].map((p) => p.id));
  await Promise.all([frames().delete(id), status().delete(id), states().delete(id)]);
  return json({ ok: true });
}
