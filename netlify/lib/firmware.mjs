// Firmware updates over Wi-Fi. A frame says which build it runs (X-Fw-Env) and its version
// (X-Fw); when a newer release exists, its check-in reply says where to get it. The frame only
// installs it if the signature checks out against the public key built into it
// (firmware/tools/release.py), so whoever runs the server can't send it anything else.
import releases from "./firmware-releases.mjs";

const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v || "") ? v.split(".").map(Number) : null);

/** a > b, for versions like "0.7.0" (false if either isn't one) */
export function newerVersion(a, b) {
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The reply headers offering an update to this frame, or {} if it's up to date. */
export function firmwareHeaders(env, version) {
  const r = (globalThis.__domiframeFirmware || releases)[env];
  if (!r || !newerVersion(r.version, version)) return {};
  return {
    "x-fw-update": r.version,
    "x-fw-url": `/firmware/${r.file}`,
    "x-fw-size": String(r.size),
    "x-fw-sig": r.sig,
  };
}
