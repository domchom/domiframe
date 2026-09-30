// For the upload page. Auth: Authorization: Bearer <uploadKey>
//   GET /api/frames/:id/info    -> { name, lastSeen, batteryMv, imageUploadedAt }
//   GET /api/frames/:id/preview -> PNG of the current picture (404 if none)

import { images, status, loadFrame, keyMatches, bearer, json } from "../lib/common.mjs";

export const config = { path: ["/api/frames/:id/info", "/api/frames/:id/preview"], method: "GET" };

export default async (req, context) => {
  const id = context.params.id;
  const frame = await loadFrame(id);
  if (!frame || !keyMatches(frame, bearer(req), "uploadKeyHash")) {
    return json({ error: "not found or wrong link" }, 404);
  }

  if (new URL(req.url).pathname.endsWith("/preview")) {
    const png = await images().get(`${id}.png`, { type: "arrayBuffer" });
    if (!png) return json({ error: "no picture yet" }, 404);
    return new Response(png, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
  }

  const s = (await status().get(id, { type: "json" })) || {};
  const img = await images().getMetadata(`${id}.bin`);
  return json({
    name: frame.name,
    lastSeen: s.lastSeen || null,
    batteryMv: s.batteryMv ?? null,
    imageUploadedAt: img?.metadata?.uploadedAt || null,
  });
};
