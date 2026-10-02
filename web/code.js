// Frame codes and the frames this device has opened. Shared by the home and upload pages.

// Crockford base32, as the frame makes codes (firmware/src/main.cpp newFrameCode)
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/**
 * What someone typed as a code -> the code in its usual form (XXXX-XXXX-XXXX-XXXX). Codes are
 * forgiving: any case, spaces or dashes anywhere, and O/I/L read as 0/1/1. Anything else comes
 * back as typed (and isFrameCode says no). The code itself never goes to the server; see seal.js.
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
    localStorage.removeItem(`domiframe:${id}:old`);
  } catch {}
}

// When a frame gets a new code, the server keeps the pictures sealed with the old one for
// OLD_CODE_DAYS (netlify/lib/common.mjs): typing the old code back into the frame's setup
// brings them back. So the old code is kept here that long too, instead of being overwritten.
export const OLD_CODE_DAYS = 30;

/** Save a frame's code; a different code saved before is kept as its old code. */
export function saveCode(id, code) {
  try {
    const before = localStorage.getItem(`domiframe:${id}`);
    if (before && before !== code && isFrameCode(before)) {
      localStorage.setItem(`domiframe:${id}:old`, JSON.stringify({ code: before, at: new Date().toISOString() }));
    }
    localStorage.setItem(`domiframe:${id}`, code);
  } catch {}
}

/** The code this frame had before, while it can still bring pictures back: { code, until } or null. */
export function oldCode(id) {
  try {
    const old = JSON.parse(localStorage.getItem(`domiframe:${id}:old`) || "null");
    const until = old && Date.parse(old.at) + OLD_CODE_DAYS * 864e5;
    if (old && isFrameCode(old.code) && until > Date.now()) return { code: old.code, until: new Date(until) };
    localStorage.removeItem(`domiframe:${id}:old`);
  } catch {}
  return null;
}

export const savedKey = (id) => {
  try { return localStorage.getItem(`domiframe:${id}`); } catch { return null; }
};
