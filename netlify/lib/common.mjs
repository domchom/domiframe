import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

// 7.3" E Ink Spectra 6 panel
export const WIDTH = 800;
export const HEIGHT = 480;
// 4 bits per pixel, two pixels per byte, high nibble first
export const IMAGE_BYTES = (WIDTH * HEIGHT) / 2;
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

export const FRAME_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

const store = (name) => getStore({ name, consistency: "strong" });
export const frames = () => store("frames"); // <id> -> { name, uploadKeyHash, deviceKeyHash, createdAt }
export const images = () => store("images"); // <id>.bin, <id>.png
export const status = () => store("status"); // <id> -> { lastSeen, batteryMv, fw }

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

export function isAdmin(req) {
  const admin = Netlify.env.get("ADMIN_TOKEN");
  const token = bearer(req);
  if (!admin || !token) return false;
  return sameHash(hashKey(token), hashKey(admin));
}
