// /api/frames/:id/code
//   POST (the frame)  header X-Device-Key, JSON { hash: <64 hex> }
//        The frame made a new frame code and shows it on its screen. `hash` is the SHA-256 of
//        the access token derived from it (web/seal.js frameKeys), so the code itself never
//        reaches the server. The old code stops working, and since everything uploaded was
//        sealed with the old code's key, the frame's pictures and folders are removed.
//        -> 200 { ok, cleared } (sending the same hash again changes nothing)

import {
  frames, states, loadFrame, keyMatches, json, now, loadState, deletePictureFiles, HASH_RE,
} from "../lib/common.mjs";

export const config = { path: "/api/frames/:id/code" };

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, { allow: "POST" });
  const id = context.params.id;
  const frame = await loadFrame(id);
  if (!frame) return json({ error: "not found" }, 404);
  if (!keyMatches(frame, req.headers.get("x-device-key"), "deviceKeyHash")) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const hash = String(body.hash || "").toLowerCase();
  if (!HASH_RE.test(hash)) return json({ error: "hash must be 64 hex characters" }, 400);
  if (frame.uploadKeyHash === hash) return json({ ok: true, cleared: 0 }); // a retry

  // Stop the old code first, then clear what was sealed with it
  await frames().setJSON(id, { ...frame, uploadKeyHash: hash, codeClaimedAt: new Date(now()).toISOString(), settings: { ...frame.settings, album: null } });
  const old = await loadState(id);
  await deletePictureFiles(id, old.pictures.map((p) => p.id));
  await states().delete(id);
  return json({ ok: true, cleared: old.pictures.length });
};
