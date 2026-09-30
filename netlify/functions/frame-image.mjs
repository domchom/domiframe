// /api/frames/:id/image
//   GET  (the frame)   header X-Device-Key, optional If-None-Match, X-Battery-Mv, X-Fw,
//                      X-Set-Orientation (landscape|portrait, when set on the frame),
//                      X-Panel (7.3|13.3: the screen the firmware was built for)
//        -> 200 packed image | 304 unchanged | 204 nothing uploaded yet
//        Every reply carries X-Sleep-Minutes (when to check in next) and X-Orientation.
//   POST (upload page) Authorization: Bearer <uploadKey or ADMIN_TOKEN>, multipart form:
//        image   = packed 4bpp palette image for the frame's screen (7.3": 192,000 bytes, 13.3": 960,000)
//        preview = PNG of what the frame will show (for the upload page)
//        from    = optional sender name
//        album   = optional folder id
//        original, edits = the photo and editor settings, so it can be edited again later
//        queue   = "next" (default): goes up at the frame's next check-in
//                  "rotation": just joins the rotation (for bulk imports)

import {
  frames, images, status, loadFrame, keyMatches, canManage, json,
  now, newPictureId, loadState, saveState, deletePictureFiles, readPictureForm, storePicture,
} from "../lib/common.mjs";
import { choosePicture, nextWakeMinutes, addPicture, mergeSettings, fitsPanel } from "../lib/schedule.mjs";

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
  const t = now();

  // Settings that come from the frame itself: its screen size (the hardware knows best) and the
  // orientation chosen in its setup portal (or the virtual frame's switch)
  const fromFrame = {};
  if (req.headers.get("x-panel")) fromFrame.panel = req.headers.get("x-panel");
  if (req.headers.get("x-set-orientation")) fromFrame.orientation = req.headers.get("x-set-orientation");
  for (const [k, v] of Object.entries(fromFrame)) {
    const { settings, error } = mergeSettings(frame.settings, { [k]: v });
    if (!error && settings[k] !== (frame.settings || {})[k]) {
      frame = { ...frame, settings };
      await frames().setJSON(id, frame);
    }
  }

  const parsedMv = parseInt(req.headers.get("x-battery-mv") || "", 10);
  const mv = Number.isFinite(parsedMv) && parsedMv > 0 ? parsedMv : null;

  const before = await loadState(id);
  const { state, changed } = choosePicture(before, frame.settings, t);
  if (changed) await saveState(id, state);

  const sleepMinutes = nextWakeMinutes(state, frame.settings, t, mv);
  await status().setJSON(id, {
    lastSeen: new Date(t).toISOString(),
    batteryMv: mv,
    fw: (req.headers.get("x-fw") || "").slice(0, 20) || null,
    sleepMinutes,
  });
  // How the frame hangs, for the virtual frame's display (the real one just draws the bytes)
  const sleep = { "x-sleep-minutes": String(sleepMinutes), "x-orientation": frame.settings?.orientation || "landscape" };

  // Never send a picture made for another screen size: the frame would reject the byte count
  const pic = state.pictures.find((p) => p.id === state.current && fitsPanel(p, frame.settings));
  if (!pic) return new Response(null, { status: 204, headers: sleep });

  const etag = `"${pic.etag}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, ...sleep } });
  }

  const data = await images().get(`${id}/${pic.id}.bin`, { type: "arrayBuffer" });
  if (!data) return json({ error: "picture missing" }, 500, sleep);
  return new Response(data, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(data.byteLength),
      "cache-control": "no-store",
      etag,
      ...sleep,
    },
  });
}

async function upload(req, id, frame) {
  if (!canManage(req, frame)) return json({ error: "unauthorized" }, 401);

  let form;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "expected multipart form data" }, 400);
  }
  const panel = frame.settings?.panel || "7.3";
  const { parts, error } = await readPictureForm(form, panel);
  if (error) return json({ error }, 400);

  let state = await loadState(id);
  const album = String(form.get("album") || "") || null;
  if (album && !state.albums.some((a) => a.id === album)) return json({ error: "no such folder" }, 400);

  const pic = await storePicture(id, newPictureId(), parts, panel);
  pic.album = album;
  pic.from = String(form.get("from") || "").trim().slice(0, 40) || null;

  let removed;
  ({ state, removed } = addPicture(state, pic));
  // Marking it seen keeps it from jumping the queue; it comes round with the rotation.
  if (form.get("queue") === "rotation") state.seen.push(pic.id);
  await saveState(id, state);
  if (removed.length) await deletePictureFiles(id, removed);

  return json({ ok: true, id: pic.id, etag: pic.etag, uploadedAt: pic.uploadedAt });
}
