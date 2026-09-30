// Frame codes and the frames this device has opened. Shared by the home and upload pages.

// Crockford base32, as the server makes codes (netlify/lib/common.mjs newFrameCode)
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/**
 * What someone typed as a code -> the key to send. Frame codes are forgiving: any case, spaces
 * or dashes anywhere, and O/I/L read as 0/1/1. Anything else (an older long key) passes as is.
 */
export function normalizeCode(text) {
  const raw = String(text || "").trim();
  const c = raw.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return CODE_RE.test(c) ? c.match(/.{4}/g).join("-") : raw;
}

export const isFrameCode = (key) => CODE_RE.test(String(key || "").replace(/-/g, ""));

/** A pasted upload link (https://domiframe.art/f/<id>#k=<key>) -> { id, key }, or null. */
export function parseLink(text) {
  try {
    const u = new URL(String(text).trim());
    const id = (u.pathname.match(/^\/f\/([a-z0-9-]+)/) || [])[1];
    const key = new URLSearchParams(u.hash.slice(1)).get("k");
    return id && key ? { id, key } : null;
  } catch {
    return null;
  }
}

export const frameLink = (id, key) => `/f/${id}#k=${encodeURIComponent(key)}`;

// ---- Frames opened on this device ---------------------------------------------
// The upload page keeps each frame's key under domiframe:<id>; this list adds names and order.

const LIST = "domiframe:frames";

export function rememberedFrames() {
  try {
    const list = JSON.parse(localStorage.getItem(LIST) || "[]");
    return list.filter((f) => f && f.id && localStorage.getItem(`domiframe:${f.id}`));
  } catch {
    return [];
  }
}

export function rememberFrame(id, name) {
  try {
    const list = rememberedFrames().filter((f) => f.id !== id);
    list.unshift({ id, name: name || id, openedAt: new Date().toISOString() });
    localStorage.setItem(LIST, JSON.stringify(list.slice(0, 12)));
  } catch {}
}

export function forgetFrame(id) {
  try {
    localStorage.setItem(LIST, JSON.stringify(rememberedFrames().filter((f) => f.id !== id)));
    localStorage.removeItem(`domiframe:${id}`);
  } catch {}
}

export const savedKey = (id) => {
  try { return localStorage.getItem(`domiframe:${id}`); } catch { return null; }
};
