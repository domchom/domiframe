import { sizeFor, toPanelOrder, panelOf, DEFAULTS, ditherWithPreview, pack, indicesToRGBA, PALETTE } from "./dither.js";
import { ask, tell } from "./dialog.js";
import { ago, until, batteryPct, LOW_BATTERY_PCT, rotateLabel, checkLabel, hourLabel } from "./format.js";
import { rememberFrame, rememberedFrames, isFrameCode, normalizeCode, frameLink, saveCode, oldCode } from "./code.js";
import { frameKeys, seal, unseal, sealText, unsealText } from "./seal.js";
import { dateTaken } from "./exif.js";

const $ = (id) => document.getElementById(id);
const frameId = (location.pathname.match(/^\/f\/([a-z0-9-]+)/) || [])[1];
const storageKey = `domiframe:${frameId}`;

// Links carry the frame code in #k= (a fragment, so it's never sent to the server). The code
// stays in this browser: it's turned into an access token for the API and a key that seals
// everything uploaded (web/seal.js), so the server only ever sees ciphertext.
const hashParams = new URLSearchParams(location.hash.slice(1));
let uploadKey = hashParams.get("k");
try {
  if (uploadKey) {
    saveCode(frameId, (uploadKey = normalizeCode(uploadKey)));
    history.replaceState(null, "", location.pathname); // saved: keep the code out of the address bar
  } else uploadKey = localStorage.getItem(storageKey);
} catch { /* storage unavailable */ }

let auth = {};
let contentKey = null; // CryptoKey for sealing and opening this frame's pictures and names
let source = null; // ImageBitmap or canvas (after rotating)
let packed = null;
let dithered = null; // last dithered ImageData: what's sent (the preview and thumbnail files)
let shown = null; // what the editor shows: the adjusted photo, not dithered; restored after "compare"
let pan = { x: 0, y: 0 }; // offset in preview pixels (the current photo's)
let dragging = false, comparing = false;

const PRESETS = {
  default: { ...DEFAULTS, brightness: 1.05 },
  natural: { ...DEFAULTS, saturation: 1.1, contrast: 1.0, sharpen: 0.3 },
  vivid: { ...DEFAULTS, saturation: 1.6, contrast: 1.2, brightness: 1.05, sharpen: 0.4 },
  soft: { ...DEFAULTS, saturation: 1.05, contrast: 0.9, brightness: 1.08, shadows: 0.3, strength: 0.85 },
  mono: { ...DEFAULTS, saturation: 0, contrast: 1.2, brightness: 1.05, sharpen: 0.5 },
};
const SLIDERS = ["brightness", "contrast", "shadows", "saturation", "temperature", "tint", "sharpen", "strength"];

function msg(text, kind = "") {
  $("msg").textContent = text;
  $("msg").className = `msg ${kind}`;
}

const api = (path, init = {}) =>
  fetch(`/api/frames/${frameId}/${path}`, { ...init, headers: { ...auth, ...init.headers } });

/**
 * No frame code, or it doesn't open this frame (wrong code, a link from before frames made their
 * own codes, or the frame has made a new code since). Nothing can be sent, so both pickers go.
 * The code stays saved: if the frame made a new one by mistake, typing this one back into the
 * frame brings its pictures back. Not on a server hiccup (stale = false): the code may be fine.
 */
function cantOpen(stale = true) {
  $("frame-status").textContent = stale
    ? "This frame's code is missing or no longer works."
    : "Couldn't reach the frame. Try again in a moment.";
  $("file").disabled = $("folder").disabled = true;
  for (const p of document.querySelectorAll(".picker")) p.classList.add("off");
  if (!stale || !frameId) return;
  $("code-gone").hidden = false;
  $("gone-code-line").hidden = !isFrameCode(uploadKey);
  $("gone-code").textContent = uploadKey || "";
}

// A new code for this frame, typed in where the old one stopped working
$("code-gone").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = normalizeCode($("new-code").value);
  if (!isFrameCode(code)) {
    $("gone-msg").textContent = "A frame code is 16 letters and numbers, like K7PX-92QD-M4TR-8WZN.";
    return;
  }
  saveCode(frameId, code); // the code that stopped working is kept as the old one
  location.reload();
});

async function loadInfo() {
  if (frameId && isFrameCode(uploadKey) && !contentKey) {
    const keys = await frameKeys(frameId, uploadKey);
    auth = { Authorization: `Bearer ${keys.auth}` };
    contentKey = keys.key;
  }
  if (!frameId || !contentKey) return cantOpen();
  const res = await api("info");
  if (!res.ok) return cantOpen(res.status === 404);
  const info = await openInfo(await res.json());
  rememberFrame(frameId, info.name);
  showSwitcher(info.name);
  // Friends with the frame code can open this frame anywhere from the home page
  $("device-access").hidden = false;
  $("invite").hidden = false;
  $("access-id").textContent = frameId;
  $("access-code").textContent = uploadKey;
  const old = oldCode(frameId);
  $("old-code").hidden = !old;
  if (old) {
    $("old-code-value").textContent = old.code;
    $("old-code-until").textContent = old.until.toLocaleDateString(undefined, { day: "numeric", month: "long" });
  }
  $("frame-name").textContent = info.name || "Your frame";
  document.title = `${info.name || "Frame"} · DomiFrame`;

  const pct = batteryPct(info.batteryMv);
  const low = pct != null && pct < LOW_BATTERY_PCT;
  $("st-seen").textContent = info.lastSeen ? ago(info.lastSeen) : "never";
  $("st-next").textContent = info.lastSeen ? until(info.nextCheckIn) || "–" : "–";
  $("st-battery").textContent = pct != null ? `${pct}%` : "–";
  $("st-gauge").style.setProperty("--pct", Math.ceil((pct ?? 0) / 10) * 10); // whole segments
  $("st-gauge").classList.toggle("low", low);
  $("frame-status").textContent = !info.lastSeen ? "The frame hasn't checked in yet."
    : low ? "Battery low: time to charge it." : "";
  $("frame-status").classList.toggle("warn", low);

  const hangChanged = frameInfo && frameInfo.settings.orientation !== info.settings.orientation;
  frameInfo = info;
  showHang(info);
  showQueue(info);
  showSettings(info.settings);
  if (hangChanged && source) scheduleRender(); // pictures are made for the new orientation
  if (photos.length > 1) showBatchNote();
}

// ---- Inviting someone: the frame's link as a QR code ------------------------------

$("invite").addEventListener("click", async () => {
  const link = location.origin + frameLink(frameId, uploadKey);
  const box = document.createElement("div");
  box.className = "invite-box";
  if (window.qrcode) {
    const qr = window.qrcode(0, "M");
    qr.addData(link);
    qr.make();
    // Black on white with a 4-module margin, the way scanners like it
    const n = qr.getModuleCount(), m = 6, side = (n + 8) * m;
    const c = Object.assign(document.createElement("canvas"), { width: side, height: side, className: "qr" });
    c.setAttribute("role", "img");
    c.setAttribute("aria-label", "QR code with this frame's link");
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, side, side);
    ctx.fillStyle = "#000";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) ctx.fillRect((x + 4) * m, (y + 4) * m, m, m);
    box.append(c);
  }
  const buttons = document.createElement("div");
  buttons.className = "chips";
  const copy = Object.assign(document.createElement("button"), { type: "button", className: "chip", textContent: "Copy link" });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(link);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Couldn't copy";
    }
  });
  buttons.append(copy);
  if (navigator.share) {
    const share = Object.assign(document.createElement("button"), { type: "button", className: "chip", textContent: "Share…" });
    share.addEventListener("click", () => navigator.share({ title: frameInfo?.name || "DomiFrame", text: "Send pictures to our frame:", url: link }).catch(() => {}));
    buttons.append(share);
  }
  box.append(buttons);
  await ask({
    title: `Invite someone to ${frameInfo?.name || "this frame"}`,
    message: "They scan this with their phone's camera, or open the link, and can send pictures right away. " +
      "It also lets them remove pictures, so share it like a house key.",
    body: box, ok: "Done", cancel: null,
  });
});

// ---- Switching frames: for someone with more than one frame on this device -----------

const OTHER_FRAME = "";
function showSwitcher(name) {
  const saved = rememberedFrames();
  const others = saved.filter((f) => f.id !== frameId);
  name ||= frameInfo?.name || saved.find((f) => f.id === frameId)?.name || frameId;
  // This frame stays in the list even when its code just failed, so the menu still says where you are
  const frames = [{ id: frameId, name }, ...others]
    .sort((a, b) => a.name.localeCompare(b.name));
  $("switch-frame").closest("label").hidden = !others.length;
  $("switch-frame").replaceChildren(
    ...frames.map((f) => new Option(f.name, f.id, false, f.id === frameId)),
    new Option("Open another frame…", OTHER_FRAME),
  );
}
$("switch-frame").addEventListener("change", async (e) => {
  const id = e.target.value;
  if (photos.length && !(await ask({
    title: "Leave the photos you're editing?",
    message: `${plural(photos.length, "photo")} in the editor haven't been sent and will be cleared.`,
    ok: "Switch frame",
  }))) {
    e.target.value = frameId;
    return;
  }
  // Each frame's code is already saved on this device, so the link doesn't need it
  location.href = id === OTHER_FRAME ? "/#frame" : `/f/${id}`;
});

