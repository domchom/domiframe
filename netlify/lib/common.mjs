import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { emptyState, normalizeState, DEFAULT_SETTINGS } from "./schedule.mjs";
import { imageBytes } from "../../web/dither.js";
import { SEAL_OVERHEAD } from "../../web/seal.js";

// Everything people upload is encrypted in their browser with a key only they and the frame
// have (web/seal.js): pictures, sender names, folder names and edit settings. The server stores
// and passes on ciphertext, and can't check or read what's inside.
//
// Picture size depends on the frame's screen (web/dither.js PANELS): 4 bits per pixel,
// two pixels per byte, high nibble first. 7.3" = 192,000 bytes, 13.3" = 960,000 bytes,
// plus SEAL_OVERHEAD once encrypted.
export const sealedImageBytes = (panel) => imageBytes(panel) + SEAL_OVERHEAD;
export const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;
export const MAX_ORIGINAL_BYTES = 4 * 1024 * 1024; // the photo as uploaded (JPEG, ~2000 px), for editing later
export const MAX_THUMB_BYTES = 256 * 1024; // small JPEG for the picture grid
export const MAX_EDITS_CHARS = 8192;
export const MAX_NAME_CHARS = 400; // a sealed name of up to 40 characters, with room to spare

/** A sealed text field (web/seal.js sealText): base64url of at least IV + tag + 1 byte. */
export function sealedText(value, max) {
  const s = typeof value === "string" ? value : "";
  return s.length >= 39 && s.length <= max && /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
}

export const FRAME_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

const store = (name) => getStore({ name, consistency: "strong" });
export const frames = () => store("frames"); // <id> -> { name, uploadKeyHash, deviceKeyHash, createdAt, settings }
export const images = () => store("images"); // <id>/<picId>.bin (frame), .png (preview), .jpg (original), .thumb (grid), all sealed
export const status = () => store("status"); // <id> -> { lastSeen, batteryMv, fw, sleepMinutes }
export const states = () => store("state"); // <id> -> picture queue, see lib/schedule.mjs
export const pushes = () => store("push"); // <id> -> where to send alerts about it, see lib/alerts.mjs

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

/**
 * Change a frame's picture queue safely: fn(state) returns the new state, or null to leave it.
 * The write only lands if nobody else wrote in between (e.g. the frame checking in during an
 * upload); otherwise fn runs again on the fresh state. Returns the saved state, or null.
 */
export function updateState(id, fn) {
  // One at a time per frame within this process too: the local Blobs server (npm run local,
  // tests) checks ETags and writes in separate steps, so it can't be trusted to referee alone.
  const run = (locks.get(id) || Promise.resolve()).then(() => writeState(id, fn));
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => locks.get(id) === tail && locks.delete(id));
  return run;
}
const locks = new Map();

async function writeState(id, fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let got = await states().getWithMetadata(id, { type: "json" });
    if (!got) {
      await loadState(id); // migrates a pre-queue frame, if any
      got = await states().getWithMetadata(id, { type: "json" });
    }
    const next = fn(got ? normalizeState(got.data) : emptyState());
    if (!next) return null;
    const { modified } = await states().setJSON(id, next, got ? { onlyIfMatch: got.etag } : { onlyIfNew: true });
    if (modified) return next;
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * (attempt + 1)));
  }
  throw new Error("the frame is busy, try again");
}

export const PICTURE_FILES = ["bin", "png", "jpg", "thumb"];

export async function deletePictureFiles(id, picIds) {
  await Promise.all(picIds.flatMap((p) => PICTURE_FILES.map((ext) => images().delete(`${id}/${p}.${ext}`))));
}

// When a frame makes a new code, the pictures sealed with the old one are put aside instead of
// deleted. If the frame goes back to that code (typed into its setup portal) within
// OLD_CODE_DAYS, they come back; after that they're deleted for good. Only the code just before
// the current one is kept. The frame record holds oldCode: { hash, at }.
export const OLD_CODE_DAYS = 30;
export const asideKey = (id) => `${id}:old-code`;
export const oldCodeFresh = (frame) => !!frame?.oldCode && now() - Date.parse(frame.oldCode.at) < OLD_CODE_DAYS * 864e5;

/** Delete the pictures put aside with a frame's old code. */
export async function deleteAside(id) {
  const aside = await states().get(asideKey(id), { type: "json" });
  if (!aside) return;
  const s = normalizeState(aside);
  await deletePictureFiles(id, [...s.pictures, ...s.trash].map((p) => p.id));
  await states().delete(asideKey(id));
}

