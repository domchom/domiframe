// /api/frames/:id/code
//   POST (the frame)  header X-Device-Key, JSON { hash: <64 hex> }
//        The frame has a new frame code (made there, or typed into its setup portal) and shows
//        it on its screen. `hash` is the SHA-256 of the access token derived from it
//        (web/seal.js frameKeys), so the code itself never reaches the server. The old code
//        stops working. Everything uploaded was sealed with the old code's key, so the frame's
//        pictures and folders are put aside (see OLD_CODE_DAYS in lib/common.mjs): if the frame
//        goes back to the old code within that time, they come back.
//        Alerts stop too: they were asked for by people with the old code.
//        -> 200 { ok, putAway, restored } (sending the same hash again changes nothing)

import {
  frames, states, pushes, loadFrame, keyMatches, json, now, loadState, sameHash, HASH_RE,
  asideKey, oldCodeFresh, deleteAside,
} from "../lib/common.mjs";
import { normalizeState } from "../lib/schedule.mjs";

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
  if (frame.uploadKeyHash === hash) return json({ ok: true, putAway: 0, restored: 0 }); // a retry

  // Going back to the code before: its pictures come back
  const goingBack = oldCodeFresh(frame) && sameHash(frame.oldCode.hash, hash);
  const [current, aside] = await Promise.all([
    loadState(id),
    goingBack ? states().get(asideKey(id), { type: "json" }) : null,
  ]);
  // Put the current pictures aside, unless there are none: then whatever was put aside before
  // stays put aside (a code made and replaced before anything was sent shouldn't cost them)
  const putAside = !!frame.uploadKeyHash && current.pictures.length + current.trash.length + current.albums.length > 0;
  const at = new Date(now()).toISOString();
  const { oldCode, ...rest } = frame;
  const keep = putAside ? { hash: frame.uploadKeyHash, at } : goingBack ? null : oldCode;

  // Stop the old code first
  await frames().setJSON(id, {
    ...rest,
    uploadKeyHash: hash,
    codeClaimedAt: at,
    ...(keep ? { oldCode: keep } : {}),
    settings: { ...frame.settings, album: null },
  });

  await pushes().delete(id);

  // Only one old code is kept: if this puts new pictures aside, the ones before go for good
  if (putAside && !goingBack) await deleteAside(id);
  if (aside) await states().setJSON(id, aside);
  else await states().delete(id);
  if (putAside) await states().setJSON(asideKey(id), current);
  else if (goingBack) await states().delete(asideKey(id));

  return json({
    ok: true,
    putAway: putAside ? current.pictures.length : 0,
    restored: aside ? normalizeState(aside).pictures.length : 0,
  });
};