/** Open the sealed parts of the frame's info: sender names, folder names, edit settings. */
async function openInfo(info) {
  info.trash ??= []; // a server from before the trash
  const opened = new Map(); // the same names repeat a lot
  const text = (s) => {
    if (!s) return null;
    if (!opened.has(s)) opened.set(s, unsealText(contentKey, s));
    return opened.get(s);
  };
  await Promise.all([
    ...info.albums.map(async (a) => (a.name = (await text(a.name)) ?? "(unreadable)")),
    ...[...info.pictures, ...info.trash].map(async (p) => {
      p.from = await text(p.from);
      const edits = await text(p.edits);
      try { p.edits = edits ? JSON.parse(edits) : null; } catch { p.edits = null; }
    }),
  ]);
  return info;
}

/** A sealed file from the API, opened. Null if it's missing or can't be opened. */
async function openFile(path, type) {
  const r = await api(path);
  if (!r.ok) return null;
  try {
    return new Blob([await unseal(contentKey, await r.arrayBuffer())], { type });
  } catch {
    return null;
  }
}

// Blob URLs for pictures, kept across refreshes (ids never change, and the browser caches the
// files too). The grid uses small thumbnails; the picture on the frame, the full preview.
const thumbs = new Map();
function thumb(picId, full = false) {
  const path = full ? `pictures/${picId}` : `pictures/${picId}/thumb`;
  if (!thumbs.has(path)) {
    // A thumbnail is a JPEG, or the PNG preview for older pictures: the browser can tell
    thumbs.set(path, openFile(path, full ? "image/png" : "").then((b) => (b ? URL.createObjectURL(b) : "")));
  }
  return thumbs.get(path);
}

// Up to 200 pictures: fetch previews only as they scroll into view.
const lazyThumbs = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    lazyThumbs.unobserve(e.target);
    thumb(e.target.dataset.pic).then((src) => (e.target.src = src));
  }
}, { rootMargin: "200px" });

// ---- How the frame hangs ------------------------------------------------------------

/** The orientation a picture was made for (older pictures without a note: landscape). */
const madeFor = (p) => p.edits?.orientation || p.edits?.orient || "landscape";
const framePanel = () => frameInfo?.settings?.panel || "7.3";

function showHang(info) {
  const hang = info.settings.orientation || "landscape";
  $("hang").hidden = false;
  for (const r of document.querySelectorAll("input[name=hang]")) r.checked = r.value === hang;
  // Pictures made for the other orientation would show sideways
  const panel = info.settings.panel || "7.3";
  $("hang-label").textContent = `${panelOf(panel).name} screen, hangs`;
  const off = info.pictures.filter((p) => madeFor(p) !== hang || (p.panel || "7.3") !== panel);
  const fixable = off.filter((p) => p.hasOriginal);
  $("hang-mismatch").hidden = !off.length;
  $("hang-mismatch-text").textContent =
    `${plural(off.length, "picture")} ${off.length === 1 ? "was" : "were"} made for a different screen size or orientation (this frame is a ${panelOf(panel).name} screen hung ${hang}), so ${off.length === 1 ? "it" : "they"} won't show correctly.` +
    (fixable.length < off.length ? ` ${fixable.length ? `${fixable.length} can be rebuilt; the others` : "They"} were uploaded before editing was possible, so upload those photos again.` : "");
  $("hang-rebuild").hidden = !fixable.length;
  $("hang-rebuild").textContent = fixable.length === off.length ? "Rebuild them" : `Rebuild ${fixable.length}`;
}

for (const r of document.querySelectorAll("input[name=hang]")) {
  r.addEventListener("change", () =>
    act(api("settings", jsonReq("PUT", { orientation: r.value })), `Saved. New pictures are made ${r.value}; the frame picks this up at its next check-in.`));
}
$("hang-rebuild").addEventListener("click", () => {
  const hang = frameInfo.settings.orientation || "landscape";
  editUploaded(frameInfo.pictures.filter((p) => madeFor(p) !== hang && p.hasOriginal).map((p) => p.id));
});

// ---- Library: folders, selection, bulk actions --------------------------------

const lib = { view: "all", selected: new Set() }; // view: "all" | "unfiled" | "trash" | folder id
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const folderName = (id) => frameInfo?.albums.find((a) => a.id === id)?.name;
const jsonReq = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function inView(p) {
  if (lib.view === "all") return true;
  if (lib.view === "unfiled") return !p.album;
  return p.album === lib.view;
}
/** The pictures in the current view: from the frame, or from the trash. */
const viewPics = () => (lib.view === "trash" ? frameInfo.trash : frameInfo.pictures.filter(inView));

const TRASH_DAYS = 30; // as in netlify/lib/schedule.mjs
const leftDays = (removedAt) => Math.max(1, Math.ceil(TRASH_DAYS - (Date.now() - Date.parse(removedAt)) / 864e5));

