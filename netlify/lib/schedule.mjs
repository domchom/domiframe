// Which picture a frame shows, and when it should wake next. Pure functions, no storage.
//
// Frame state:
//   pictures   [{id, uploadedAt, from, etag, album, hasOriginal, edits, day?}], oldest first
//              day: "MM-DD" (every year) or "YYYY-MM-DD" (once): shown only on that day
//   trash      removed pictures, [{...picture, removedAt}], kept TRASH_DAYS so they can be restored
//   albums     [{id, name, createdAt}]  (folders; a picture is in at most one)
//   current    id of the picture on the frame (null before the first one)
//   since      ISO time `current` went up
//   seen       ids that have been on the frame at least once
//   showNext   id to put up at the next check-in, ahead of the schedule
//   onDemand   true while `current` was put up with showNext
//   bag        ids still to come in this round of shuffle

export const ROTATE_HOURS = [0, 1, 3, 6, 12, 24, 72, 168]; // 0 = only when a new picture arrives
export const CHECK_MINUTES = [15, 30, 60, 120, 240, 480];
export const MAX_PICTURES = 200;
export const MAX_ALBUMS = 50;
export const LOW_BATTERY_MV = 3450;
export const ALBUM_ID_RE = /^[a-z0-9]{6,20}$/;
export const TRASH_DAYS = 30;
export const MAX_TRASH = 100; // beyond this the oldest are deleted for good, to bound storage
export const DAY_RE = /^(\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const PANEL_IDS = ["7.3", "13.3"]; // see PANELS in web/dither.js

export const DEFAULT_SETTINGS = {
  panel: "7.3",             // screen size; the frame reports it on every check-in
  orientation: "landscape", // how the frame hangs; pictures are made for it
  rotateHours: 24,
  checkMinutes: 60,
  album: null,        // folder the frame cycles through; null = all pictures
  order: "inorder",   // "inorder" (oldest first) or "shuffle"
  quiet: false,       // no check-ins overnight, to save battery
  quietStart: 23,     // local hour, inclusive
  quietEnd: 7,        // local hour, exclusive
  tz: "UTC",          // IANA time zone for quiet hours
};

export const emptyState = () => ({
  pictures: [], albums: [], current: null, since: null, seen: [], showNext: null, onDemand: false, bag: [], trash: [],
});

/** Older states lack newer fields. */
export const normalizeState = (state) => ({ ...emptyState(), ...state });

/** Validate a partial settings update. Returns { settings } or { error }. */
export function mergeSettings(current, update) {
  const s = { ...DEFAULT_SETTINGS, ...current };
  const u = update || {};
  if ("rotateHours" in u) {
    if (!ROTATE_HOURS.includes(Number(u.rotateHours))) return { error: `rotateHours must be one of ${ROTATE_HOURS}` };
    s.rotateHours = Number(u.rotateHours);
  }
  if ("checkMinutes" in u) {
    if (!CHECK_MINUTES.includes(Number(u.checkMinutes))) return { error: `checkMinutes must be one of ${CHECK_MINUTES}` };
    s.checkMinutes = Number(u.checkMinutes);
  }
  if ("panel" in u) {
    if (!PANEL_IDS.includes(u.panel)) return { error: `panel must be one of ${PANEL_IDS.join(", ")}` };
    s.panel = u.panel;
  }
  if ("orientation" in u) {
    if (!["landscape", "portrait"].includes(u.orientation)) return { error: 'orientation must be "landscape" or "portrait"' };
    s.orientation = u.orientation;
  }
  if ("album" in u) {
    if (u.album !== null && !ALBUM_ID_RE.test(String(u.album))) return { error: "album must be a folder id or null" };
    s.album = u.album;
  }
  if ("order" in u) {
    if (!["inorder", "shuffle"].includes(u.order)) return { error: 'order must be "inorder" or "shuffle"' };
    s.order = u.order;
  }
  if ("quiet" in u) s.quiet = Boolean(u.quiet);
  for (const k of ["quietStart", "quietEnd"]) {
    if (k in u) {
      const h = Number(u[k]);
      if (!Number.isInteger(h) || h < 0 || h > 23) return { error: `${k} must be an hour 0-23` };
      s[k] = h;
    }
  }
  if ("tz" in u) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: String(u.tz) });
    } catch {
      return { error: "unknown time zone" };
    }
    s.tz = String(u.tz);
  }
  return { settings: s };
}

