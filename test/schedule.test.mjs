import { test } from "node:test";
import assert from "node:assert/strict";
import {
  choosePicture, nextWakeMinutes, retryMinutes, addPicture, removePicture, mergeSettings, inQuietHours,
  emptyState, MAX_PICTURES, replacePicture, movePictures, deleteAlbum, addAlbum,
  removePictures, restorePictures, emptyTrash, setPictureDay, isPictureDay, pool, TRASH_DAYS, MAX_TRASH,
  awakeSeconds, AWAKE_SECONDS,
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

test("the frame's next button: the next picture now, which then stays a whole turn", () => {
  const next = { advance: true };
  let state = { ...withPics("a", "b", "c"), current: "a", since: new Date(T0).toISOString(), seen: ["a", "b", "c"] };
  const s = { rotateHours: 24 };
  let r = choosePicture(state, s, T0 + H, Math.random, next);
  assert.equal(r.state.current, "b");
  assert.equal(choosePicture(r.state, s, T0 + 2 * H).changed, false, "stays until its turn is up");
  r = choosePicture(r.state, s, T0 + 2 * H, Math.random, next);
  assert.equal(r.state.current, "c");
  // even when the frame only changes for new pictures
  assert.equal(choosePicture(state, { rotateHours: 0 }, T0 + H, Math.random, next).state.current, "b");
  // a new picture still comes first
  state = { ...state, pictures: [...state.pictures, pic("d")] };
  assert.equal(choosePicture(state, s, T0 + H, Math.random, next).state.current, "d");
  // on a picture's day with just the one, next moves on to the usual ones until the turn is up
  state = setPictureDay({ ...withPics("a", "b", "bday"), current: "bday", since: new Date(T0).toISOString(), seen: ["a", "b", "bday"] }, ["bday"], "06-01");
  r = choosePicture(state, s, T0 + H, Math.random, next);
  assert.equal(r.state.current, "a");
  assert.equal(choosePicture(r.state, s, T0 + 2 * H).changed, false);
  // one picture: nothing to move to
  assert.equal(choosePicture({ ...withPics("a"), current: "a", seen: ["a"] }, s, T0, Math.random, next).state.current, "a");
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

test("a failed check-in retries at the usual interval, not the next wake's", () => {
  // what the frame waits after a check-in that doesn't get through: never the quiet-hours sleep
  const quiet = { checkMinutes: 30, quiet: true, quietStart: 23, quietEnd: 7, tz: "UTC" };
  assert.equal(retryMinutes(quiet), 30);
  assert.equal(retryMinutes({}), 60, "the default interval");
  assert.equal(retryMinutes(quiet, 3400), 240, "a low battery still stretches it");
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
  assert.deepEqual(r.removed, [], "nothing deleted for good yet");
  assert.deepEqual(r.state.trash.map((p) => p.id), ["a", "c"]);
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
  assert.equal(mergeSettings({}, {}).settings.flip, false);
  assert.equal(mergeSettings({}, { flip: true }).settings.flip, true);
  assert.ok(mergeSettings({}, { flip: 1 }).error);
});

test("stay awake: only plugged in, and not in quiet hours", () => {
  assert.equal(mergeSettings({}, {}).settings.awake, false);
  assert.equal(mergeSettings({}, { awake: true }).settings.awake, true);
  assert.ok(mergeSettings({}, { awake: "yes" }).error);
  assert.equal(awakeSeconds({ awake: true }, true, T0), AWAKE_SECONDS);
  assert.equal(awakeSeconds({ awake: true }, false, T0), 0, "on its battery it sleeps");
  assert.equal(awakeSeconds({ awake: false }, true, T0), 0);
  const quiet = { awake: true, quiet: true, quietStart: 11, quietEnd: 13, tz: "UTC" }; // T0 is 12:00 UTC
  assert.equal(awakeSeconds(quiet, true, T0), 0, "it sleeps through quiet hours");
  assert.equal(awakeSeconds(quiet, true, T0 + 2 * H), AWAKE_SECONDS);
});

test("settings validate folder and order", () => {
  assert.equal(mergeSettings({}, { album: "beach0", order: "shuffle" }).settings.order, "shuffle");
  assert.ok(mergeSettings({}, { album: "../x" }).error);
  assert.ok(mergeSettings({}, { order: "random" }).error);
  assert.equal(mergeSettings({ album: "beach0" }, { album: null }).settings.album, null);
});

test("pictures for a day: only on that day, in the frame's time zone, then back to the rotation", () => {
  // T0 is 2026-06-01 12:00 UTC
  let state = setPictureDay({ ...withPics("a", "b", "bday"), current: "a", since: new Date(T0).toISOString(), seen: ["a", "b"] }, ["bday"], "06-02");
  const s = { rotateHours: 24, tz: "UTC" };
  assert.deepEqual(pool(state, s).map((p) => p.id), ["a", "b"], "not in the rotation");
  assert.equal(choosePicture(state, s, T0).changed, false, "not its day yet, and new or not it waits");
  let r = choosePicture(state, s, T0 + 12.5 * H); // 06-02 00:30 UTC
  assert.equal(r.state.current, "bday");
  r = choosePicture(r.state, s, T0 + 20 * H);
  assert.equal(r.changed, false, "stays all day");
  r = choosePicture(r.state, s, T0 + 36.5 * H); // 06-03
  assert.notEqual(r.state.current, "bday", "leaves when its day is over");
  // Tokyo is 9 hours ahead: already 06-02 there at T0 + 3 h
  assert.equal(choosePicture(state, { ...s, tz: "Asia/Tokyo" }, T0 + 3 * H).state.current, "bday");
  // several on one day take turns on the rotation schedule
  state = setPictureDay(state, ["b"], "2026-06-02");
  r = choosePicture(state, s, T0 + 12.5 * H);
  assert.equal(r.state.current, "b");
  r = choosePicture(r.state, s, T0 + 12.5 * H + 24 * H * 0.5);
  assert.equal(r.changed, false);
  // a one-off date doesn't come back next year; a yearly one does
  assert.ok(!isPictureDay("2026-06-02", "2027-06-02"));
  assert.ok(isPictureDay("06-02", "2027-06-02"));
  assert.ok(isPictureDay("02-29", "2027-02-28"), "Feb 29 shows on Feb 28 in other years");
  assert.ok(!isPictureDay("02-29", "2028-02-28"));
  assert.equal(setPictureDay(state, ["bday"], null).pictures.find((p) => p.id === "bday").day, undefined);
});

test("removed pictures go to the trash: restore, empty, expire, overflow", () => {
  const t = T0;
  let state = { ...withPics("a", "b", "c"), albums: [{ id: "beach0", name: "x" }] };
  state = movePictures(state, ["a"], "beach0");
  let r = removePictures(state, ["a", "b"], t);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.state.pictures.map((p) => p.id), ["c"]);
  assert.deepEqual(r.state.trash.map((p) => [p.id, p.removedAt]), [["a", new Date(t).toISOString()], ["b", new Date(t).toISOString()]]);
  // restore puts them back in upload order and their folder, if it still exists
  state = restorePictures({ ...r.state, albums: [] }, ["a"]);
  assert.deepEqual(state.pictures.map((p) => [p.id, p.album]), [["a", null], ["c", undefined]]);
  assert.deepEqual(state.trash.map((p) => p.id), ["b"]);
  assert.ok(state.seen.includes("a"), "doesn't jump the queue");
  assert.equal(restorePictures(state, ["zz"]), null);
  // expire after TRASH_DAYS, or empty on demand
  assert.deepEqual(emptyTrash(state, null, t + (TRASH_DAYS - 1) * 24 * H).removed, []);
  assert.deepEqual(emptyTrash(state, null, t + (TRASH_DAYS + 1) * 24 * H).removed, ["b"]);
  assert.deepEqual(emptyTrash(state, ["b"], t).state.trash, []);
  // a full trash deletes the oldest for good
  let big = withPics(...Array.from({ length: MAX_TRASH + 2 }, (_, i) => `p${i}`));
  r = removePictures(big, big.pictures.map((p) => p.id), t);
  assert.deepEqual(r.removed, ["p0", "p1"]);
  assert.equal(r.state.trash.length, MAX_TRASH);
  // no room to restore into a full frame
  const full = { ...withPics(...Array.from({ length: MAX_PICTURES }, (_, i) => `q${i}`)), trash: [{ ...pic("x"), removedAt: "" }] };
  assert.equal(restorePictures(full, ["x"]), null);
});
