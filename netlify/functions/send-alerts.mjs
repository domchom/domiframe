// Every half hour: tell the people who asked when a frame is late or its battery is low
// (lib/alerts.mjs says when), on their iPhones through APNs (lib/push.mjs). Phones that no longer
// take them are forgotten.

import { frames, status, pushes, now } from "../lib/common.mjs";
import { alertFor, normalizePush, sameSub } from "../lib/alerts.mjs";
import { sendTo } from "../lib/push.mjs";
import { updatePush } from "./frame-alerts.mjs";

export const config = { schedule: "*/30 * * * *" };

/** One round for every frame with alerts. `send` is replaceable for tests. Returns what was sent. */
export async function runAlerts({ at = now(), send = sendTo } = {}) {
  const { blobs } = await pushes().list();
  const sent = [];
  for (const { key: id } of blobs) {
    const [rec, frame, st] = await Promise.all([
      pushes().get(id, { type: "json" }), frames().get(id, { type: "json" }), status().get(id, { type: "json" }),
    ]);
    const p = normalizePush(rec);
    if (!frame || !p.subs.length) {
      await pushes().delete(id);
      continue;
    }
    let { alert, next } = alertFor({ name: frame.name, status: st, settings: frame.settings, rec: p, now: at });
    let gone = [];
    if (alert) {
      const payload = { ...alert, frame: id };
      const results = await Promise.all(p.subs.map((s) => send(s, payload)));
      gone = p.subs.filter((_, i) => results[i] === "gone");
      const to = results.filter((r) => r === "ok").length;
      sent.push({ id, ...alert, to });
      // Nobody got it (push services down, keys not set up): try again next round
      if (!to) next = { late: p.late && next.late, low: p.low && next.low };
    }
    if (next.late !== p.late || next.low !== p.low || gone.length) {
      await updatePush(id, (cur) => ({ ...cur, ...next, subs: cur.subs.filter((s) => !gone.some((g) => sameSub(g, s))) }));
    }
  }
  return sent;
}

export default async () => {
  await runAlerts();
};
