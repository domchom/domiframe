// For the upload page. Auth: Authorization: Bearer <token derived from the frame code (web/seal.js)>
// Picture files, sender names, folder names and edits are sealed in the browser: they come back
// exactly as sent, and only someone with the frame code can open them.
//   GET    /api/frames/:id/info                     -> name, check-ins, battery, settings, folders, pictures
//   GET    /api/frames/:id/preview                  -> PNG of the picture on the frame now
//   PUT    /api/frames/:id/settings                 -> { rotateHours, checkMinutes, album, order, quiet, quietStart, quietEnd, tz, name }
//                                                      (name: the frame's own name, plain text, as the admin set it)
//
//   GET    /api/frames/:id/pictures/:pic            -> PNG preview
//   GET    /api/frames/:id/pictures/:pic/thumb      -> small JPEG for the picture grid (PNG preview if none)
//   GET    /api/frames/:id/pictures/:pic/original   -> the photo as uploaded (JPEG), for editing again
//   PUT    /api/frames/:id/pictures/:pic            -> replace with an edited version (same form as uploading)
//   POST   /api/frames/:id/pictures/:pic/show       -> put it up at the frame's next check-in
//   DELETE /api/frames/:id/pictures/:pic            -> move it to the trash
//   DELETE /api/frames/:id/pictures  {ids} | {album} | {all: true}  -> move several to the trash
//   PATCH  /api/frames/:id/pictures  {ids, album}   -> move to a folder (album null = no folder)
//   PATCH  /api/frames/:id/pictures  {ids, day}     -> show only on a day: "MM-DD" every year, "YYYY-MM-DD" once, null = always
//
//   POST   /api/frames/:id/restore  {ids}           -> put pictures back from the trash
//   DELETE /api/frames/:id/trash  {ids} | {all: true}  -> delete pictures in the trash for good
//   (pictures in the trash are deleted for good after TRASH_DAYS)
//
//   POST   /api/frames/:id/albums  {name}           -> new folder (name sealed)
//   PATCH  /api/frames/:id/albums/:album  {name}    -> rename
//   DELETE /api/frames/:id/albums/:album?pictures=delete|keep

import {
  frames, images, loadFrame, canManage, json, loadState, updateState, deletePictureFiles, frameSummary,
  readPictureForm, storePicture, newPictureId, newAlbumId, PIC_ID_RE, now, sealedText, MAX_NAME_CHARS,
  purgeOldCode,
} from "../lib/common.mjs";
import {
  mergeSettings, removePictures, replacePicture, movePictures, addAlbum, renameAlbum, deleteAlbum,
  restorePictures, emptyTrash, setPictureDay, ALBUM_ID_RE, MAX_ALBUMS, DAY_RE, MAX_PICTURES,
} from "../lib/schedule.mjs";

export const config = {
  path: [
    "/api/frames/:id/info", "/api/frames/:id/preview", "/api/frames/:id/settings",
    "/api/frames/:id/pictures", "/api/frames/:id/pictures/:pic", "/api/frames/:id/pictures/:pic/:action",
    "/api/frames/:id/albums", "/api/frames/:id/albums/:album", "/api/frames/:id/restore", "/api/frames/:id/trash",
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
      await Promise.all([purgeTrash(id), purgeOldCode(id, frame)]);
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
      if ("day" in body) {
        if (body.day !== null && !validDay(body.day)) return json({ error: 'day must be "MM-DD", "YYYY-MM-DD" or null' }, 400);
        return change(id, (s) => setPictureDay(s, body.ids, body.day));
      }
      return change(id, (s) => (body.album === null || hasAlbum(s, body.album) ? movePictures(s, body.ids, body.album) : null));
    }

    case "POST restore": {
      const body = await body_(req);
      if (!Array.isArray(body.ids)) return json({ error: "ids required" }, 400);
      let full = false;
      const saved = await updateState(id, (s) => {
        const out = restorePictures(s, body.ids);
        full = !out && s.trash.some((p) => body.ids.includes(p.id));
        return out;
      });
      if (full) return json({ error: `a frame keeps ${MAX_PICTURES} pictures: remove some first` }, 409);
      return saved ? json({ ok: true }) : json({ error: "not found" }, 404);
    }
    case "DELETE trash": {
      const body = await body_(req);
      if (!Array.isArray(body.ids) && body.all !== true) return json({ error: "say which pictures: ids or all" }, 400);
      let removed = [];
      await updateState(id, (s) => {
        const out = emptyTrash(s, body.all === true ? s.trash.map((p) => p.id) : body.ids);
        removed = out.removed;
        return removed.length ? out.state : null;
      });
      await deletePictureFiles(id, removed);
      return json({ ok: true, removed: removed.length });
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
        const out = deleteAlbum(s, item, del, now());
        removed = out.removed;
        return out.state;
      });
      if (!saved) return json({ error: "not found" }, 404);
      await deletePictureFiles(id, removed);
      if (frame.settings?.album === item) await frames().setJSON(id, { ...frame, settings: { ...frame.settings, album: null } });
      return json({ ok: true });
    }
  }
  return json({ error: "not found" }, 404);
};

/** "MM-DD" or "YYYY-MM-DD" that's a real date (Feb 29 allowed for every year). */
function validDay(day) {
  if (typeof day !== "string" || !DAY_RE.test(day)) return false;
  const [y, m, d] = (day.length === 10 ? day : `2024-${day}`).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Delete pictures that have been in the trash longer than TRASH_DAYS. */
async function purgeTrash(id) {
  let removed = [];
  await updateState(id, (s) => {
    const out = emptyTrash(s, null, now());
    removed = out.removed;
    return removed.length ? out.state : null;
  });
  if (removed.length) await deletePictureFiles(id, removed);
}

const has = (s, pic) => s.pictures.some((p) => p.id === pic);
const hasAlbum = (s, album) => s.albums.some((a) => a.id === album);
const body_ = (req) => req.json().catch(() => ({}));

/** Apply fn to the state (null = not found) and save. */
async function change(id, fn, extra = {}) {
  if (!(await updateState(id, fn))) return json({ error: "not found" }, 404);
  return json({ ok: true, ...extra });
}

/** Move pictures to the trash. Their files stay until the trash is emptied. */
async function removeSome(id, pick) {
  let ids = null, overflow = [];
  await updateState(id, (s) => {
    ids = pick(s);
    if (!ids) return null;
    const out = removePictures(s, ids, now());
    overflow = out.removed;
    return out.state;
  });
  if (!ids) return json({ error: "say which pictures: ids, album or all" }, 400);
  await deletePictureFiles(id, overflow);
  return json({ ok: true, removed: ids.length, ids });
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
  // The frame's name isn't a setting, but its owners can change it too
  const { name: rawName, ...rest } = body || {};
  let name = frame.name;
  if (rawName !== undefined) {
    name = String(rawName).trim().slice(0, 60);
    if (!name) return json({ error: "name can't be empty" }, 400);
  }
  const { settings, error } = mergeSettings(frame.settings, rest);
  if (error) return json({ error }, 400);
  if (settings.album && !hasAlbum(await loadState(id), settings.album)) return json({ error: "no such folder" }, 400);
  await frames().setJSON(id, { ...frame, name, settings });
  return json({ ok: true, name, settings });
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