/** Once the old code's time is up, delete what was put aside with it. Returns the frame as saved. */
export async function purgeOldCode(id, frame) {
  if (!frame?.oldCode || oldCodeFresh(frame)) return frame;
  await deleteAside(id);
  const { oldCode, ...rest } = frame;
  await frames().setJSON(id, rest);
  return rest;
}

export const newKey = () => randomBytes(24).toString("base64url");

// The frame code (like K7PX-92QD-M4TR-8WZN) is made by the frame itself and never reaches the
// server: browsers derive an access token from it (web/seal.js frameKeys) and the frame
// registers that token's hash (POST /api/frames/:id/code). Only the hash is stored.
export const HASH_RE = /^[0-9a-f]{64}$/;
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

/**
 * Only people with the frame code can manage a frame's pictures. The admin can't: the pictures
 * are sealed anyway, and keeping the admin token out of these routes means a leaked admin
 * token can't delete or replace anyone's pictures either.
 */
export function canManage(req, frame) {
  return keyMatches(frame, bearer(req), "uploadKeyHash");
}

export function isAdmin(req) {
  const admin = Netlify.env.get("ADMIN_TOKEN");
  const token = bearer(req);
  if (!admin || !token) return false;
  return sameHash(hashKey(token), hashKey(admin));
}

/** What the admin page shows: how the frame is doing, and counts, but nothing people uploaded. */
export async function adminSummary(id, frame) {
  const s = await frameSummary(id, frame);
  return {
    id, name: s.name, lastSeen: s.lastSeen, batteryMv: s.batteryMv, fw: s.fw, nextCheckIn: s.nextCheckIn,
    settings: s.settings,
    claimed: !!frame.codeClaimedAt, // the frame has made its code and registered it
    pictures: s.pictures.length,
    unseen: s.pictures.filter((p) => !p.seen).length,
    albums: s.albums.length,
  };
}

/** Everything the upload page shows about a frame (names and edits still sealed). */
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
    trash: state.trash, // removed, restorable until removedAt + TRASH_DAYS
    defaultsDone: state.defaultsDone, // see POST /api/frames/:id/defaults
  };
}

/**
 * Parse an uploaded picture (multipart form):
 *   image     sealed packed 4bpp palette image, sealedImageBytes(panel) long (required)
 *   preview   sealed PNG of what the frame shows
 *   original  sealed JPEG of the photo, so it can be edited again later
 *   thumb     sealed small JPEG for the picture grid
 *   edits     sealed JSON of the editor settings used
 * Returns { parts } or { error }.
 */
export async function readPictureForm(form, panel) {
  const bytes = sealedImageBytes(panel);
  const image = form.get("image");
  if (!(image instanceof Blob) || image.size !== bytes) {
    return { error: `image must be exactly ${bytes} bytes (sealed) for a ${panel || "7.3"}" screen` };
  }
  const bin = new Uint8Array(await image.arrayBuffer());
  const blobOf = (name, max) => {
    const b = form.get(name);
    return b instanceof Blob && b.size > SEAL_OVERHEAD && b.size <= max ? b : null;
  };
  const rawEdits = form.get("edits");
  const edits = rawEdits ? sealedText(rawEdits, MAX_EDITS_CHARS) : null;
  if (rawEdits && !edits) return { error: "edits must be sealed" };
  return {
    parts: {
      bin,
      etag: createHash("sha256").update(bin).digest("hex").slice(0, 16),
      preview: blobOf("preview", MAX_PREVIEW_BYTES),
      original: blobOf("original", MAX_ORIGINAL_BYTES),
      thumb: blobOf("thumb", MAX_THUMB_BYTES),
      edits,
    },
  };
}

/** Save a parsed picture's files; returns the picture record (without album/from). */
export async function storePicture(id, picId, parts, panel) {
  const { bin, etag, preview, original, thumb, edits } = parts;
  const put = async (ext, blob) => blob && images().set(`${id}/${picId}.${ext}`, await blob.arrayBuffer());
  await Promise.all([
    images().set(`${id}/${picId}.bin`, bin.buffer, { metadata: { etag } }),
    put("png", preview), put("jpg", original), put("thumb", thumb),
  ]);
  return { id: picId, uploadedAt: new Date(now()).toISOString(), etag, hasOriginal: !!original, edits, panel: panel || "7.3" };
}
