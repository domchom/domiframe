// Which picture a frame shows, and when it should wake next. Pure functions, no storage.
//
// Frame state:
//   pictures   [{id, uploadedAt, from, etag, album, hasOriginal, edits}], oldest first
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

export const DEFAULT_SETTINGS = {
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
  pictures: [], albums: [], current: null, since: null, seen: [], showNext: null, onDemand: false, bag: [],
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

export function localHour(ms, tz) {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(ms);
  return Number(h) % 24;
}

export function inQuietHours(ms, s) {
  if (!s.quiet || s.quietStart === s.quietEnd) return false;
  const h = localHour(ms, s.tz);
  return s.quietStart < s.quietEnd ? h >= s.quietStart && h < s.quietEnd : h >= s.quietStart || h < s.quietEnd;
}

/** The pictures the frame cycles through: the chosen folder, or everything. */
export function pool(state, settings) {
  const album = settings?.album;
  if (!album || !state.albums.some((a) => a.id === album)) return state.pictures;
  return state.pictures.filter((p) => p.album === album);
}

/**
 * Decide what the frame should show at `now` (ms):
 *   1. a picture asked for with "show next"
 *   2. new pictures in the cycling folder, oldest first, so a burst of uploads each get a turn
 *   3. the next picture in the folder when the rotation is due (in order or shuffled)
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
  const pics = pool(state, s);
  if (!pics.length) return { state, changed }; // empty folder: keep what's up

  const elapsed = now - Date.parse(state.since || 0);
  const due = s.rotateHours > 0 && elapsed >= s.rotateHours * 3600e3 * 0.95; // 5% early: the sleep timer drifts
  const unseen = pics.find((p) => !state.seen.includes(p.id));
  const idx = pics.findIndex((p) => p.id === state.current);

  if (idx === -1) {
    // Something outside the folder is up. A "show next" pick stays until the rotation is due;
    // otherwise (deleted, folder switched, first run) move into the folder now.
    const onFrame = state.pictures.some((p) => p.id === state.current);
    if (onFrame && state.onDemand && !due && !unseen) return { state, changed };
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

  // A low battery wins over the schedule: fewer check-ins, slower rotation.
  if (batteryMv && batteryMv < LOW_BATTERY_MV) minutes = Math.max(minutes, 240);

  // Skip quiet hours: step forward until the wake time is outside them.
  let wake = now + minutes * 60e3;
  for (let i = 0; i < 96 && inQuietHours(wake, s); i++) wake += 15 * 60e3;
  return Math.max(5, Math.min(7 * 24 * 60, Math.round((wake - now) / 60e3)));
}

// ---- Editing the picture list ------------------------------------------------

/** Add a picture, dropping the oldest (never the current one) beyond MAX_PICTURES. Returns removed ids. */
export function addPicture(inState, pic) {
  const state = normalizeState(inState);
  const pictures = [...state.pictures, pic];
  const removed = [];
  while (pictures.length > MAX_PICTURES) {
    const i = pictures.findIndex((p) => p.id !== state.current);
    removed.push(pictures.splice(i, 1)[0].id);
  }
  return { state: forget(state, removed, pictures), removed };
}

export function removePictures(inState, ids) {
  const state = normalizeState(inState);
  const gone = new Set(ids);
  return forget(state, ids, state.pictures.filter((p) => !gone.has(p.id)));
}
export const removePicture = (state, id) => removePictures(state, [id]);

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
  pictures[i] = { ...pic, album: old.album, from: old.from, uploadedAt: old.uploadedAt, editedAt: pic.uploadedAt };
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

/** Delete a folder. Its pictures are deleted too, or kept (unfiled). Returns { state, removed }. */
export function deleteAlbum(inState, albumId, deletePictures) {
  let state = normalizeState(inState);
  const inside = state.pictures.filter((p) => p.album === albumId).map((p) => p.id);
  state = { ...state, albums: state.albums.filter((a) => a.id !== albumId) };
  if (deletePictures) return { state: removePictures(state, inside), removed: inside };
  return { state: movePictures(state, inside, null), removed: [] };
}
