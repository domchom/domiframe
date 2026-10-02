// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { alertFor, readSub, addSub, removeSub, MAX_SUBS } from "../netlify/lib/alerts.mjs";

const NOON = Date.parse("2026-06-10T12:00:00Z");
const status = (minsAgo, { sleep = 60, mv = 3900 } = {}) => ({
  lastSeen: new Date(NOON - minsAgo * 60e3).toISOString(), sleepMinutes: sleep, batteryMv: mv,
});
const run = (st, rec = {}, { now = NOON, tz = "UTC" } = {}) =>
  alertFor({ name: "Kitchen", status: st, settings: { tz }, rec, now });

test("alerts: nothing while the frame checks in on time", () => {
  assert.equal(run(status(30)).alert, null);
  assert.equal(run(null).alert, null); // never checked in
});

test("alerts: a late frame is told once, until it checks in again", () => {
  const first = run(status(5 * 60));
  assert.equal(first.alert.title, "Kitchen is late");
  assert.match(first.alert.body, /5 h ago\. Check the Wi-Fi/);
  assert.deepEqual(first.next, { late: true, low: false });
  assert.equal(run(status(6 * 60), first.next).alert, null, "not again while still late");
  const back = run(status(10), first.next);
  assert.equal(back.alert, null);
  assert.equal(back.next.late, false, "on time again: the next late one is told");
});

test("alerts: low battery once, again only after charging", () => {
  const low = run(status(10, { mv: 3400 }));
  assert.equal(low.alert.title, "Kitchen: battery low");
  assert.match(low.alert.body, /12%/);
  assert.equal(run(status(10, { mv: 3420 }), low.next).alert, null);
  assert.equal(run(status(10, { mv: 3510 }), low.next).next.low, true, "25% isn't charged yet");
  assert.equal(run(status(10, { mv: 3700 }), low.next).next.low, false);
});

test("alerts: late with a low battery says both, once", () => {
  const both = run(status(5 * 60, { mv: 3400 }));
  assert.match(both.alert.body, /battery low\. Time to charge it/);
  assert.deepEqual(both.next, { late: true, low: true });
});

test("alerts: wait for the daytime where the frame hangs", () => {
  const night = run(status(5 * 60), {}, { tz: "Asia/Tokyo" }); // 21:00 there
  assert.equal(night.alert, null);
  assert.equal(night.next.late, false, "still to tell in the morning");
});

test("alerts: push addresses are checked", () => {
  const apns = readSub({ apns: "AB".repeat(32), sandbox: true }).sub;
  assert.deepEqual([apns.kind, apns.token, apns.sandbox], ["apns", "ab".repeat(32), true]);
  assert.ok(readSub({ apns: "nope" }).error);
  assert.ok(readSub({ web: { endpoint: "https://fcm.googleapis.com/x" } }).error, "only the app");
  assert.ok(readSub({}).error);
});

test("alerts: the same device once; the oldest go past the limit", () => {
  const sub = (n) => ({ kind: "apns", token: n.toString(16).padStart(64, "0") });
  let rec = addSub({}, sub(1));
  rec = addSub(rec, sub(1));
  assert.equal(rec.subs.length, 1);
  for (let i = 2; i <= MAX_SUBS + 5; i++) rec = addSub(rec, sub(i));
  assert.equal(rec.subs.length, MAX_SUBS);
  assert.equal(rec.subs[0].token, sub(6).token);
  assert.equal(removeSub(rec, sub(6)).subs.length, MAX_SUBS - 1);
});
