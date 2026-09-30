// For the upload page. Auth: Authorization: Bearer <token derived from the frame code (web/seal.js)>
// Picture files, sender names, folder names and edits are sealed in the browser: they come back
// exactly as sent, and only someone with the frame code can open them.
//   GET    /api/frames/:id/info                     -> name, check-ins, battery, settings, folders, pictures
//   GET    /api/frames/:id/preview                  -> PNG of the picture on the frame now
//   PUT    /api/frames/:id/settings                 -> { rotateHours, checkMinutes, album, order, quiet, quietStart, quietEnd, tz }
//
//   GET    /api/frames/:id/pictures/:pic            -> PNG preview
//   GET    /api/frames/:id/pictures/:pic/thumb      -> small JPEG for the picture grid (PNG preview if none)
//   GET    /api/frames/:id/pictures/:pic/original   -> the photo as uploaded (JPEG), for editing again
//   PUT    /api/frames/:id/pictures/:pic            -> replace with an edited version (same form as uploading)
//   POST   /api/frames/:id/pictures/:pic/show       -> put it up at the frame's next check-in
//   DELETE /api/frames/:id/pictures/:pic            -> remove it
//   DELETE /api/frames/:id/pictures  {ids} | {album} | {all: true}  -> remove several
//   PATCH  /api/frames/:id/pictures  {ids, album}   -> move to a folder (album null = no folder)
//
//   POST   /api/frames/:id/albums  {name}           -> new folder (name sealed)
//   PATCH  /api/frames/:id/albums/:album  {name}    -> rename
//   DELETE /api/frames/:id/albums/:album?pictures=delete|keep

import {
  frames, images, loadFrame, canManage, json, loadState, updateState, deletePictureFiles, frameSummary,
  readPictureForm, storePicture, newPictureId, newAlbumId, PIC_ID_RE, now, sealedText, MAX_NAME_CHARS,
} from "../lib/common.mjs";
import {
  mergeSettings, removePictures, replacePicture, movePictures, addAlbum, renameAlbum, deleteAlbum,
  ALBUM_ID_RE, MAX_ALBUMS,
} from "../lib/schedule.mjs";

export const config = {
  path: [
    "/api/frames/:id/info", "/api/frames/:id/preview", "/api/frames/:id/settings",
    "/api/frames/:id/pictures", "/api/frames/:id/pictures/:pic", "/api/frames/:id/pictures/:pic/:action",
    "/api/frames/:id/albums", "/api/frames/:id/albums/:album",
  ],
};

export default async (req, context) => {
  const { id } = context.params;
  const frame = await loadFrame(id);
  if (!frame || !canManage(req, frame)) return json({ error: "not found or wrong link" }, 404);

  // /api/frames/:id/<section>/<item>/<action>
  const [section, item, action] = new URL(req.url).pathname.split("/").slice(4);
  if (item && section === "pictures" && !PIC_ID_RE.test(item)) return json({ error: "not found" }, 404);
  if (item && section === "albums" && !ALBUM_ID_RE.test(item)) return json({ error: "not found" }, 404);
  const route = [req.method, section, item && ":item", action].filter(Boolean).join(" ");

  switch (route) {
    case "GET info":
      return json(await frameSummary(id, frame));
    case "GET preview":
      return file(id, (await loadState(id)).current, "png", "private, no-cache");
    case "PUT settings":
      return putSettings(req, id, frame);

    case "GET pictures :item":
      return file(id, item, "png");
    case "GET pictures :item thumb":
      return (await file(id, item, "thumb")) || file(id, item, "png");
    case "GET pictures :item original":
      return file(id, item, "jpg");
    case "PUT pictures :item":
      return replace(req, id, item, frame);
    case "POST pictures :item show":
      return change(id, (s) => (has(s, item) ? { ...s, showNext: item } : null));
    case "DELETE pictures :item":
      return removeSome(id, (s) => (has(s, item) ? [item] : null));
    case "DELETE pictures": {
      const body = await body_(req);
      return removeSome(id, (s) => {
        if (Array.isArray(body.ids)) return body.ids.filter((p) => has(s, p));
        if (body.album !== undefined) return s.pictures.filter((p) => p.album === body.album).map((p) => p.id);
        if (body.all === true) return s.pictures.map((p) => p.id);
        return null;
      });
    }
    case "PATCH pictures": {
      const body = await body_(req);
      if (!Array.isArray(body.ids)) return json({ error: "ids required" }, 400);
      return change(id, (s) => (body.album === null || hasAlbum(s, body.album) ? movePictures(s, body.ids, body.album) : null));
    }

    case "POST albums": {
      const name = sealedText((await body_(req)).name, MAX_NAME_CHARS);
      if (!name) return json({ error: "name required (sealed)" }, 400);
      const album = { id: newAlbumId(), name, createdAt: new Date(now()).toISOString() };
      return change(id, (s) => (s.albums.length < MAX_ALBUMS ? addAlbum(s, album) : null), { album });
    }
    case "PATCH albums :item": {
      const name = sealedText((await body_(req)).name, MAX_NAME_CHARS);
      if (!name) return json({ error: "name required (sealed)" }, 400);
      return change(id, (s) => (hasAlbum(s, item) ? renameAlbum(s, item, name) : null));
    }
    case "DELETE albums :item": {
      const del = new URL(req.url).searchParams.get("pictures") === "delete";
      let removed = [];
      const saved = await updateState(id, (s) => {
        if (!hasAlbum(s, item)) return null;
        const out = deleteAlbum(s, item, del);
        removed = out.removed;
        return out.state;
      });
      if (!saved) return json({ error: "not found" }, 404);
      await deletePictureFiles(id, removed);
      if (frame.settings?.album === item) await frames().setJSON(id, { ...frame, settings: { ...frame.settings, album: null } });
      return json({ ok: true, removed: removed.length });
    }
  }
  return json({ error: "not found" }, 404);
};

