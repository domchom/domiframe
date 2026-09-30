import { test } from "node:test";
import assert from "node:assert/strict";
import {
  choosePicture, nextWakeMinutes, addPicture, removePicture, mergeSettings, inQuietHours,
  emptyState, MAX_PICTURES, replacePicture, movePictures, deleteAlbum, addAlbum,
} from "../netlify/lib/schedule.mjs";

const H = 3600e3;
const T0 = Date.parse("2026-06-01T12:00:00Z");
const pic = (id) => ({ id, uploadedAt: new Date(T0).toISOString(), from: null, etag: id });
const withPics = (...ids) => ({ ...emptyState(), pictures: ids.map(pic) });

test("new pictures go up at the next check-in, oldest first", () => {
  let { state } = choosePicture(withPics("a", "b"), { rotateHours: 24 }, T0);
  assert.equal(state.current, "a");
  ({ state } = choosePicture(state, { rotateHours: 24 }, T0 + 60e3));
  assert.equal(state.current, "b", "b is unseen, so it goes up next");
  const r = choosePicture(state, { rotateHours: 24 }, T0 + 2 * 60e3);
  assert.equal(r.changed, false, "both seen, rotation not due");
});

test("rotates on schedule, wrapping around, with 5% drift allowed", () => {
  let state = { ...withPics("a", "b", "c"), current: "c", since: new Date(T0).toISOString(), seen: ["a", "b", "c"] };
  const s = { rotateHours: 12 };
  assert.equal(choosePicture(state, s, T0 + 11 * H).changed, false);
  ({ state } = choosePicture(state, s, T0 + 11.5 * H)); // 96% of 12 h
  assert.equal(state.current, "a");
});

test("rotateHours 0 keeps the picture until a new one arrives", () => {
  const state = { ...withPics("a", "b"), current: "a", since: new Date(T0).toISOString(), seen: ["a", "b"] };
  assert.equal(choosePicture(state, { rotateHours: 0 }, T0 + 1000 * H).changed, false);
});

test("deleting the current picture moves on; deleting all clears the frame", () => {
  let state = { ...withPics("a", "b"), current: "a", since: new Date(T0).toISOString(), seen: ["a", "b"] };
  state = removePicture(state, "a");
  assert.equal(choosePicture(state, {}, T0).state.current, "b");
  const empty = choosePicture(removePicture(state, "b"), {}, T0);
  assert.equal(empty.state.current, null);
  assert.equal(empty.changed, true);
});

test("queue keeps at most MAX_PICTURES, never dropping the one on the frame", () => {
  let state = { ...withPics("keep"), current: "keep", seen: ["keep"] };
  for (let i = 0; i < MAX_PICTURES + 3; i++) state = addPicture(state, pic(`p${i}`)).state;
  assert.equal(state.pictures.length, MAX_PICTURES);
  assert.ok(state.pictures.some((p) => p.id === "keep"));
  assert.ok(!state.pictures.some((p) => p.id === "p0"));
});

test("wake time: check interval, next rotation, low battery, quiet hours", () => {
  const since = new Date(T0).toISOString();
  const two = { ...withPics("a", "b"), current: "a", since, seen: ["a", "b"] };
  const one = { ...withPics("a"), current: "a", since, seen: ["a"] };

  assert.equal(nextWakeMinutes(one, { checkMinutes: 60 }, T0), 60);
  // rotation due in 20 minutes -> wake then, not in an hour
  assert.equal(nextWakeMinutes(two, { checkMinutes: 60, rotateHours: 1 }, T0 + 40 * 60e3), 20);
  // a single picture never rotates, so it doesn't shorten the sleep
  assert.equal(nextWakeMinutes(one, { checkMinutes: 60, rotateHours: 1 }, T0 + 40 * 60e3), 60);
  // low battery stretches checks to 4 h
  assert.equal(nextWakeMinutes(one, { checkMinutes: 60 }, T0, 3400), 240);
  assert.equal(nextWakeMinutes(two, { checkMinutes: 60, rotateHours: 1 }, T0 + 40 * 60e3, 3400), 240, "even when rotating");

  // quiet 23:00-07:00 in UTC: a check-in at 22:30 sleeps until 07:00
  const quiet = { checkMinutes: 60, quiet: true, quietStart: 23, quietEnd: 7, tz: "UTC" };
  assert.equal(nextWakeMinutes(one, quiet, Date.parse("2026-06-01T22:30:00Z")), 8.5 * 60);
  assert.equal(nextWakeMinutes(one, quiet, Date.parse("2026-06-01T12:00:00Z")), 60);
});