/** "12 Mar every year" or "12 Mar 2026", for a picture's day ("MM-DD" or "YYYY-MM-DD"). */
function dayLabel(day) {
  const yearly = day.length === 5;
  const [y, m, d] = (yearly ? `2024-${day}` : day).split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return yearly
    ? `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} every year`
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

async function showQueue(info) {
  const pics = info.pictures;
  const current = pics.find((p) => p.id === info.current);
  if (current) {
    $("current-img").src = await thumb(current.id, true);
    $("current-img").hidden = false;
    $("current-caption").textContent =
      `since ${ago(info.since)}` + (current.from ? `, from ${current.from}` : "") +
      (current.album ? ` · ${folderName(current.album)}` : "");
  } else {
    $("current-img").hidden = true;
    $("current-caption").textContent = pics.length ? "your picture, at the next check-in" : "nothing yet";
  }

  // Forget selections and views that no longer exist
  const listed = lib.view === "trash" ? info.trash : pics;
  for (const id of lib.selected) if (!listed.some((p) => p.id === id)) lib.selected.delete(id);
  if (!["all", "unfiled", "trash"].includes(lib.view) && !folderName(lib.view)) lib.view = "all";
  if (lib.view === "trash" && !info.trash.length) lib.view = "all";

  $("library").hidden = !pics.length && !info.albums.length && !info.trash.length;
  const cycling = info.settings.album && folderName(info.settings.album);
  $("queue-title").textContent =
    `${plural(pics.length, "picture")} · the frame shows ${cycling ? `“${cycling}”` : "all of them"}, changing ${rotateLabel(info.settings.rotateHours)}`;

  // What the frame cycles through
  const cyc = $("cycle-album");
  cyc.replaceChildren(new Option(`All pictures (${pics.length})`, ""),
    ...info.albums.map((a) => new Option(`${a.name} (${a.count})`, a.id)));
  cyc.value = info.settings.album || "";
  $("cycle-shuffle").checked = info.settings.order === "shuffle";

  // Where new uploads go: the folder the frame shows, unless the sender picked one
  const up = $("upload-album");
  const keep = up.dataset.touched ? up.value : info.settings.album || "";
  up.replaceChildren(new Option("No folder", ""), ...info.albums.map((a) => new Option(a.name, a.id)), new Option("New folder…", "new"));
  up.value = [...up.options].some((o) => o.value === keep) ? keep : "";
  $("save-to").classList.toggle("unused", !info.albums.length);

  // Folder tabs
  const unfiled = pics.filter((p) => !p.album).length;
  const tabs = [["all", `All (${pics.length})`], ...info.albums.map((a) => [a.id, `${a.name} (${a.count})`])];
  if (info.albums.length && unfiled) tabs.push(["unfiled", `Not in a folder (${unfiled})`]);
  if (info.trash.length) tabs.push(["trash", `Recently removed (${info.trash.length})`]);
  $("folders").replaceChildren(
    ...tabs.map(([id, label]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `chip${lib.view === id ? " on" : ""}`;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", lib.view === id);
      b.textContent = label;
      b.addEventListener("click", () => { lib.view = id; lib.selected.clear(); showQueue(frameInfo); });
      return b;
    }),
    Object.assign(document.createElement("button"), { type: "button", className: "chip", textContent: "+ New folder", onclick: newFolder }),
  );
  $("folder-actions").hidden = ["all", "unfiled", "trash"].includes(lib.view);
  $("library").classList.toggle("in-trash", lib.view === "trash");

  // Pictures in this view, newest first (the trash: most recently removed first)
  const shown = viewPics().slice().reverse();
  $("queue-empty").hidden = shown.length > 0;
  const list = $("queue");
  list.replaceChildren();
  for (const p of shown) {
    const li = document.createElement("li");
    li.classList.toggle("selected", lib.selected.has(p.id));
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "pick";
    pick.setAttribute("aria-pressed", lib.selected.has(p.id));
    const img = document.createElement("img");
    img.alt = p.from ? `Picture from ${p.from}` : "Picture";
    img.dataset.pic = p.id;
    lazyThumbs.observe(img);
    pick.append(img);
    pick.addEventListener("click", () => {
      lib.selected.has(p.id) ? lib.selected.delete(p.id) : lib.selected.add(p.id);
      li.classList.toggle("selected", lib.selected.has(p.id));
      pick.setAttribute("aria-pressed", lib.selected.has(p.id));
      showBulkbar();
    });
    const cap = document.createElement("span");
    cap.className = "small muted";
    if (lib.view === "trash") {
      const left = leftDays(p.removedAt);
      cap.textContent = [`Removed ${ago(p.removedAt)}`, `deleted for good in ${plural(left, "day")}`, p.from && `from ${p.from}`].filter(Boolean).join(" · ");
      li.append(pick, cap);
      list.append(li);
      continue;
    }
    const inPool = (!info.settings.album || p.album === info.settings.album) && !p.day;
    const badge = p.id === info.current ? "On the frame"
      : p.id === info.showNext ? "Showing next"
      : !p.seen && inPool ? "Up next" : "";
    cap.textContent = [
      badge, p.day && `Shows ${dayLabel(p.day)}`, p.from && `from ${p.from}`, lib.view === "all" && p.album && folderName(p.album), ago(p.uploadedAt),
    ].filter(Boolean).join(" · ");
    if (badge) li.classList.add("badged");
    li.append(pick, cap);
    list.append(li);
  }
  showBulkbar();
}

function showBulkbar() {
  const n = lib.selected.size;
  const trash = lib.view === "trash";
  const viewCount = viewPics().length;
  const chosen = frameInfo.pictures.filter((p) => lib.selected.has(p.id));
  $("sel-count").textContent = n ? `${n} selected`
    : trash ? `Removed pictures are deleted for good after ${TRASH_DAYS} days.`
    : viewCount ? "Tap pictures to select them." : "";
  $("sel-all").hidden = !viewCount || n === viewCount;
  $("sel-none").hidden = !n;
  $("sel-show").hidden = trash || n !== 1;
  $("sel-edit").hidden = trash || !n;
  $("sel-day").hidden = trash || !n;
  $("sel-anyday").hidden = trash || !chosen.some((p) => p.day);
  $("sel-remove").hidden = trash || !n;
  $("sel-restore").hidden = !trash || !n;
  $("sel-purge").hidden = !trash || !n;
  $("remove-all").hidden = !!n || !viewCount;
  $("remove-all").textContent = trash ? "Delete all for good" : lib.view === "all" ? "Remove all"
    : lib.view === "unfiled" ? "Remove all not in a folder" : `Remove all in “${folderName(lib.view)}”`;
  const move = $("sel-move");
  move.hidden = trash || !n || (!frameInfo.albums.length);
  move.replaceChildren(new Option("Move to folder…", ""),
    ...frameInfo.albums.map((a) => new Option(a.name, a.id)), new Option("No folder", "none"), new Option("New folder…", "new"));
}

async function act(res, okMsg) {
  hideUndo();
  const r = await res;
  if (!r.ok) {
    await tell("That didn't work", (await r.json().catch(() => ({}))).error || r.statusText);
    return false;
  }
  await loadInfo();
  // Next to the pictures when they're showing; otherwise at the bottom of the page
  if (okMsg) $("library").hidden ? msg(okMsg, "ok") : showUndo(okMsg);
  return true;
}

async function newFolder() {
  const name = await ask({ title: "New folder", input: { placeholder: "e.g. Summer 2026" }, ok: "Create folder" });
  if (!name) return null;
  const r = await api("albums", jsonReq("POST", { name: await sealText(contentKey, name.slice(0, 40)) }));
  if (!r.ok) {
    await tell("Couldn't create the folder", (await r.json().catch(() => ({}))).error || r.statusText);
    return null;
  }
  const { album } = await r.json();
  await loadInfo();
  return album.id;
}

$("rename-folder").addEventListener("click", async () => {
  const name = await ask({ title: "Rename folder", input: { value: folderName(lib.view) }, ok: "Rename" });
  if (name) act(api(`albums/${lib.view}`, jsonReq("PATCH", { name: await sealText(contentKey, name.slice(0, 40)) })));
});
$("delete-folder").addEventListener("click", async () => {
  const n = frameInfo.pictures.filter(inView).length;
  const name = folderName(lib.view);
  const ok = await ask({
    title: `Delete the folder “${name}”?`,
    message: n ? `Its ${plural(n, "picture")} will be kept, just not in a folder. To delete them too, use “Remove all in “${name}”” first.` : "",
    ok: "Delete folder", danger: true,
  });
  if (!ok) return;
  const id = lib.view;
  lib.view = "all";
  act(api(`albums/${id}?pictures=keep`, { method: "DELETE" }));
});

$("cycle-album").addEventListener("change", () =>
  act(api("settings", jsonReq("PUT", { album: $("cycle-album").value || null })), "Saved. The frame switches at its next check-in."));
$("cycle-shuffle").addEventListener("change", () =>
  act(api("settings", jsonReq("PUT", { order: $("cycle-shuffle").checked ? "shuffle" : "inorder" }))));

$("sel-all").addEventListener("click", () => {
  for (const p of viewPics()) lib.selected.add(p.id);
  showQueue(frameInfo);
});
$("sel-none").addEventListener("click", () => { lib.selected.clear(); showQueue(frameInfo); });
$("sel-show").addEventListener("click", () => {
  const [id] = lib.selected;
  lib.selected.clear();
  act(api(`pictures/${id}/show`, { method: "POST" }), "The frame will show it at its next check-in. Press its button to update now.");
});
// Removing moves pictures to "Recently removed" for TRASH_DAYS, with an Undo right away.
async function removeWithUndo(body) {
  lib.selected.clear();
  const r = await api("pictures", jsonReq("DELETE", body));
  if (!(await act(Promise.resolve(r)))) return;
  const { ids = [] } = await r.json().catch(() => ({}));
  if (ids.length) showUndo(`Removed ${plural(ids.length, "picture")}.`, ids);
}

/** A note under the toolbar, with an Undo button when there's something to put back. */
let undoTimer = 0;
function showUndo(text, ids = null) {
  $("undo-text").textContent = text;
  $("undo").hidden = false;
  $("undo-btn").hidden = !ids;
  $("undo-btn").onclick = () => restore(ids);
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndo, ids ? 20e3 : 6e3);
}
async function restore(ids) {
  if (await act(api("restore", jsonReq("POST", { ids })))) showUndo(`Put back ${plural(ids.length, "picture")}.`);
}
function hideUndo() {
  clearTimeout(undoTimer);
  $("undo").hidden = true;
}

$("sel-remove").addEventListener("click", () => removeWithUndo({ ids: [...lib.selected] }));
$("remove-all").addEventListener("click", async () => {
  const n = viewPics().length;
  if (lib.view === "trash") {
    const ok = await ask({ title: `Delete ${n === 1 ? "this picture" : `all ${n} pictures`} for good?`, message: "This can't be undone.", ok: "Delete for good", danger: true });
    if (ok) act(api("trash", jsonReq("DELETE", { all: true })));
    return;
  }
  const where = lib.view === "all" ? "" : lib.view === "unfiled" ? " that aren't in a folder" : ` in “${folderName(lib.view)}”`;
  const what = n === 1 ? `the picture${where}` : `all ${n} pictures${where}`;
  const ok = await ask({ title: `Remove ${what}?`, message: `They'll be in Recently removed for ${TRASH_DAYS} days, in case you change your mind.`, ok: "Remove all", danger: true });
  if (!ok) return;
  removeWithUndo(lib.view === "all" ? { all: true } : { album: lib.view === "unfiled" ? null : lib.view });
});
$("sel-restore").addEventListener("click", () => {
  const ids = [...lib.selected];
  lib.selected.clear();
  restore(ids);
});
$("sel-purge").addEventListener("click", async () => {
  const ids = [...lib.selected];
  const ok = await ask({ title: `Delete ${plural(ids.length, "picture")} for good?`, message: "This can't be undone.", ok: "Delete for good", danger: true });
  if (!ok) return;
  lib.selected.clear();
  act(api("trash", jsonReq("DELETE", { ids })));
});

// ---- Pictures for a day: a birthday, an anniversary ---------------------------------