/** The local date at `ms` in `tz`, as "YYYY-MM-DD". */
export function localDate(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** Is a picture's day ("MM-DD" every year, or "YYYY-MM-DD") the date `ymd`? Feb 29 shows on Feb 28 in other years. */
export function isPictureDay(day, ymd) {
  if (!day) return false;
  if (day.length === 10) return day === ymd;
  const md = ymd.slice(5), year = Number(ymd.slice(0, 4));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day === md || (day === "02-29" && !leap && md === "02-28");
}

export function localHour(ms, tz) {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(ms);
  return Number(h) % 24;
}

export function inQuietHours(ms, s) {
  if (!s.quiet || s.quietStart === s.quietEnd) return false;
  const h = localHour(ms, s.tz);
  return s.quietStart < s.quietEnd ? h >= s.quietStart && h < s.quietEnd : h >= s.quietStart || h < s.quietEnd;
}

/** A picture made for this frame's screen size (older pictures were all 7.3"). */
export const fitsPanel = (pic, settings) => (pic.panel || "7.3") === (settings?.panel || DEFAULT_SETTINGS.panel);

/**
 * The pictures the frame cycles through: the chosen folder, or everything, for its screen size.
 * Pictures set for a day stay out: they only show on their day (see choosePicture).
 */
export function pool(state, settings) {
  const album = settings?.album;
  const sized = state.pictures.filter((p) => fitsPanel(p, settings) && !p.day);
  if (!album || !state.albums.some((a) => a.id === album)) return sized;
  return sized.filter((p) => p.album === album);
}

/**
 * Decide what the frame should show at `now` (ms):
 *   1. a picture asked for with "show next"
 *   2. pictures set for today (in the frame's time zone), taking turns if there are several
 *   3. new pictures in the cycling folder, oldest first, so a burst of uploads each get a turn
 *   4. the next picture in the folder when the rotation is due (in order or shuffled)
 * Returns { state, changed }.
 */
export function choosePicture(inState, settings, now, rng = Math.random) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  let state = normalizeState(inState);
  let changed = false;
  const show = (id, onDemand = false) => ({
    state: {
      ...state, current: id, since: new Date(now).toISOString(), onDemand,
      seen: [...new Set([...state.seen, id])], bag: state.bag.filter((b) => b !== id),
    },
    changed: true,
  });

  if (state.showNext) {
    const wanted = state.pictures.find((p) => p.id === state.showNext);
    state = { ...state, showNext: null };
    changed = true;
    if (wanted) return show(wanted.id, true);
  }

  if (!state.pictures.length) {
    return { state: { ...state, current: null, since: null, onDemand: false }, changed: changed || state.current !== null };
  }
  const elapsed = now - Date.parse(state.since || 0);
  const due = s.rotateHours > 0 && elapsed >= s.rotateHours * 3600e3 * 0.95; // 5% early: the sleep timer drifts

  // A picture "show next" put up today stays until its turn ends, even on a picture's day
  const today = localDate(now, s.tz);
  const todays = state.pictures.filter((p) => fitsPanel(p, s) && isPictureDay(p.day, today));
  if (todays.length && !(state.onDemand && !due && state.pictures.some((p) => p.id === state.current))) {
    const i = todays.findIndex((p) => p.id === state.current);
    if (i === -1) return show(todays[0].id);
    if (due && todays.length > 1) return show(todays[(i + 1) % todays.length].id);
    return { state, changed };
  }

  const pics = pool(state, s);
  if (!pics.length) return { state, changed }; // empty folder: keep what's up
  const unseen = pics.find((p) => !state.seen.includes(p.id));
  const idx = pics.findIndex((p) => p.id === state.current);

  if (idx === -1) {
    // Something outside the folder is up. A "show next" pick stays until the rotation is due;
    // otherwise (deleted, folder switched, first run) move into the folder now.
    // A picture whose day is over leaves straight away.
    const up = state.pictures.find((p) => p.id === state.current);
    if (up && !up.day && state.onDemand && !due && !unseen) return { state, changed };
    return show((unseen || pickNext(pics, -1)).id);
  }
  if (unseen) return show(unseen.id);
  if (due && pics.length > 1) return show(pickNext(pics, idx).id);
  return { state, changed };

  function pickNext(list, i) {
    if (s.order !== "shuffle") return list[(i + 1) % list.length];
    // Shuffle without repeats: draw from a bag until it's empty, then refill.
    const ids = new Set(list.map((p) => p.id));
    let bag = state.bag.filter((b) => ids.has(b) && b !== state.current);
    if (!bag.length) {
      bag = list.map((p) => p.id).filter((b) => b !== state.current || list.length === 1);
      for (let k = bag.length - 1; k > 0; k--) {
        const j = Math.floor(rng() * (k + 1));
        [bag[k], bag[j]] = [bag[j], bag[k]];
      }
    }
    state = { ...state, bag };
    return list.find((p) => p.id === bag[0]);
  }
}

