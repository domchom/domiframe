import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { emptyState, normalizeState, DEFAULT_SETTINGS } from "./schedule.mjs";

// 7.3" E Ink Spectra 6 panel
export const WIDTH = 800;
export const HEIGHT = 480;
// 4 bits per pixel, two pixels per byte, high nibble first
export const IMAGE_BYTES = (WIDTH * HEIGHT) / 2;
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
export const MAX_ORIGINAL_BYTES = 4 * 1024 * 1024; // the photo as uploaded (JPEG, ~2000 px), for editing later
export const MAX_EDITS_BYTES = 4096;

export const FRAME_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

const store = (name) => getStore({ name, consistency: "strong" });
export const frames = () => store("frames"); // <id> -> { name, uploadKeyHash, deviceKeyHash, createdAt, settings }
export const images = () => store("images"); // <id>/<picId>.bin (frame), .png (preview), .jpg (original)
export const status = () => store("status"); // <id> -> { lastSeen, batteryMv, fw, sleepMinutes }
export const states = () => store("state"); // <id> -> picture queue, see lib/schedule.mjs

// Local dev (scripts/local.mjs) can move the clock forward to test schedules.
export const now = () => Date.now() + (globalThis.__domiframeClockOffset || 0);

export const newPictureId = () => now().toString(36).padStart(9, "0") + randomBytes(3).toString("hex");
export const PIC_ID_RE = /^[a-z0-9]{9,20}$/;
export const newAlbumId = () => randomBytes(5).toString("hex");

export async function loadState(id) {
  const state = await states().get(id, { type: "json" });
  if (state) return normalizeState(state);
  // Frames from before the picture queue kept a single <id>.bin
  const legacy = await images().getMetadata(`${id}.bin`);
  if (!legacy) return emptyState();
  const picId = newPictureId();
  const [bin, png] = await Promise.all([
    images().get(`${id}.bin`, { type: "arrayBuffer" }),
    images().get(`${id}.png`, { type: "arrayBuffer" }),
  ]);
  const { etag, uploadedAt } = legacy.metadata;
  await images().set(`${id}/${picId}.bin`, bin, { metadata: { etag } });
  if (png) await images().set(`${id}/${picId}.png`, png);
  await Promise.all([images().delete(`${id}.bin`), images().delete(`${id}.png`)]);
  const migrated = { ...emptyState(), pictures: [{ id: picId, uploadedAt, from: null, etag, album: null }] };
  await states().setJSON(id, migrated);
  return migrated;
}

export const saveState = (id, state) => states().setJSON(id, state);

export async function deletePictureFiles(id, picIds) {
  await Promise.all(picIds.flatMap((p) => ["bin", "png", "jpg"].map((ext) => images().delete(`${id}/${p}.${ext}`))));
}

export const newKey = () => randomBytes(24).toString("base64url");
export const hashKey = (key) => createHash("sha256").update(String(key), "utf8").digest("hex");

export function sameHash(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function bearer(req) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export async function loadFrame(id) {
  if (!FRAME_ID_RE.test(id || "")) return null;
  return frames().get(id, { type: "json" });
}

/** field is "uploadKeyHash" or "deviceKeyHash" */
export function keyMatches(frame, key, field) {
  if (!frame || !key) return false;
  return sameHash(hashKey(key), frame[field]);
}

/** Upload-link holders and the admin can view and manage a frame's pictures and settings. */
export function canManage(req, frame) {
  return keyMatches(frame, bearer(req), "uploadKeyHash") || isAdmin(req);
}

export function isAdmin(req) {
  const admin = Netlify.env.get("ADMIN_TOKEN");
  const token = bearer(req);
  if (!admin || !token) return false;
  return sameHash(hashKey(token), hashKey(admin));
}

/** Everything the upload and admin pages show about a frame. */
export async function frameSummary(id, frame) {
  const [s, state] = await Promise.all([status().get(id, { type: "json" }), loadState(id)]);
  const st = s || {};
  const nextCheckIn = st.lastSeen && st.sleepMinutes
    ? new Date(Date.parse(st.lastSeen) + st.sleepMinutes * 60e3).toISOString()
    : null;
  return {
    id,
    name: frame.name,
    lastSeen: st.lastSeen || null,
    batteryMv: st.batteryMv ?? null,
    fw: st.fw || null,
    nextCheckIn,
    settings: { ...DEFAULT_SETTINGS, ...frame.settings },
    current: state.current,
    since: state.since,
    showNext: state.showNext,
    albums: state.albums.map((a) => ({ ...a, count: state.pictures.filter((p) => p.album === a.id).length })),
    pictures: state.pictures.map((p) => ({ ...p, seen: state.seen.includes(p.id) })),
  };
}

/**
 * Parse an uploaded picture (multipart form):
 *   image     192000-byte packed 4bpp palette image (required)
 *   preview   PNG of what the frame shows
 *   original  JPEG of the photo, so it can be edited again later
 *   edits     JSON of the editor settings used
 * Returns { parts } or { error }.
 */
export async function readPictureForm(form) {
  const image = form.get("image");
  if (!(image instanceof Blob) || image.size !== IMAGE_BYTES) return { error: `image must be exactly ${IMAGE_BYTES} bytes` };
  const bin = new Uint8Array(await image.arrayBuffer());
  for (const b of bin) {
    if ((b >> 4) > 5 || (b & 0x0f) > 5) return { error: "invalid palette index" };
  }
  const blobOf = (name, max) => {
    const b = form.get(name);
    return b instanceof Blob && b.size > 0 && b.size <= max ? b : null;
  };
  let edits = null;
  const rawEdits = form.get("edits");
  if (typeof rawEdits === "string" && rawEdits.length <= MAX_EDITS_BYTES) {
    try {
      edits = JSON.parse(rawEdits);
    } catch {
      return { error: "edits must be JSON" };
    }
  }
  return {
    parts: {
      bin,
      etag: createHash("sha256").update(bin).digest("hex").slice(0, 16),
      preview: blobOf("preview", MAX_PREVIEW_BYTES),
      original: blobOf("original", MAX_ORIGINAL_BYTES),
      edits,
    },
  };
}

/** Save a parsed picture's files; returns the picture record (without album/from). */
export async function storePicture(id, picId, parts) {
  const { bin, etag, preview, original, edits } = parts;
  await images().set(`${id}/${picId}.bin`, bin.buffer, { metadata: { etag } });
  if (preview) await images().set(`${id}/${picId}.png`, await preview.arrayBuffer());
  if (original) await images().set(`${id}/${picId}.jpg`, await original.arrayBuffer());
  return { id: picId, uploadedAt: new Date(now()).toISOString(), etag, hasOriginal: !!original, edits };
}