test("quiet hours respect the frame's time zone", () => {
  const s = { quiet: true, quietStart: 23, quietEnd: 7, tz: "America/New_York" };
  assert.equal(inQuietHours(Date.parse("2026-06-02T04:00:00Z"), s), true);  // midnight in New York
  assert.equal(inQuietHours(Date.parse("2026-06-02T16:00:00Z"), s), false); // noon in New York
});

test("settings validation", () => {
  assert.equal(mergeSettings({}, { rotateHours: 168 }).settings.rotateHours, 168);
  assert.ok(mergeSettings({}, { rotateHours: 5 }).error);
  assert.ok(mergeSettings({}, { checkMinutes: 1 }).error);
  assert.ok(mergeSettings({}, { quietStart: 24 }).error);
  assert.ok(mergeSettings({}, { tz: "Mars/Olympus" }).error);
  assert.equal(mergeSettings({ rotateHours: 1 }, { quiet: true }).settings.rotateHours, 1, "keeps other fields");
});

// ---- folders, show next, shuffle, replace ----------------------------------

const albums = [{ id: "beach0", name: "Beach" }, { id: "kids00", name: "Kids" }];
const filed = () => ({
  ...emptyState(),
  albums,
  pictures: [
    { ...pic("a"), album: "beach0" }, { ...pic("b"), album: "kids00" },
    { ...pic("c"), album: "beach0" }, { ...pic("d"), album: null },
  ],
  seen: ["a", "b", "c", "d"],
});

test("the frame cycles only through the chosen folder", () => {
  const s = { rotateHours: 1, album: "beach0" };
  let state = { ...filed(), current: "d", since: new Date(T0).toISOString() };
  ({ state } = choosePicture(state, s, T0 + 60e3)); // folder switched: move in right away
  assert.equal(state.current, "a");
  ({ state } = choosePicture(state, s, T0 + 2 * H));
  assert.equal(state.current, "c");
  ({ state } = choosePicture(state, s, T0 + 4 * H));
  assert.equal(state.current, "a", "wraps within the folder, skipping b and d");
  // new pictures outside the folder don't jump the queue
  state = addPicture(state, { ...pic("e"), album: "kids00" }).state;
  assert.equal(choosePicture(state, s, T0 + 4.1 * H).changed, false);
});

test("an empty or deleted folder falls back sensibly", () => {
  const state = { ...filed(), current: "a", since: new Date(T0).toISOString() };
  const empty = { ...state, albums: [...albums, { id: "empty0", name: "Empty" }] };
  assert.equal(choosePicture(empty, { album: "empty0", rotateHours: 1 }, T0 + 2 * H).changed, false, "keeps what's up");
  // a folder id that no longer exists means all pictures
  assert.equal(choosePicture(state, { album: "gone00", rotateHours: 1 }, T0 + 2 * H).state.current, "b");
});