/** A low battery wins over the schedule: fewer check-ins, slower rotation. */
const lowBatteryMinutes = (batteryMv) => (batteryMv && batteryMv < LOW_BATTERY_MV ? 240 : 0);

/**
 * The frame's usual check-in interval: what it waits after a check-in that doesn't get through
 * (doubling for each one in a row). Unlike nextWakeMinutes, never stretched to skip quiet hours
 * or shortened for the next scheduled change, which only hold for the next wake.
 */
export function retryMinutes(settings, batteryMv) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  return Math.max(s.checkMinutes, lowBatteryMinutes(batteryMv));
}

/** Minutes the frame should sleep after a check-in at `now`. */
export function nextWakeMinutes(inState, settings, now, batteryMv) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const state = normalizeState(inState);
  let minutes = s.checkMinutes;

  // Wake in time for the next scheduled change.
  if (state.since && s.rotateHours > 0 && pool(state, s).length > 1) {
    const until = s.rotateHours * 60 - (now - Date.parse(state.since)) / 60e3;
    minutes = Math.min(minutes, Math.max(5, Math.ceil(until)));
  }

  minutes = Math.max(minutes, lowBatteryMinutes(batteryMv));

  // Skip quiet hours: step forward until the wake time is outside them.
  let wake = now + minutes * 60e3;
  for (let i = 0; i < 96 && inQuietHours(wake, s); i++) wake += 15 * 60e3;
  return Math.max(5, Math.min(7 * 24 * 60, Math.round((wake - now) / 60e3)));
}

// ---- Editing the picture list ------------------------------------------------

/**
 * Add a picture. Beyond MAX_PICTURES the oldest (never the current one) moves to the trash.
 * Returns { state, removed }: ids whose files can go (pushed out of a full trash).
 */
export function addPicture(inState, pic, now = Date.now()) {
  const state = normalizeState(inState);
  const pictures = [...state.pictures, pic];
  const over = [];
  for (const p of pictures) {
    if (pictures.length - over.length <= MAX_PICTURES) break;
    if (p.id !== state.current) over.push(p.id);
  }
  return removePictures({ ...state, pictures }, over, now);
}

/**
 * Move pictures to the trash, where they can be restored for TRASH_DAYS.
 * Returns { state, removed }: ids whose files can be deleted now (pushed out of a full trash).
 */
export function removePictures(inState, ids, now = Date.now()) {
  const state = normalizeState(inState);
  const gone = new Set(ids);
  const removedAt = new Date(now).toISOString();
  const binned = state.pictures.filter((p) => gone.has(p.id)).map((p) => ({ ...p, removedAt }));
  const trash = [...state.trash, ...binned];
  const overflow = trash.splice(0, Math.max(0, trash.length - MAX_TRASH)).map((p) => p.id);
  return { state: forget({ ...state, trash }, ids, state.pictures.filter((p) => !gone.has(p.id))), removed: overflow };
}

