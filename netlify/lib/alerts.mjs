// Alerts: an iPhone that asked to be told when a frame is late or its battery is low.
// Pure functions, no storage or network (sending is in lib/push.mjs, the schedule in
// functions/send-alerts.mjs).
//
// Push record, one per frame, in the "push" store:
//   subs   [{ kind: "apns", token, sandbox, at }]  (the DomiFrame app on an iPhone or iPad)
//   late   true once a "late" alert went out, until the frame checks in on time again
//   low    true once a "battery low" alert went out, until it's charged again
//
// The server already knows each frame's name, check-ins and battery (see the README's privacy
// section); a push address adds nothing about anyone's pictures.

import { isLate, batteryPct, LOW_BATTERY_PCT } from "../../web/format.js";
import { localHour } from "./schedule.mjs";

export const MAX_SUBS = 50; // per frame
export const CHARGED_PCT = LOW_BATTERY_PCT + 10; // the battery alert can come again once it's back above this
// Alerts wait for the daytime where the frame hangs: nobody needs a buzz at 3 am about a frame
export const DAY_START = 8;
export const DAY_END = 21;

export const emptyPush = () => ({ subs: [], late: false, low: false });
export const normalizePush = (p) => ({ ...emptyPush(), ...p, subs: Array.isArray(p?.subs) ? p.subs : [] });

const APNS_TOKEN = /^[0-9a-f]{64,200}$/;

/**
 * A push address from PUT /api/frames/:id/alerts, checked: { sub } or { error }.
 *   { apns: "<device token hex>", sandbox: true|false }  (sandbox: a debug build of the app)
 */
export function readSub(body, now = Date.now()) {
  if (body?.apns === undefined) return { error: "say where to send alerts: apns" };
  const token = String(body.apns).toLowerCase();
  if (!APNS_TOKEN.test(token)) return { error: "apns must be a device token (hex)" };
  return { sub: { kind: "apns", token, sandbox: body.sandbox === true, at: new Date(now).toISOString() } };
}

/** The same phone: the same token. */
export const sameSub = (a, b) => a.kind === b.kind && a.token === b.token;

/** Add or refresh a push address; the oldest go once there are MAX_SUBS. */
export function addSub(rec, sub) {
  const p = normalizePush(rec);
  const subs = [...p.subs.filter((s) => !sameSub(s, sub)), sub].slice(-MAX_SUBS);
  return { ...p, subs };
}

export function removeSub(rec, sub) {
  const p = normalizePush(rec);
  return { ...p, subs: p.subs.filter((s) => !sameSub(s, sub)) };
}

/** "5 h ago", as web/format.js ago, at a given time. */
export function agoAt(iso, now) {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 5400) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/**
 * What to tell a frame's people now, from its last check-in (status store) and settings.
 * Returns { alert: { title, body } | null, next: the push record's new late/low flags }.
 * Each problem is told once, until it's over: a frame that stays late isn't reported again
 * every half hour. Nothing is sent overnight where the frame hangs; it waits for the morning.
 */
export function alertFor({ name, status, settings, rec, now }) {
  const p = normalizePush(rec);
  const st = status || {};
  const nextCheckIn = st.lastSeen && st.sleepMinutes
    ? new Date(Date.parse(st.lastSeen) + st.sleepMinutes * 60e3).toISOString() : null;
  const late = isLate(st.lastSeen, nextCheckIn, now);
  const pct = batteryPct(st.batteryMv);
  const low = pct != null && pct < LOW_BATTERY_PCT;
  // Flags clear as soon as the problem is over, day or night
  const next = { late: p.late && late, low: p.low && !(pct != null && pct >= CHARGED_PCT) };
  const newLate = late && !p.late, newLow = low && !p.low;
  if (!newLate && !newLow) return { alert: null, next };
  const hour = localHour(now, settings?.tz || "UTC");
  if (hour < DAY_START || hour >= DAY_END) return { alert: null, next };

  const who = name || "Your frame";
  let alert;
  if (late) {
    alert = {
      title: `${who} is late`,
      body: low
        ? `It last checked in ${agoAt(st.lastSeen, now)}, with its battery low. Time to charge it.`
        : `It last checked in ${agoAt(st.lastSeen, now)}. Check the Wi-Fi where it hangs, or press its button.`,
    };
  } else {
    alert = { title: `${who}: battery low`, body: `It's at ${pct}%. Time to charge it.` };
  }
  // A late alert covers a low battery too, so it isn't told again separately
  return { alert, next: { late: late || next.late, low: low || next.low } };
}