$("sel-day").addEventListener("click", async () => {
  const ids = [...lib.selected];
  const had = frameInfo.pictures.find((p) => lib.selected.has(p.id) && p.day)?.day;
  const box = document.createElement("div");
  box.className = "day-pick";
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  box.innerHTML = `
    <label class="slider">Day <input type="date" class="text" required></label>
    <div class="seg" role="radiogroup" aria-label="How often">
      <label><input type="radio" name="day-repeat" value="yearly" checked><span>Every year</span></label>
      <label><input type="radio" name="day-repeat" value="once"><span>Just this once</span></label>
    </div>`;
  const date = box.querySelector("input[type=date]");
  date.value = !had ? ymd : had.length === 10 ? had : `${today.getFullYear()}-${had}`;
  if (had?.length === 10) box.querySelector("input[value=once]").checked = true;
  const ok = await ask({
    title: ids.length === 1 ? "Show this picture on a day" : `Show ${ids.length} pictures on a day`,
    message: "On that day the frame shows it from its first check-in" + (ids.length > 1 ? ", taking turns if there are several" : "") +
      ". The rest of the time it stays out of the rotation.",
    body: box, ok: "Save", valid: () => !!date.value,
  });
  if (!ok) return;
  const yearly = box.querySelector("input[value=yearly]").checked;
  const day = yearly ? date.value.slice(5) : date.value;
  lib.selected.clear();
  // A day starts at midnight where the frame is: give it this browser's time zone if it has none yet
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (frameInfo.settings.tz === "UTC" && tz && tz !== "UTC") await api("settings", jsonReq("PUT", { tz }));
  act(api("pictures", jsonReq("PATCH", { ids, day })), `Saved. ${ids.length === 1 ? "It shows" : "They show"} on ${dayLabel(day)}.`);
});
$("sel-anyday").addEventListener("click", () => {
  const ids = [...lib.selected];
  lib.selected.clear();
  act(api("pictures", jsonReq("PATCH", { ids, day: null })), `Back in the rotation.`);
});
$("sel-move").addEventListener("change", async () => {
  let album = $("sel-move").value;
  if (!album) return;
  if (album === "new") album = await newFolder();
  if (!album) return showBulkbar();
  const ids = [...lib.selected];
  lib.selected.clear();
  act(api("pictures", jsonReq("PATCH", { ids, album: album === "none" ? null : album })));
});
$("sel-edit").addEventListener("click", () => editUploaded([...lib.selected]));
$("upload-album").addEventListener("change", async () => {
  const up = $("upload-album");
  up.dataset.touched = "1";
  if (up.value !== "new") return;
  const id = await newFolder(); // reloads info, which rebuilds this list
  up.value = id || "";
});

function showSettings(s) {
  $("settings-card").hidden = false;
  for (const id of ["quietStart", "quietEnd"]) {
    if (!$(id).options.length) {
      for (let h = 0; h < 24; h++) $(id).add(new Option(hourLabel(h), h));
    }
  }
  $("rotateHours").value = s.rotateHours;
  $("checkMinutes").value = s.checkMinutes;
  $("quiet").checked = s.quiet;
  $("quietStart").value = s.quietStart;
  $("quietEnd").value = s.quietEnd;
  $("quiet-hours").hidden = !s.quiet;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("tz-note").textContent = s.quiet && s.tz !== tz ? `Quiet hours use ${s.tz} time. Saving switches them to ${tz}.` : "";
  $("foot").textContent = `The frame checks for new pictures ${checkLabel(s.checkMinutes)}. Press its button to update now.`;
}
$("quiet").addEventListener("change", () => ($("quiet-hours").hidden = !$("quiet").checked));

