import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { emptyState, normalizeState, DEFAULT_SETTINGS } from "./schedule.mjs";
import { imageBytes } from "../../web/dither.js";

// Picture size depends on the frame's screen (web/dither.js PANELS): 4 bits per pixel,
// two pixels per byte, high nibble first. 7.3" = 192,000 bytes, 13.3" = 960,000 bytes.
export { imageBytes };
export const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;
export const MAX_ORIGINAL_BYTES = 4 * 1024 * 1024; // the photo as uploaded (JPEG, ~2000 px), for editing later
export const MAX_THUMB_BYTES = 256 * 1024; // small JPEG for the picture grid
export const MAX_EDITS_BYTES = 4096;

export const FRAME_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

const store = (name) => getStore({ name, consistency: "strong" });
export const frames = () => store("frames"); // <id> -> { name, uploadKeyHash, deviceKeyHash, createdAt, settings }
export const images = () => store("images"); // <id>/<picId>.bin (frame), .png (preview), .jpg (original), .thumb (grid)
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

export const newKey = () => randomBytes(24).toString("base64url");

// Upload keys people can type: a "frame code" like K7PX-92QD-M4TR-8WZN. 16 characters of
// Crockford base32 (no I, L, O or U, so nothing reads as another letter) = 80 random bits.
// Pages normalize what's typed to this form (web/code.js); older 32-character keys still work.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const newFrameCode = () =>
  [...randomBytes(16)].map((b) => CODE_ALPHABET[b & 31]).join("").match(/.{4}/g).join("-");
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
 *   image     packed 4bpp palette image, imageBytes(panel) long (required)
 *   preview   PNG of what the frame shows
 *   original  JPEG of the photo, so it can be edited again later
 *   thumb     small JPEG for the picture grid
 *   edits     JSON of the editor settings used
 * Returns { parts } or { error }.
 */
export async function readPictureForm(form, panel) {
  const bytes = imageBytes(panel);
  const image = form.get("image");
  if (!(image instanceof Blob) || image.size !== bytes) {
    return { error: `image must be exactly ${bytes} bytes for a ${panel || "7.3"}" screen` };
  }
  const bin = new Uint8Array(await image.arrayBuffer());
  if (!validIndices(bin)) return { error: "invalid palette index" };
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
      thumb: blobOf("thumb", MAX_THUMB_BYTES),
      edits,
    },
  };
}

/** Every nibble is a palette index 0-5. Checks 4 bytes at a time: this runs on ~1 MB for 13.3". */
function validIndices(bin) {
  const words = bin.byteLength % 4 === 0 && bin.byteOffset % 4 === 0
    ? new Uint32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4) : null;
  if (!words) return bin.every((b) => (b >> 4) <= 5 && (b & 0x0f) <= 5);
  // A nibble is > 5 when it's 6 or 7 (bit 2 and bit 1 set) or 8+ (bit 3 set).
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if ((w & 0x88888888) || ((w & 0x44444444) & ((w & 0x22222222) << 1))) return false;
  }
  return true;
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