const has = (s, pic) => s.pictures.some((p) => p.id === pic);
const hasAlbum = (s, album) => s.albums.some((a) => a.id === album);
const body_ = (req) => req.json().catch(() => ({}));

/** Apply fn to the state (null = not found) and save. */
async function change(id, fn, extra = {}) {
  if (!(await updateState(id, fn))) return json({ error: "not found" }, 404);
  return json({ ok: true, ...extra });
}

async function removeSome(id, pick) {
  let ids = null;
  await updateState(id, (s) => {
    ids = pick(s);
    return ids && removePictures(s, ids);
  });
  if (!ids) return json({ error: "say which pictures: ids, album or all" }, 400);
  await deletePictureFiles(id, ids);
  return json({ ok: true, removed: ids.length });
}

// A picture's files never change (an edit makes a new id), so browsers can keep them.
const IMMUTABLE = "private, max-age=31536000, immutable";

/**
 * A sealed picture file, or a 404 (null for a missing thumbnail, so the caller can fall back).
 * Served as opaque bytes, and as a download if opened directly, never as something to render.
 */
async function file(id, picId, ext, cache = IMMUTABLE) {
  const data = picId && (await images().get(`${id}/${picId}.${ext}`, { type: "arrayBuffer" }));
  if (!data) return ext === "thumb" ? null : json({ error: "not found" }, 404);
  return new Response(data, {
    headers: { "content-type": "application/octet-stream", "content-disposition": "attachment", "cache-control": cache },
  });
}

async function putSettings(req, id, frame) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "expected JSON body" }, 400);
  }
  const { settings, error } = mergeSettings(frame.settings, body);
  if (error) return json({ error }, 400);
  if (settings.album && !hasAlbum(await loadState(id), settings.album)) return json({ error: "no such folder" }, 400);
  await frames().setJSON(id, { ...frame, settings });
  return json({ ok: true, settings });
}

async function replace(req, id, oldId, frame) {
  let form;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "expected multipart form data" }, 400);
  }
  const panel = frame.settings?.panel || "7.3";
  const { parts, error } = await readPictureForm(form, panel);
  if (error) return json({ error }, 400);
  if (!has(await loadState(id), oldId)) return json({ error: "not found" }, 404);
  // A new id, so cached previews of the old version don't linger
  const pic = await storePicture(id, newPictureId(), parts, panel);
  if (!(await updateState(id, (s) => replacePicture(s, oldId, pic)))) {
    await deletePictureFiles(id, [pic.id]); // deleted while we were saving
    return json({ error: "not found" }, 404);
  }
  await deletePictureFiles(id, [oldId]);
  return json({ ok: true, id: pic.id });
}