test("show next jumps the queue and stays until the rotation is due", () => {
  const s = { rotateHours: 24, album: "beach0" };
  let state = { ...filed(), current: "a", since: new Date(T0).toISOString(), showNext: "b" };
  ({ state } = choosePicture(state, s, T0 + 60e3));
  assert.equal(state.current, "b", "even from another folder");
  assert.equal(state.showNext, null);
  assert.equal(choosePicture(state, s, T0 + 2 * H).changed, false, "stays until the rotation is due");
  ({ state } = choosePicture(state, s, T0 + 25 * H));
  assert.equal(state.current, "a", "then back to the folder");
});

test("shuffle shows every picture once per round, never twice in a row", () => {
  let state = { ...emptyState(), pictures: "pqrstu".split("").map(pic), seen: [..."pqrstu"], current: "p", since: new Date(T0).toISOString() };
  const s = { rotateHours: 1, order: "shuffle" };
  let rng = 0.37;
  const random = () => (rng = (rng * 9301 + 49297) % 233280 / 233280);
  const shown = [];
  for (let i = 1; i <= 10; i++) {
    const prev = state.current;
    ({ state } = choosePicture(state, s, T0 + i * H, random));
    assert.notEqual(state.current, prev);
    shown.push(state.current);
  }
  assert.equal(new Set(shown.slice(0, 5)).size, 5, "first round: 5 different pictures (all but the one that was up)");
});

test("replacing a picture keeps its place, folder and status; the frame redraws if it's up", () => {
  const state = { ...filed(), current: "c", since: new Date(T0).toISOString() };
  const next = replacePicture(state, "c", { ...pic("c2"), uploadedAt: "2026-07-01T00:00:00Z" });
  assert.deepEqual(next.pictures.map((p) => p.id), ["a", "b", "c2", "d"]);
  assert.equal(next.pictures[2].album, "beach0");
  assert.equal(next.current, "c2");
  assert.ok(next.seen.includes("c2") && !next.seen.includes("c"));
  assert.equal(replacePicture(state, "zz", pic("x")), null);
});

test("moving pictures and deleting folders", () => {
  let state = movePictures(filed(), ["d", "b"], "beach0");
  assert.deepEqual(state.pictures.filter((p) => p.album === "beach0").map((p) => p.id), ["a", "b", "c", "d"]);
  state = addAlbum(state, { id: "new000", name: "New" });
  let r = deleteAlbum(filed(), "beach0", false);
  assert.deepEqual(r.removed, []);
  assert.ok(r.state.pictures.find((p) => p.id === "a").album === null, "kept, unfiled");
  r = deleteAlbum(filed(), "beach0", true);
  assert.deepEqual(r.removed, ["a", "c"]);
  assert.equal(r.state.pictures.length, 2);
  assert.equal(r.state.albums.length, 1);
});

test("the rotation only includes pictures made for the frame's screen", () => {
  const state = { ...emptyState(), pictures: [{ ...pic("a") }, { ...pic("b"), panel: "13.3" }, { ...pic("c"), panel: "7.3" }] };
  const seen = { ...state, seen: ["a", "b", "c"], current: "a", since: new Date(T0).toISOString() };
  assert.equal(choosePicture(state, { panel: "13.3" }, T0).state.current, "b");
  assert.equal(choosePicture(seen, { panel: "7.3", rotateHours: 1 }, T0 + 2 * H).state.current, "c", "skips b");
  assert.ok(mergeSettings({}, { panel: "10" }).error);
});

test("settings validate orientation", () => {
  assert.equal(mergeSettings({}, {}).settings.orientation, "landscape");
  assert.equal(mergeSettings({}, { orientation: "portrait" }).settings.orientation, "portrait");
  assert.ok(mergeSettings({}, { orientation: "sideways" }).error);
});

test("settings validate folder and order", () => {
  assert.equal(mergeSettings({}, { album: "beach0", order: "shuffle" }).settings.order, "shuffle");
  assert.ok(mergeSettings({}, { album: "../x" }).error);
  assert.ok(mergeSettings({}, { order: "random" }).error);
  assert.equal(mergeSettings({ album: "beach0" }, { album: null }).settings.album, null);
});
