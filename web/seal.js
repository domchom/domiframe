// End-to-end encryption for a frame's pictures. The server (and whoever runs it) only ever
// stores and passes on ciphertext: the key comes from the frame code, which the frame makes
// itself and shows on its screen, and which never leaves the browser or the frame.
//
// From the code (16 Crockford base32 characters, dashes removed) and the frame ID, HKDF-SHA256
// derives two unrelated 32-byte values:
//   info "auth"     -> base64url, sent as `Authorization: Bearer ...` (the server keeps its SHA-256)
//   info "content"  -> AES-256-GCM key for pictures, sender names, folder names and edit settings
// Salt is "domiframe:<frame id>". The firmware does the same (firmware/src/main.cpp frameKeys).
//
// Sealed data is IV (12 bytes) || ciphertext || tag (16 bytes). Text fields are sealed UTF-8,
// base64url encoded.
//
// Works in browsers and Node 20+ (globalThis.crypto).

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
export const SEAL_OVERHEAD = 12 + 16;

const hkdf = (frameId, info) => ({
  name: "HKDF", hash: "SHA-256", salt: utf8.encode(`domiframe:${frameId}`), info: utf8.encode(info),
});

/** Frame code + ID -> { auth: the bearer token for the API, key: CryptoKey for content }. */
export async function frameKeys(frameId, code) {
  const ikm = await subtle.importKey("raw", utf8.encode(String(code).replace(/-/g, "")), "HKDF", false, ["deriveBits", "deriveKey"]);
  const [authBits, key] = await Promise.all([
    subtle.deriveBits(hkdf(frameId, "auth"), ikm, 256),
    subtle.deriveKey(hkdf(frameId, "content"), ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
  ]);
  return { auth: b64url(new Uint8Array(authBits)), key };
}

/** Bytes (ArrayBuffer, typed array or Blob) -> sealed Uint8Array. */
export async function seal(key, data) {
  const plain = data instanceof Blob ? await data.arrayBuffer() : data;
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

/** Sealed bytes -> ArrayBuffer. Throws if the key is wrong or the data was changed. */
export async function unseal(key, sealed) {
  const buf = new Uint8Array(sealed instanceof Blob ? await sealed.arrayBuffer() : sealed);
  return subtle.decrypt({ name: "AES-GCM", iv: buf.subarray(0, 12) }, key, buf.subarray(12));
}

export const sealText = async (key, text) => b64url(await seal(key, utf8.encode(String(text))));

/** A sealed text field -> string, or null when missing or unreadable. */
export async function unsealText(key, sealed) {
  if (typeof sealed !== "string" || !sealed) return null;
  try {
    return new TextDecoder().decode(await unseal(key, fromB64url(sealed)));
  } catch {
    return null;
  }
}

export function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text) {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
