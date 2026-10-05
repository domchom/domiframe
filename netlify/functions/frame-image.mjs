// /api/frames/:id/image
//   GET  (the frame)   header X-Device-Key, optional If-None-Match, X-Battery-Mv, X-Fw,
//                      X-Set-Orientation (landscape|portrait, when set on the frame),
//                      X-Panel (7.3|13.3: the screen the firmware was built for),
//                      X-Fw-Env (ee04|ee02-13in3: which firmware build it runs),
//                      X-Next: 1 (someone pressed the frame's "next" button: the next picture now),
//                      X-Status: 1 (the frame's status screen: check in without changing the picture)
//        -> 200 sealed packed image | 304 unchanged | 204 nothing uploaded yet (or X-Status)
//        Every reply carries X-Sleep-Minutes (when to check in next), X-Retry-Minutes (the usual
//        interval, for when a check-in fails), X-Orientation and X-Local-Time (now, where the
//        frame hangs, for its status screen); an X-Status reply also X-Frame-Name and X-Pictures;
//        and
//        when newer firmware is out: X-Fw-Update (version), X-Fw-Url, X-Fw-Size and X-Fw-Sig
//        (see lib/firmware.mjs).
//   POST (upload page) Authorization: Bearer <token derived from the frame code>, multipart form,
//        everything sealed in the browser (web/seal.js), so the server can't see any of it:
//        image   = packed 4bpp palette image for the frame's screen (7.3": 192,000 bytes, 13.3": 960,000) + 28
//        preview = PNG of what the frame will show (for the upload page)
//        from    = optional sender name (sealed text)
//        album   = optional folder id
//        original, edits = the photo and editor settings, so it can be edited again later
//        queue   = "next" (default): goes up at the frame's next check-in
//                  "rotation": just joins the rotation (for bulk imports)

import {
  frames, images, status, loadFrame, keyMatches, canManage, json, sealedText, MAX_NAME_CHARS,
  now, newPictureId, updateState, loadState, deletePictureFiles, readPictureForm, storePicture,
  purgeOldCode,
} from "../lib/common.mjs";
import { firmwareHeaders } from "../lib/firmware.mjs";
import {
  choosePicture, nextWakeMinutes, retryMinutes, addPicture, mergeSettings, fitsPanel, pool, localTimeLabel,
} from "../lib/schedule.mjs";

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
  frame = await purgeOldCode(id, frame);

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

  // The status screen only looks: the picture and the rotation stay as they are
  const statusOnly = req.headers.get("x-status") === "1";
  const advance = req.headers.get("x-next") === "1";
  let state = null;
  const saved = statusOnly ? null : await updateState(id, (before) => {
    const out = choosePicture(before, frame.settings, t, Math.random, { advance });
    state = out.state;
    return out.changed ? out.state : null;
  });
  state = saved || state || (await loadState(id));

  const sleepMinutes = nextWakeMinutes(state, frame.settings, t, mv);
  const statusWrite = status().setJSON(id, {
    lastSeen: new Date(t).toISOString(),
    batteryMv: mv,
    fw: (req.headers.get("x-fw") || "").slice(0, 20) || null,
    sleepMinutes,
  });
  // How the frame hangs and its screen size, for the virtual frame (the real one just draws the
  // bytes, and knows its own screen): it takes the size chosen when the frame was created
  const sleep = {
    "x-sleep-minutes": String(sleepMinutes),
    "x-retry-minutes": String(retryMinutes(frame.settings, mv)),
    "x-orientation": frame.settings?.orientation || "landscape",
    "x-panel": frame.settings?.panel || "7.3",
    "x-local-time": localTimeLabel(t, frame.settings?.tz),
    ...firmwareHeaders(req.headers.get("x-fw-env"), req.headers.get("x-fw")),
  };

  if (statusOnly) {
    await statusWrite;
    const name = String(frame.name || "").replace(/[^\x20-\x7e]/g, "").trim(); // headers are ASCII
    return new Response(null, {
      status: 204,
      headers: { ...sleep, "x-frame-name": name || id, "x-pictures": String(pool(state, frame.settings).length) },
    });
  }

  // Never send a picture made for another screen size: the frame would reject the byte count
  const pic = state.pictures.find((p) => p.id === state.current && fitsPanel(p, frame.settings));
  if (!pic) {
    await statusWrite;
    return new Response(null, { status: 204, headers: sleep });
  }

  const etag = `"${pic.etag}"`;
  if (req.headers.get("if-none-match") === etag) {
    await statusWrite;
    return new Response(null, { status: 304, headers: { etag, ...sleep } });
  }

  const [data] = await Promise.all([images().get(`${id}/${pic.id}.bin`, { type: "arrayBuffer" }), statusWrite]);
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

  const album = String(form.get("album") || "") || null;
  if (album && !(await loadState(id)).albums.some((a) => a.id === album)) return json({ error: "no such folder" }, 400);

  const pic = await storePicture(id, newPictureId(), parts, panel);
  pic.album = album;
  pic.from = sealedText(form.get("from"), MAX_NAME_CHARS);

  let removed = [];
  const saved = await updateState(id, (before) => {
    if (album && !before.albums.some((a) => a.id === album)) pic.album = null; // folder deleted meanwhile
    const out = addPicture(before, pic, now());
    removed = out.removed;
    // Marking it seen keeps it from jumping the queue; it comes round with the rotation.
    if (form.get("queue") === "rotation") out.state.seen.push(pic.id);
    return out.state;
  });
  if (!saved) return json({ error: "couldn't save" }, 500);
  if (removed.length) await deletePictureFiles(id, removed);

  return json({ ok: true, id: pic.id, etag: pic.etag, uploadedAt: pic.uploadedAt });
}
