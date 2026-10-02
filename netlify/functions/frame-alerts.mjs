// Alerts when a frame is late or its battery is low, sent to the iPhone app.
//   PUT    /api/frames/:id/alerts  {apns, sandbox} [, tz]  -> start sending alerts to this phone
//   DELETE /api/frames/:id/alerts  {apns}                  -> stop
// Auth for the frame routes: the token derived from the frame code, as for its pictures. A new
// frame code stops every alert (functions/frame-code.mjs). Sending: functions/send-alerts.mjs.

import { frames, pushes, loadFrame, canManage, json } from "../lib/common.mjs";
import { readSub, addSub, removeSub, normalizePush } from "../lib/alerts.mjs";
import { mergeSettings } from "../lib/schedule.mjs";

export const config = { path: "/api/frames/:id/alerts" };

export default async (req, context) => {
  const id = context.params.id;
  const frame = await loadFrame(id);
  if (!frame || !canManage(req, frame)) return json({ error: "not found or wrong link" }, 404);
  if (req.method !== "PUT" && req.method !== "DELETE") return json({ error: "method not allowed" }, 405, { allow: "PUT, DELETE" });

  const body = await req.json().catch(() => null);
  const { sub, error } = readSub(body);
  if (error) return json({ error }, 400);

  if (req.method === "DELETE") {
    await updatePush(id, (p) => removeSub(p, sub));
    return json({ ok: true });
  }
  // Alerts wait for the daytime where the frame hangs: give it this device's time zone if it has none yet
  if ((frame.settings?.tz || "UTC") === "UTC" && body.tz && body.tz !== "UTC") {
    const { settings, error: tzError } = mergeSettings(frame.settings, { tz: String(body.tz) });
    if (!tzError) await frames().setJSON(id, { ...frame, settings });
  }
  await updatePush(id, (p) => addSub(p, sub));
  return json({ ok: true });
};

/** Change a frame's push record safely, as updateState does for pictures (lib/common.mjs). */
export async function updatePush(id, fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const got = await pushes().getWithMetadata(id, { type: "json" });
    const next = fn(normalizePush(got?.data));
    if (!next) return null;
    const { modified } = next.subs.length || got
      ? await pushes().setJSON(id, next, got ? { onlyIfMatch: got.etag } : { onlyIfNew: true })
      : { modified: true }; // nothing to keep, and nothing there
    if (modified) return next;
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * (attempt + 1)));
  }
  throw new Error("busy, try again");
}