export const removePicture = (state, id) => removePictures(state, [id]).state;

/** Put pictures from the trash back, in their old folder if it still exists. Null if there's no room. */
export function restorePictures(inState, ids) {
  const state = normalizeState(inState);
  const back = new Set(ids);
  const restored = state.trash.filter((p) => back.has(p.id))
    .map(({ removedAt, ...p }) => ({ ...p, album: state.albums.some((a) => a.id === p.album) ? p.album : null }));
  if (!restored.length || state.pictures.length + restored.length > MAX_PICTURES) return null;
  // Back in upload order, and counted as seen, so they don't all jump the queue
  const pictures = [...state.pictures, ...restored].sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt) || a.id.localeCompare(b.id));
  return {
    ...state, pictures, trash: state.trash.filter((p) => !back.has(p.id)),
    seen: [...new Set([...state.seen, ...restored.map((p) => p.id)])],
  };
}

/** Delete pictures in the trash for good: the ones in `ids`, or those older than TRASH_DAYS. Returns { state, removed }. */
export function emptyTrash(inState, ids, now = Date.now()) {
  const state = normalizeState(inState);
  const cutoff = now - TRASH_DAYS * 864e5;
  const go = ids ? new Set(ids) : null;
  const removed = state.trash.filter((p) => (go ? go.has(p.id) : Date.parse(p.removedAt) < cutoff)).map((p) => p.id);
  if (!removed.length) return { state, removed };
  return { state: { ...state, trash: state.trash.filter((p) => !removed.includes(p.id)) }, removed };
}

/** Set or clear the day pictures show on ("MM-DD", "YYYY-MM-DD" or null). */
export function setPictureDay(inState, ids, day) {
  const state = normalizeState(inState);
  const set = new Set(ids);
  return { ...state, pictures: state.pictures.map((p) => (set.has(p.id) ? { ...p, day: day || undefined } : p)) };
}

function forget(state, ids, pictures) {
  const gone = new Set(ids);
  return {
    ...state,
    pictures,
    seen: state.seen.filter((id) => !gone.has(id)),
    bag: state.bag.filter((id) => !gone.has(id)),
    showNext: gone.has(state.showNext) ? null : state.showNext,
  };
}

/** Swap in an edited version of a picture, keeping its place, folder and whether it's been seen. */
export function replacePicture(inState, oldId, pic) {
  const state = normalizeState(inState);
  const i = state.pictures.findIndex((p) => p.id === oldId);
  if (i === -1) return null;
  const old = state.pictures[i];
  const pictures = [...state.pictures];
  pictures[i] = { ...pic, album: old.album, from: old.from, day: old.day, uploadedAt: old.uploadedAt, editedAt: pic.uploadedAt };
  const swap = (id) => (id === oldId ? pic.id : id);
  return {
    ...state,
    pictures,
    current: swap(state.current), // the frame sees a new ETag and redraws
    seen: state.seen.map(swap),
    bag: state.bag.map(swap),
    showNext: state.showNext && swap(state.showNext),
  };
}

export function movePictures(inState, ids, album) {
  const state = normalizeState(inState);
  const move = new Set(ids);
  return { ...state, pictures: state.pictures.map((p) => (move.has(p.id) ? { ...p, album } : p)) };
}

export function addAlbum(inState, album) {
  const state = normalizeState(inState);
  return { ...state, albums: [...state.albums, album] };
}

export function renameAlbum(inState, albumId, name) {
  const state = normalizeState(inState);
  return { ...state, albums: state.albums.map((a) => (a.id === albumId ? { ...a, name } : a)) };
}

/** Delete a folder. Its pictures go to the trash too, or are kept (unfiled). Returns { state, removed }. */
export function deleteAlbum(inState, albumId, deletePictures, now = Date.now()) {
  let state = normalizeState(inState);
  const inside = state.pictures.filter((p) => p.album === albumId).map((p) => p.id);
  state = { ...state, albums: state.albums.filter((a) => a.id !== albumId) };
  if (deletePictures) return removePictures(state, inside, now);
  return { state: movePictures(state, inside, null), removed: [] };
}