$("save-settings").addEventListener("click", async () => {
  const body = {
    rotateHours: Number($("rotateHours").value),
    checkMinutes: Number($("checkMinutes").value),
    quiet: $("quiet").checked,
    quietStart: Number($("quietStart").value),
    quietEnd: Number($("quietEnd").value),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  $("save-settings").disabled = true;
  const res = await api("settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  $("save-settings").disabled = false;
  const out = $("settings-msg");
  if (res.ok) {
    out.textContent = "Saved. The frame picks this up at its next check-in.";
    out.className = "msg ok";
    loadInfo();
  } else {
    out.textContent = `Couldn't save: ${(await res.json().catch(() => ({}))).error || res.statusText}`;
    out.className = "msg err";
  }
});

const checked = (name) => document.querySelector(`input[name=${name}]:checked`).value;

// How the frame hangs is a frame setting: every picture is made for that orientation.
const framePortrait = () => frameInfo?.settings?.orientation === "portrait";

function opts() {
  const o = {
    portrait: framePortrait(),
    fit: checked("fit"),
    bg: checked("bg"),
    zoom: parseFloat($("zoom").value),
    dither: $("dither").value,
  };
  for (const k of SLIDERS) o[k] = parseFloat($(k).value);
  return o;
}

function applyPreset(p) {
  for (const k of SLIDERS) $(k).value = p[k];
  $("dither").value = p.dither;
  showValues();
}

function showValues() {
  const fmt = {
    brightness: (v) => `${Math.round(v * 100)}%`,
    contrast: (v) => `${Math.round(v * 100)}%`,
    saturation: (v) => `${Math.round(v * 100)}%`,
    strength: (v) => `${Math.round(v * 100)}%`,
    sharpen: (v) => (v ? v.toFixed(2) : "off"),
    zoom: (v) => `${v.toFixed(2)}×`,
    shadows: (v) => signed(v, "darker", "lighter"),
    temperature: (v) => signed(v, "cooler", "warmer"),
    tint: (v) => signed(v, "greener", "pinker"),
  };
  for (const out of document.querySelectorAll("#editor output")) {
    const k = out.htmlFor.value;
    out.textContent = fmt[k](parseFloat($(k).value));
  }
  // The background only shows when the photo doesn't cover the whole frame
  const fit = checked("fit");
  const covers = fit === "cover" || (fit === "auto" && !!source && effectiveFit({ fit, portrait: framePortrait() }) === "cover");
  $("bg-seg").hidden = covers && parseFloat($("zoom").value) >= 1;
  const hang = framePortrait() ? "portrait" : "landscape";
  $("orient-note").textContent = `This frame hangs ${hang}, so every picture is made ${hang}. ` +
    `Auto fills it with photos of the same shape and fits others in whole. Change how it hangs at the top of the page.`;
}
const signed = (v, neg, pos) => (Math.abs(v) < 0.01 ? "neutral" : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? neg : pos}`);

/**
 * The fit actually used. "auto" fills the frame when the photo has the frame's shape, and fits
 * the whole photo in (over a blurred copy of itself) when it doesn't, e.g. a portrait photo on a
 * landscape frame, which filling would crop to a thin strip.
 */
function effectiveFit(o) {
  if (o.fit !== "auto") return o.fit;
  const { w, h } = sizeFor(framePanel(), o.portrait);
  const ratio = source.width / source.height, target = w / h;
  return Math.abs(Math.log(ratio / target)) < 0.35 ? "cover" : "contain";
}

/** Draw the photo onto a w×h canvas, positioned by fit, zoom and pan. */
function compose(o, w, h) {
  const work = document.createElement("canvas");
  work.width = w;
  work.height = h;
  const ctx = work.getContext("2d", { willReadFrequently: true });
  const fit = effectiveFit(o);
  if (o.bg === "blur") {
    // Blur by shrinking to a few pixels and stretching back; fast and works in every browser
    const tiny = document.createElement("canvas");
    tiny.width = 24;
    tiny.height = Math.max(1, Math.round((24 * h) / w));
    const k = Math.max(tiny.width / source.width, tiny.height / source.height);
    tiny.getContext("2d").drawImage(source, (tiny.width - source.width * k) / 2, (tiny.height - source.height * k) / 2, source.width * k, source.height * k);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(tiny, 0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,.18)"; // a little darker, so the photo stands out
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.fillStyle = o.bg;
    ctx.fillRect(0, 0, w, h);
  }
  const scale = (fit === "cover" ? Math.max : Math.min)(w / source.width, h / source.height) * o.zoom;
  const dw = source.width * scale, dh = source.height * scale;
  // Bigger than the frame: keep it covering the frame. Smaller (zoomed out): keep it inside.
  const maxX = Math.abs(dw - w) / 2, maxY = Math.abs(dh - h) / 2;
  pan.x = Math.max(-maxX, Math.min(maxX, pan.x));
  pan.y = Math.max(-maxY, Math.min(maxY, pan.y));
  const canDrag = maxX || maxY;
  $("drag-hint").hidden = !canDrag;
  $("preview").classList.toggle("draggable", !!canDrag);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, (w - dw) / 2 + pan.x, (h - dh) / 2 + pan.y, dw, dh);
  return ctx.getImageData(0, 0, w, h);
}

// ---- Dithering in the background ------------------------------------------------
// Dithering takes tens of milliseconds, so it runs in a worker. While it's busy, only the latest
// request waits; anything older is dropped, so dragging a slider never builds up a backlog.

let worker = null;
try {
  worker = new Worker("/dither-worker.js", { type: "module" });
  worker.onerror = () => { worker = null; }; // fall back to the main thread
} catch { worker = null; }
let active = null, waiting = null, jobId = 0;

function submitDither(job) {
  if (waiting) waiting.resolve(false); // superseded before it started
  waiting = job;
  pumpDither();
}

function pumpDither() {
  if (active || !waiting) return;
  active = waiting;
  waiting = null;
  const { id, rgba, w, h, o } = active;
  if (worker) {
    worker.postMessage({ id, rgba, w, h, opts: o }, [rgba.buffer]);
  } else {
    setTimeout(() => finishDither(ditherWithPreview(rgba, w, h, o)), 0);
  }
}

function finishDither({ idx, shown }) {
  const job = active;
  active = null;
  if (job) {
    job.apply(idx, shown);
    job.resolve(true);
  }
  pumpDither();
}
if (worker) worker.onmessage = ({ data }) => finishDither(data);

// The positioned photo only changes with cropping settings, so light and color sliders reuse it
// instead of redrawing a big photo each time.
let composed = { key: "", img: null };

/**
 * Show the current photo. quick: the plain photo, before adjustments (while dragging or comparing).
 * Otherwise the adjusted photo with its label, not dithered (see ditherWithPreview), while the
 * dithered version to send is made alongside. Returns a promise that settles once this render's
 * result is on screen (or superseded).
 */
function render(quick = false) {
  if (!source) return Promise.resolve(false);
  const o = opts();
  const panel = framePanel();
  const { w, h } = sizeFor(panel, o.portrait);
  const pv = $("preview");
  if (pv.width !== w || pv.height !== h) {
    pv.width = w;
    pv.height = h;
  }
  const label = labelParts(photos[cur]);
  const cKey = [sourceId, w, h, o.fit, o.bg, o.zoom, Math.round(pan.x), Math.round(pan.y)].join("|");
  if (composed.key !== cKey) composed = { key: cKey, img: compose(o, w, h) };
  const img = composed.img;
  if (quick) {
    pv.getContext("2d").putImageData(img, 0, 0);
    return Promise.resolve(true);
  }
  const portrait = o.portrait;
  return new Promise((resolve) => submitDither({
    id: ++jobId, rgba: new Uint8ClampedArray(img.data), w, h, o, resolve,
    apply(idx, photo) {
      if (label.title || label.meta) {
        stampLabel(idx, w, h, label);
        // The label in whole inks over the photo, as the frame will draw it
        const marks = new Uint8Array(w * h).fill(255);
        stampLabel(marks, w, h, label);
        for (let i = 0; i < marks.length; i++) {
          if (marks[i] === 255) continue;
          const [r, g, b] = PALETTE[marks[i]].rgb;
          photo[i * 4] = r; photo[i * 4 + 1] = g; photo[i * 4 + 2] = b;
        }
      }
      dithered = new ImageData(indicesToRGBA(idx), w, h);
      shown = new ImageData(photo, w, h);
      if (pv.width === w && pv.height === h && !comparing) pv.getContext("2d").putImageData(shown, 0, 0);
      packed = pack(toPanelOrder(idx, w, h, panel));
    },
  }));
}

/** "from <name>" as set under Text, or null. */
const currentSign = () => {
  const name = $("sign-name").value.trim().slice(0, 40);
  return $("show-name").checked && name ? `from ${name}` : null;
};
/** New photos follow the Sign it controls; pictures being edited keep their own until changed. */
const signFor = (p) => (p && p.sign !== undefined ? p.sign : currentSign());

/** "12 Mar 2024" for a "YYYY-MM-DD" date. */
const dateText = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/** The text stamped on a picture: the caption, then a smaller line with the date taken and sender. */
function labelParts(p) {
  if (!p) return {};
  const date = p.showDate && p.date ? dateText(p.date) : null;
  return { title: p.caption?.trim() || null, meta: [date, signFor(p)].filter(Boolean).join(" · ") || null, corner: p.corner || "br" };
}
/** The same as one line of text, kept with the picture's edits. */
const labelFor = (p) => { const { title, meta } = labelParts(p); return [title, meta].filter(Boolean).join(" · ") || null; };

/** Up to two lines of `text` within `max` px, breaking between words (the second is squeezed if need be). */
function wrapWords(ctx, text, max) {
  const words = text.split(" ");
  let i = 1;
  while (i < words.length && ctx.measureText(words.slice(0, i + 1).join(" ")).width <= max) i++;
  return i < words.length ? [words.slice(0, i).join(" "), words.slice(i).join(" ")] : [text];
}

// The label's type: the site's condensed face for the caption, its mono for the small line.
// Loaded up front so the first picture already uses them (the system fonts stand in until then).
const LABEL_TITLE = (px) => `600 ${px}px "IBM Plex Sans Condensed", "Arial Narrow", ui-sans-serif, sans-serif`;
const LABEL_META = (px) => `500 ${px}px "IBM Plex Mono", ui-monospace, Menlo, monospace`;
Promise.all([document.fonts.load(LABEL_TITLE(20)), document.fonts.load(LABEL_META(12))])
  .then(() => source && scheduleRender()).catch(() => {});

/**
 * A gallery-style label in the bottom-right corner, drawn straight onto the inks: a white card
 * with a thin black border and a dithered shadow (like the site's cards), the caption, a short red
 * rule, and the date and sender in small spaced capitals. Whole ink dots only, no grey.
 */
function stampLabel(idx, w, h, { title, meta, corner = "br" }) {
  const BLACK = 0, WHITE = 1, RED = 3; // PALETTE order in dither.js
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const k = Math.min(w, h) / 480; // same size on a 13.3" screen
  const r = (v) => Math.max(1, Math.round(v * k));
  const padX = r(14), padY = r(11), margin = r(18), border = r(1.5), sh = r(5);
  const titleLine = r(25), metaLine = r(16), ruleGap = r(7);
  const maxText = Math.min(w - 2 * margin - sh, Math.round(w * 0.55)) - 2 * padX;

  ctx.font = LABEL_TITLE(r(21));
  const lines = title ? wrapWords(ctx, title, maxText) : [];
  const titleW = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
  const metaText = meta ? meta.toUpperCase() : "";
  const metaPx = r(lines.length ? 11.5 : 13); // a little bigger on its own
  ctx.font = LABEL_META(metaPx);
  ctx.letterSpacing = `${(1.4 * k).toFixed(1)}px`;
  const metaW = metaText ? ctx.measureText(metaText).width : 0;
  ctx.letterSpacing = "0px";

  const both = lines.length && metaText;
  const innerH = lines.length * titleLine + (both ? ruleGap * 2 + border : 0) + (metaText ? metaLine : 0);
  const bw = Math.round(Math.min(maxText, Math.max(titleW, metaW)) + 2 * padX);
  const bh = innerH + 2 * padY;
  // In the chosen corner, the shadow included
  const x = corner[1] === "l" ? margin : w - margin - sh - bw;
  const y = corner[0] === "t" ? margin : h - margin - sh - bh;

  // The card: black border, white inside, black text
  ctx.fillStyle = "#000";
  ctx.fillRect(x, y, bw, bh);
  ctx.fillStyle = "#fff";
  ctx.fillRect(x + border, y + border, bw - 2 * border, bh - 2 * border);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "middle";
  let ty = y + padY;
  ctx.font = LABEL_TITLE(r(21));
  for (const l of lines) {
    ctx.fillText(l, x + padX, ty + titleLine / 2, bw - 2 * padX);
    ty += titleLine;
  }
  const ruleY = ty + ruleGap;
  if (both) ty += ruleGap * 2 + border;
  if (metaText) {
    ctx.font = LABEL_META(metaPx);
    ctx.letterSpacing = `${(1.4 * k).toFixed(1)}px`;
    ctx.fillText(metaText, x + padX, ty + metaLine / 2, bw - 2 * padX);
  }

  // Onto the inks: anything drawn becomes black or white, no half-dots
  const px = ctx.getImageData(x, y, bw, bh).data;
  for (let j = 0; j < bh; j++) {
    for (let i = 0; i < bw; i++) {
      const o = (j * bw + i) * 4;
      if (px[o + 3] >= 128) idx[(y + j) * w + x + i] = px[o] < 128 ? BLACK : WHITE;
    }
  }
  // A short red rule between the caption and the small line
  if (both) {
    for (let j = 0; j < border + 1; j++) for (let i = 0; i < r(26); i++) idx[(ruleY + j) * w + x + padX + i] = RED;
  }
  // The shadow: a checkerboard of black dots down and to the right, like the site's cards
  for (let j = y + sh; j < y + bh + sh; j++) {
    for (let i = x + sh; i < x + bw + sh; i++) {
      if ((i >= x + bw || j >= y + bh) && (i + j) % 2 === 0) idx[j * w + i] = BLACK;
    }
  }
}

let pending = 0;
function scheduleRender() {
  syncPhoto();
  showValues();
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => render(dragging));
}

// ---- Photos being edited ------------------------------------------------------
// Framing (orientation, zoom, position, rotation) belongs to each photo. So does the look
// (sliders, dithering, fit, border), but with scope "all" a change is copied to every photo,
// setting by setting: brightening all photos doesn't undo one photo's black and white.
let photos = []; // { file, thumb, turns, zoom, pan, look, caption, date, dateFrom, showDate, corner, replaces?, sign? }
let cur = 0;
let scope = "all"; // which photos a look change affects: "all" or "this"
let busySending = false;

const isImage = (f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|avif|heic|heif|bmp)$/i.test(f.name);
const byName = (a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true });
const setRadio = (name, v) => (document.querySelector(`input[name=${name}][value="${v}"]`).checked = true);

function readLook() {
  const l = { dither: $("dither").value, fit: checked("fit"), bg: checked("bg") };
  for (const k of SLIDERS) l[k] = parseFloat($(k).value);
  return l;
}

function writeLook(l) {
  for (const k of SLIDERS) $(k).value = l[k];
  $("dither").value = l.dither;
  setRadio("fit", l.fit);
  setRadio("bg", l.bg);
}

/** A saved look from an older version: keep only settings this editor has. */
function cleanLook(saved) {
  const base = readLook();
  const out = { ...base };
  for (const k of Object.keys(base)) if (saved && saved[k] !== undefined) out[k] = saved[k];
  if (!document.querySelector(`input[name=bg][value="${out.bg}"]`)) out.bg = base.bg;
  if (!document.querySelector(`input[name=fit][value="${out.fit}"]`)) out.fit = base.fit;
  return out;
}

/** Copy the controls into the current photo. Runs on every edit. */
function syncPhoto() {
  const p = photos[cur];
  if (!p) return;
  p.zoom = parseFloat($("zoom").value);
  p.caption = $("caption").value.slice(0, 60);
  const now = readLook();
  const changed = Object.keys(now).filter((k) => now[k] !== p.look[k]);
  if (!changed.length) return;
  for (const q of scope === "all" ? photos : [p]) for (const k of changed) q.look[k] = now[k];
  summarizeLooks();
  showLookStatus();
  markStrip();
}

const lookKey = (l) => JSON.stringify(l, Object.keys(l).sort());

/**
 * The look most photos have (ties go to the earliest photo), and which photos differ from it.
 * Computed once per change rather than per photo per slider tick.
 */
let lookSummary = null;
function summarizeLooks() {
  const keys = photos.map((p) => lookKey(p.look));
  const counts = new Map();
  for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1);
  let best = 0;
  keys.forEach((k, i) => { if (counts.get(k) > counts.get(keys[best])) best = i; });
  lookSummary = { common: photos[best]?.look, differs: new Set(photos.filter((_, i) => keys[i] !== keys[best])) };
  return lookSummary;
}
const commonLook = () => summarizeLooks().common;
const looksDifferent = (p) => (lookSummary || summarizeLooks()).differs.has(p);

async function pickFiles(list) {
  if (busySending) return;
  msg("");
  const all = [...list];
  const imgs = all.filter(isImage).sort(byName);
  if (!imgs.length) {
    msg(all.length ? "No photos found there." : "", "err");
    return;
  }
  forgetPhotos();
  const look = readLook(); // start from whatever look is set now
  let showDate = false, corner = "br";
  try {
    showDate = localStorage.getItem("domiframe:show-date") === "1";
    corner = localStorage.getItem("domiframe:corner") || "br";
  } catch {}
  photos = imgs.map((file) => ({
    file, thumb: null, turns: 0, zoom: 1, pan: { x: 0, y: 0 }, look: { ...look }, caption: "", date: null, dateFrom: null, showDate, corner,
  }));
  readDates(photos);
  skippedFiles = all.length - imgs.length;
  editing = false;
  updateBatch();
  thumbnailAll();
  for (let i = 0; i < photos.length; i++) {
    if (await select(i)) {
      $("editor").hidden = false;
      return;
    }
  }
  msg("Couldn't open those photos. Try JPEG or PNG.", "err");
}

/** Each photo's date taken, from its EXIF data, read in the background. */
async function readDates(list) {
  for (const p of list) {
    const found = await dateTaken(p.file);
    if (list !== photos) return; // a new set was picked
    if (found && !p.date) Object.assign(p, { date: found, dateFrom: "photo" }); // unless one was typed meanwhile
    if (p === photos[cur]) {
      showDateNote();
      if (p.showDate && p.date) scheduleRender();
    }
  }
}

function showDateNote() {
  const p = photos[cur];
  if (!p) return;
  $("photo-date").value = p.date || "";
  $("date-field").hidden = !p.showDate;
  const n = photos.filter((q) => q.date).length;
  $("date-note").hidden = !p.showDate;
  $("date-note").textContent = p.date
    ? p.dateFrom === "photo" ? "From the photo's details. Change it if it's wrong." : ""
    : photos.length > 1 ? `No date found in this photo (${n} of ${photos.length} have one): pick one above, or it's left off.`
    : "No date found in this photo: pick one above, or it's left off. Phone photos usually have one; screenshots often don't.";
}

$("show-date").addEventListener("change", () => {
  for (const p of photos) p.showDate = $("show-date").checked; // the whole set
  if (!editing) try { localStorage.setItem("domiframe:show-date", $("show-date").checked ? "1" : "0"); } catch {}
  showDateNote();
});
// Each photo's date can be set by hand: a scan of an old print, or a wrong camera clock
$("photo-date").addEventListener("input", () => {
  const p = photos[cur];
  if (!p) return;
  Object.assign(p, { date: $("photo-date").value || null, dateFrom: "you" });
  showDateNote();
});
// The corner applies to the whole set, and is remembered for next time
for (const r of document.querySelectorAll("input[name=corner]")) {
  r.addEventListener("change", () => {
    for (const p of photos) p.corner = r.value;
    if (!editing) try { localStorage.setItem("domiframe:corner", r.value); } catch {}
  });
}

const MAX_SIDE = 2000; // plenty for 3× zoom on an 800 px panel, and what's kept as the original

/**
 * Decode a photo, capped at MAX_SIDE on the long side, as a canvas. Scaling with drawImage is
 * far faster than createImageBitmap's "high" resize, which took most of a second per photo.
 */
async function decodeFile(p) {
  const img = await createImageBitmap(p.file, { imageOrientation: "from-image" });
  const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  let c = document.createElement("canvas");
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  img.close();
  for (let t = 0; t < p.turns; t++) c = rotate90(c);
  if (!p.thumb) makeThumb(p, c);
  return c;
}

// Recently used photos stay decoded, so going back and forth is instant.
const decoded = new Map(); // photo -> { turns, canvas: Promise<canvas> }
const KEEP_DECODED = 5;
function decode(p) {
  const hit = decoded.get(p);
  if (hit && hit.turns === p.turns) {
    decoded.delete(p); // move to the end: most recently used
    decoded.set(p, hit);
    return hit.canvas;
  }
  const entry = { turns: p.turns, canvas: decodeFile(p) };
  entry.canvas.catch(() => decoded.delete(p));
  decoded.set(p, entry);
  while (decoded.size > KEEP_DECODED) {
    const [oldest] = decoded.keys();
    const entryOf = decoded.get(oldest);
    decoded.delete(oldest);
    if (oldest === photos[cur]) decoded.set(oldest, entryOf); // never drop the one on screen; move it to the end
  }
  return entry.canvas;
}

/** Decode the neighbours in the background, so Next and Prev feel instant. */
function prefetchAround(i) {
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  idle(() => {
    for (const j of [i + 1, i - 1]) if (photos[j] && !photos[j].broken) decode(photos[j]).catch(() => {});
  });
}

function rotate90(src) {
  const c = document.createElement("canvas");
  c.width = src.height;
  c.height = src.width;
  const ctx = c.getContext("2d");
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  return c;
}

/** Show photo i in the editor with its own framing and look. Resolves once it's dithered. */
let selectToken = 0;
let sourceId = 0; // changes whenever `source` does, for the render cache
async function select(i) {
  const p = photos[i];
  if (!p) return false;
  const token = ++selectToken;
  let img;
  try {
    img = await decode(p);
  } catch {
    p.broken = true;
    markStrip();
    return false;
  }
  if (token !== selectToken) return false; // a newer click won
  source = img;
  sourceId++;
  cur = i;
  $("zoom").value = p.zoom;
  pan = p.pan;
  writeLook(p.look);
  $("caption").value = p.caption || "";
  $("show-date").checked = !!p.showDate;
  setRadio("corner", p.corner || "br");
  showSign(p.sign);
  showDateNote();
  markStrip();
  showLookStatus();
  showValues();
  prefetchAround(i);
  return render();
}

// Small thumbnails for the filmstrip: full-size photos there cost a lot of memory and repaint time.
function makeThumb(p, canvas) {
  const k = 128 / Math.min(canvas.width, canvas.height);
  const t = document.createElement("canvas");
  t.width = Math.max(1, Math.round(canvas.width * k));
  t.height = Math.max(1, Math.round(canvas.height * k));
  t.getContext("2d").drawImage(canvas, 0, 0, t.width, t.height);
  t.toBlob((b) => {
    if (!b) return;
    p.thumb = URL.createObjectURL(b);
    const img = $("strip").children[photos.indexOf(p)]?.querySelector("img");
    if (img) img.src = p.thumb;
  }, "image/jpeg", 0.8);
}

/** Thumbnails for photos not opened yet, one at a time in the background. */
async function thumbnailAll() {
  const list = photos;
  for (const p of list) {
    if (list !== photos) return; // a new set was picked
    if (p.thumb || p.broken) continue;
    try {
      // Decoding straight to a small size is cheap; the browser can skip most of the pixels
      const bm = await createImageBitmap(p.file, { imageOrientation: "from-image", resizeHeight: 128, resizeQuality: "medium" });
      makeThumb(p, bm);
      bm.close();
    } catch {
      p.broken = true;
      markStrip();
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ---- Batch: filmstrip, look sharing, notes -----------------------------------

let skippedFiles = 0;
function updateBatch() {
  summarizeLooks();
  const n = photos.length;
  const batch = n > 1;
  $("editor").classList.toggle("batch", batch);
  $("editor").classList.toggle("editing", editing);
  $("batch-count").textContent = (editing ? `Editing ${plural(n, "picture")}` : plural(n, "photo")) +
    (skippedFiles ? ` (${plural(skippedFiles, "other file")} skipped)` : "");
  $("clear-photos").textContent = editing ? "Cancel" : batch ? "Clear all" : "Clear";
  $("edit-banner").hidden = !editing;
  $("edit-banner").textContent = editing
    ? "Saving replaces the pictures on the frame, keeping their place and folder. If one is on the frame now, it redraws at the next check-in."
    : "";
  $("save-to").hidden = editing;
  $("from-section").hidden = editing;
  $("send").textContent = editing ? (batch ? `Save ${n} changes` : "Save changes") : batch ? `Send ${n} photos` : "Send to frame";
  if (batch && !editing) showBatchNote();
  $("batch-note").hidden = editing;
  buildStrip();
}

/** Free thumbnails and decoded photos from the last set. */
function forgetPhotos() {
  for (const p of photos) if (p.thumb) URL.revokeObjectURL(p.thumb);
  decoded.clear();
  composed = { key: "", img: null };
}

function clearEditor() {
  forgetPhotos();
  photos = [];
  editing = false;
  skippedFiles = 0;
  source?.close?.();
  source = packed = null;
  $("editor").hidden = true;
  $("file").value = $("folder").value = "";
}
$("clear-photos").addEventListener("click", async () => {
  if (photos.length > 1 && !editing &&
    !(await ask({ title: `Clear all ${photos.length} photos?`, message: "This only empties the editor. Nothing on the frame changes.", ok: "Clear" }))) return;
  clearEditor();
});

/** Open uploaded pictures in the editor, with the settings they were made with. */
let editing = false;
async function editUploaded(ids) {
  const pics = frameInfo.pictures.filter((p) => ids.includes(p.id));
  const editable = pics.filter((p) => p.hasOriginal);
  const old = pics.length - editable.length;
  if (!editable.length) {
    await tell("Can't edit", pics.length === 1
      ? "This picture was uploaded before editing was possible, so only the frame version was kept. Upload the photo again to change it."
      : "These pictures were uploaded before editing was possible. Upload the photos again to change them.");
    return;
  }
  msg(`Opening ${plural(editable.length, "picture")}…`);
  const loaded = [];
  for (const p of editable) {
    const blob = await openFile(`pictures/${p.id}/original`, "image/jpeg");
    if (!blob) continue;
    const e = p.edits || {};
    loaded.push({
      file: new File([blob], `${p.id}.jpg`, { type: "image/jpeg" }), thumb: null,
      turns: 0, zoom: e.zoom || 1, pan: { x: e.pan?.x || 0, y: e.pan?.y || 0 },
      look: cleanLook(e.look), replaces: p.id,
      // Before captions (v2) the label was only ever "from <name>"
      sign: (e.v >= 3 ? e.sign : e.label) ?? null,
      caption: e.caption || "", date: e.date || null, dateFrom: e.date ? "saved" : null, showDate: !!e.showDate, corner: e.corner || "br",
    });
  }
  if (!loaded.length) return msg("Couldn't open those pictures.", "err");
  clearEditor();
  photos = loaded;
  editing = true;
  lib.selected.clear();
  showQueue(frameInfo);
  updateBatch();
  thumbnailAll();
  msg(old ? `${plural(old, "picture")} can't be edited (uploaded before editing was possible).` : "");
  $("editor").hidden = false;
  await select(0);
  $("editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

function buildStrip() {
  scrolledTo = -1;
  const strip = $("strip");
  strip.replaceChildren();
  photos.forEach((p, i) => {
    const item = document.createElement("div");
    item.className = "shot";
    const pick = document.createElement("button");
    pick.type = "button";
    pick.title = p.file.name;
    pick.setAttribute("aria-label", `Photo ${i + 1}: ${p.file.name}`);
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    if (p.thumb) img.src = p.thumb;
    pick.append(img);
    pick.addEventListener("click", () => !busySending && select(i));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "×";
    del.setAttribute("aria-label", `Leave out ${p.file.name}`);
    del.addEventListener("click", () => removeFromBatch(i));
    item.append(pick, del);
    strip.append(item);
  });
  markStrip();
}

let scrolledTo = -1;
function markStrip() {
  [...$("strip").children].forEach((el, i) => {
    const p = photos[i];
    el.classList.toggle("active", i === cur);
    el.classList.toggle("custom", photos.length > 1 && !!p && looksDifferent(p));
    el.classList.toggle("broken", !!p?.broken);
  });
  // Keep the current photo in view, but only when it changes: scrolling forces a layout
  if (scrolledTo !== cur) {
    scrolledTo = cur;
    $("strip").children[cur]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  $("strip").classList.toggle("linked", scope === "all");
  $("strip-pos").textContent = photos.length ? `${cur + 1} of ${photos.length}` : "";
  $("prev").disabled = cur === 0;
  $("next").disabled = cur === photos.length - 1;
}

function removeFromBatch(i) {
  if (busySending) return;
  if (photos[i].thumb) URL.revokeObjectURL(photos[i].thumb);
  decoded.delete(photos[i]);
  photos.splice(i, 1);
  if (!photos.length) {
    $("editor").hidden = true;
    source?.close?.();
    source = null;
    packed = null;
    return;
  }
  const wasCurrent = i === cur;
  if (i < cur) cur--;
  cur = Math.min(cur, photos.length - 1);
  updateBatch();
  if (wasCurrent) select(cur);
}

function showLookStatus() {
  const p = photos[cur];
  if (!p) return;
  const n = photos.length;
  $("scope-all-label").textContent = `All ${n} photos`;
  $("scope-this-label").textContent = `only photo ${cur + 1}`;
  $("adjust").classList.toggle("scope-this", scope === "this");
  const others = photos.filter((q) => q !== p && looksDifferent(q)).length;
  const differs = n > 1 && looksDifferent(p);
  $("look-diff").hidden = !differs && !others;
  $("look-diff-text").textContent = differs
    ? "This photo looks different from the others."
    : `${plural(others, "other photo")} ${others === 1 ? "looks" : "look"} different (marked with a dot).`;
  $("look-match").hidden = !differs;
  $("look-all").hidden = !differs && !others;
  $("look-all").textContent = differs || !others ? "Use this look for all" : "Make them all look like this one";
}

for (const r of document.querySelectorAll("input[name=scope]")) {
  r.addEventListener("change", () => {
    scope = r.value;
    showLookStatus();
    markStrip();
  });
}
$("look-match").addEventListener("click", () => {
  photos[cur].look = { ...commonLook() };
  summarizeLooks();
  writeLook(photos[cur].look);
  showLookStatus();
  markStrip();
  scheduleRender();
});
$("look-all").addEventListener("click", () => {
  for (const q of photos) q.look = { ...photos[cur].look };
  summarizeLooks();
  showLookStatus();
  markStrip();
});

$("prev").addEventListener("click", () => !busySending && select(cur - 1));
$("next").addEventListener("click", () => !busySending && select(cur + 1));
document.addEventListener("keydown", (e) => {
  if (photos.length < 2 || $("editor").hidden || busySending) return;
  if (e.target instanceof Element && e.target.closest("input, select, textarea")) return; // sliders use the arrow keys
  if (e.key === "ArrowLeft" && cur > 0) select(cur - 1);
  if (e.key === "ArrowRight" && cur < photos.length - 1) select(cur + 1);
});

let frameInfo = null; // from loadInfo, for the batch note
function showBatchNote() {
  if (!frameInfo) return;
  const { rotateHours } = frameInfo.settings;
  const room = 200 - frameInfo.pictures.length;
  const notes = [];
  if (rotateHours === 0) {
    notes.push("This frame only changes when a new picture arrives, so only the first photo will show. Pick how often to change it in Frame settings below.");
  } else {
    notes.push(`The first photo goes up at the frame's next check-in; the rest join the rotation, changing ${rotateLabel(rotateHours)}.`);
  }
  if (photos.length > room) notes.push(`A frame keeps 200 pictures, so the ${photos.length - room} oldest will be removed.`);
  $("batch-note").textContent = notes.join(" ");
}

$("file").addEventListener("change", (e) => pickFiles(e.target.files));
$("folder").addEventListener("change", (e) => pickFiles(e.target.files));
// Folder picking isn't available everywhere (e.g. iPhone); there, "Choose photos" allows several.
if (!("webkitdirectory" in document.createElement("input")) || /iPhone|iPad|Android/i.test(navigator.userAgent)) {
  $("folder-picker").hidden = true;
}

$("rotate").addEventListener("click", () => {
  const p = photos[cur];
  p.turns = (p.turns + 1) % 4;
  source = rotate90(source);
  sourceId++;
  decoded.set(p, { turns: p.turns, canvas: Promise.resolve(source) });
  p.pan.x = p.pan.y = 0;
  scheduleRender();
});

document.querySelectorAll("#editor input, #editor select").forEach((el) => el.addEventListener("input", scheduleRender));

// Double-click (or double-tap) a slider to put it back to the default look.
for (const k of SLIDERS) {
  $(k).addEventListener("dblclick", () => {
    $(k).value = PRESETS.default[k];
    scheduleRender();
  });
}
$("zoom").addEventListener("dblclick", () => { $("zoom").value = 1; scheduleRender(); });

$("presets").addEventListener("click", (e) => {
  const name = e.target.closest("[data-preset]")?.dataset.preset;
  if (!name) return;
  applyPreset(PRESETS[name]);
  scheduleRender();
});

// Drag the preview to reposition the photo. Shows the plain photo while moving, dithers on release.
const pv = $("preview");
pv.addEventListener("pointerdown", (e) => {
  if (!pv.classList.contains("draggable")) return;
  dragging = true;
  pv.setPointerCapture(e.pointerId);
});
pv.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const k = pv.width / pv.clientWidth; // CSS px -> canvas px
  pan.x += e.movementX * k;
  pan.y += e.movementY * k;
  scheduleRender();
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  render();
};
pv.addEventListener("pointerup", endDrag);
pv.addEventListener("pointercancel", endDrag);

// Hold to compare with the photo before adjustments.
const cmp = $("compare");
cmp.addEventListener("pointerdown", (e) => {
  comparing = true;
  cmp.setPointerCapture(e.pointerId);
  render(true);
});
const endCompare = () => {
  if (!comparing) return;
  comparing = false;
  if (shown) pv.getContext("2d").putImageData(shown, 0, 0);
};
cmp.addEventListener("pointerup", endCompare);
cmp.addEventListener("pointercancel", endCompare);
cmp.addEventListener("contextmenu", (e) => e.preventDefault());

applyPreset(PRESETS.default);

// ---- Signing: a name on the picture itself ---------------------------------------
// For new photos these are remembered for next time. When editing, they show the picture's own
// signature, and changing them changes it for every picture being edited.

const savedPref = (k, fallback = "") => { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } };
const savePref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

/** Set the Sign it controls: from a picture's signature, or the remembered choice. */
function showSign(sign) {
  if (sign === undefined) {
    $("show-name").checked = savedPref("domiframe:show-name") === "1";
    $("sign-name").value = savedPref("domiframe:sign-name") || $("from").value.trim();
  } else {
    $("show-name").checked = !!sign;
    $("sign-name").value = sign ? sign.replace(/^from /, "") : savedPref("domiframe:sign-name") || $("from").value.trim();
  }
  $("sign-field").hidden = !$("show-name").checked;
}
function signChanged() {
  $("sign-field").hidden = !$("show-name").checked;
  if (editing) {
    for (const p of photos) p.sign = currentSign();
  } else {
    savePref("domiframe:show-name", $("show-name").checked ? "1" : "0");
    savePref("domiframe:sign-name", $("sign-name").value.trim());
  }
}
$("show-name").addEventListener("change", signChanged);
$("sign-name").addEventListener("input", signChanged);

$("from").value = savedPref("domiframe:from");
$("from").addEventListener("change", () => {
  savePref("domiframe:from", $("from").value.trim());
  if (!$("sign-name").value.trim() && !editing) $("sign-name").value = $("from").value.trim(); // a likely signature
});
showSign();

/** The settings a picture was made with, saved so it can be edited again. */
function editsOf(p) {
  return {
    v: 3, panel: framePanel(), orientation: framePortrait() ? "portrait" : "landscape", zoom: p.zoom, pan: { x: Math.round(p.pan.x), y: Math.round(p.pan.y) },
    look: p.look, label: labelFor(p), sign: signFor(p), caption: p.caption || "", date: p.date, showDate: !!p.showDate, corner: p.corner || "br",
  };
}

/** The photo as a JPEG (up to 2000 px), kept on the server for editing later. */
async function originalOf(p) {
  if (p.replaces && !p.turns) return p.file; // already the stored original
  const k = Math.min(1, 2000 / Math.max(source.width, source.height));
  const c = document.createElement("canvas");
  c.width = Math.round(source.width * k);
  c.height = Math.round(source.height * k);
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, "image/jpeg", 0.88));
}

/** The dithered picture (not the editor's preview) scaled so its long side is at most `max` px. */
function scaledPreview(max) {
  const full = document.createElement("canvas");
  full.width = dithered.width;
  full.height = dithered.height;
  full.getContext("2d").putImageData(dithered, 0, 0);
  const k = max / Math.max(full.width, full.height);
  if (k >= 1) return full;
  const c = document.createElement("canvas");
  c.width = Math.round(full.width * k);
  c.height = Math.round(full.height * k);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high"; // averages the ink dots back into a smooth little picture
  ctx.drawImage(full, 0, 0, c.width, c.height);
  return c;
}
const toBlob = (canvas, type, quality) => new Promise((r) => canvas.toBlob(r, type, quality));

/**
 * Everything to send for the photo in the editor: a new upload, or a replacement when editing.
 * Captures it all up front, so the editor can move on to the next photo while this one sends.
 */
async function prepareUpload(queue = "next") {
  const p = photos[cur];
  const form = new FormData();
  // Everything is sealed here, before it leaves the browser (web/seal.js)
  const sealed = async (blob) => blob && new Blob([await seal(contentKey, blob)], { type: "application/octet-stream" });
  const image = packed.slice(); // the editor may re-dither while this seals
  // Big screens get a half-size preview, to keep uploads small
  const [preview, small, original] = await Promise.all([
    toBlob(scaledPreview(800), "image/png"),
    toBlob(scaledPreview(400), "image/jpeg", 0.85), // for the picture grid
    originalOf(p),
  ]);
  const edits = editsOf(p);
  const [sImage, sPreview, sSmall, sOriginal] = await Promise.all([sealed(image), sealed(preview), sealed(small), sealed(original)]);
  form.append("image", sImage, "image.bin");
  form.append("preview", sPreview, "preview.bin");
  if (sSmall) form.append("thumb", sSmall, "thumb.bin");
  if (sOriginal) form.append("original", sOriginal, "original.bin");
  form.append("edits", await sealText(contentKey, JSON.stringify(edits)));
  if (p.replaces) return { path: `pictures/${p.replaces}`, init: { method: "PUT", body: form } };
  form.append("queue", queue);
  const album = $("upload-album").value;
  if (album) form.append("album", album);
  const from = $("from").value.trim().slice(0, 40);
  if (from) form.append("from", await sealText(contentKey, from));
  return { path: "image", init: { method: "POST", body: form } };
}

async function sendUpload({ path, init }) {
  const res = await api(path, init);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
}

$("send").addEventListener("click", async () => {
  $("send").disabled = true;
  try {
    if (photos.length > 1) await sendBatch();
    else {
      // Make sure the latest edits (e.g. a name typed a moment ago) are in what we send
      cancelAnimationFrame(pending);
      await render();
      if (!packed) return;
      msg(editing ? "Saving…" : "Sending…");
      await sendUpload(await prepareUpload());
      msg(editing
        ? "Saved. If it's on the frame, it redraws at the next check-in. Press the button on the frame to update it now."
        : "Sent! The frame will show it at its next check-in; press the button on the frame to show it now. To change it later, select it above and press Edit.", "ok");
      clearEditor();
    }
  } catch (err) {
    msg(`Upload failed: ${err.message}`, "err");
  } finally {
    $("send").disabled = false;
    loadInfo();
  }
});

async function sendBatch() {
  const order = photos.map((_, i) => i);
  if ($("shuffle").checked && !editing) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  busySending = true;
  $("editor").classList.add("sending");
  let sent = 0, failed = 0, started = 0;
  // While one photo uploads, the next is dithered: the two biggest waits overlap. Uploads still
  // go one at a time, in order, so the first one is the one that goes up next.
  let inflight = null;
  const settle = async () => {
    if (!inflight) return;
    (await inflight) ? sent++ : failed++;
    inflight = null;
  };
  const send = async (req) => {
    try {
      await sendUpload(req);
    } catch {
      try { await sendUpload(req); } catch { return false; } // one retry for a flaky connection
    }
    return true;
  };
  try {
    for (const [n, i] of order.entries()) {
      msg(`${editing ? "Saving" : "Sending"} ${n + 1} of ${order.length}…`);
      if (!(await select(i))) { failed++; continue; }
      const req = await prepareUpload(started++ === 0 ? "next" : "rotation");
      await settle();
      inflight = send(req);
    }
    await settle();
  } finally {
    busySending = false;
    $("editor").classList.remove("sending");
  }
  const verb = editing ? "Saved" : "Sent";
  msg(`${verb} ${plural(sent, editing ? "picture" : "photo")}` + (failed ? `; ${failed} couldn't be opened or sent.` : ".") +
    (sent ? " They reach the frame at its next check-in; press the button on the frame to update it now." : ""), failed ? "err" : "ok");
  if (!failed) clearEditor();
}


showSwitcher(); // right away, so it's there even if this frame can't be opened
loadInfo();

// Coming back to the page (e.g. after pressing the frame's button): show the latest check-in.
let lastInfo = Date.now();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || busySending || Date.now() - lastInfo < 30e3) return;
  lastInfo = Date.now();
  loadInfo();
});

// ---- Adjustment tabs ------------------------------------------------------------

function showTab(name) {
  for (const t of document.querySelectorAll(".tabs [data-tab]")) t.setAttribute("aria-selected", t.dataset.tab === name);
  for (const p of document.querySelectorAll(".panel[data-panel]")) p.hidden = p.dataset.panel !== name;
  try { localStorage.setItem("domiframe:tab", name); } catch {}
}
for (const t of document.querySelectorAll(".tabs [data-tab]")) t.addEventListener("click", () => showTab(t.dataset.tab));
let savedTab = "frame";
try { savedTab = localStorage.getItem("domiframe:tab") || "frame"; } catch {}
showTab(document.querySelector(`.panel[data-panel="${savedTab}"]`) ? savedTab : "frame");
