import { ago, until, batteryPct, LOW_BATTERY_PCT, rotateLabel } from "./format.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "domiframe:admin"; // upload.js reads this for #admin links
const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) || location.hostname.endsWith(".local");

let token = "";
try { token = localStorage.getItem(TOKEN_KEY) || ""; } catch {}

const api = (path, init = {}) =>
  fetch(`/api/admin/frames${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });

function setMsg(el, text, kind = "") {
  $(el).textContent = text;
  $(el).className = `msg ${kind}`;
}

// ---- sign in ---------------------------------------------------------------

$("signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = $("token").value.trim();
  if (await load()) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch {}
  } else {
    setMsg("signin-msg", "That token didn't work.", "err");
  }
});

$("signout").addEventListener("click", () => {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  token = "";
  $("app").hidden = true;
  $("signin").hidden = false;
  $("signout").hidden = true;
  $("token").value = "";
});

// ---- frame list ------------------------------------------------------------

async function load() {
  if (!token) return false;
  const res = await api("");
  if (res.status === 401) return false;
  if (!res.ok) {
    setMsg("frames-msg", `Couldn't load frames: ${(await res.json().catch(() => ({}))).error || res.statusText}`, "err");
    return true;
  }
  $("signin").hidden = true;
  $("app").hidden = false;
  $("signout").hidden = false;
  const { frames } = await res.json();
  render(frames);
  return true;
}

function render(frames) {
  const list = $("frames");
  list.replaceChildren();
  setMsg("frames-msg", frames.length ? "" : "No frames yet. Add one below.");
  for (const f of frames) {
    const li = document.createElement("li");
    const pct = batteryPct(f.batteryMv);
    const low = pct != null && pct < LOW_BATTERY_PCT;
    const next = until(f.nextCheckIn);
    const unseen = f.pictures.filter((p) => !p.seen).length;

    const head = el("div", "frame-head");
    head.append(el("strong", "", f.name), el("span", "muted small", f.id));
    const battery = el("span", low ? "badge warn" : "badge", pct != null ? `🔋 ${pct}%` : "🔋 –");
    head.append(battery);

    const lines = el("p", "muted small");
    lines.textContent = [
      f.lastSeen ? `Checked in ${ago(f.lastSeen)}` : "Never checked in",
      next && `next ${next}`,
      f.fw && `fw ${f.fw}`,
    ].filter(Boolean).join(" · ");
    const hang = f.settings.orientation || "landscape";
    const pics = el("p", "muted small", `hangs ${hang} · ` +
      `${f.pictures.length} picture${f.pictures.length === 1 ? "" : "s"}` +
      (unseen ? ` (${unseen} new)` : "") +
      (f.settings.album ? ` · shows “${f.albums.find((a) => a.id === f.settings.album)?.name}”` : "") +
      (f.albums.length ? ` · ${f.albums.length} folder${f.albums.length === 1 ? "" : "s"}` : "") +
      ` · changes ${rotateLabel(f.settings.rotateHours)}` + (f.settings.order === "shuffle" ? ", shuffled" : "") +
      (f.settings.quiet ? ` · sleeps ${f.settings.quietStart}:00–${f.settings.quietEnd}:00` : ""));

    const actions = el("div", "chips");
    const open = el("a", "chip", "Open");
    open.href = `/f/${f.id}#admin`;
    open.target = "_blank";
    open.rel = "noopener";
    actions.append(
      open,
      button(hang === "portrait" ? "Turn to landscape" : "Turn to portrait", () => turn(f, hang === "portrait" ? "landscape" : "portrait")),
      button("New upload link", () => newKey(f, "upload")),
      button("New device key", () => newKey(f, "device")),
      button("Delete", () => remove(f), "danger"),
    );
    li.append(head, lines, pics, actions);
    list.append(li);
  }
}

function el(tag, cls = "", text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function button(label, onClick, extra = "") {
  const b = el("button", `chip ${extra}`.trim(), label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

$("refresh").addEventListener("click", load);

// ---- actions ---------------------------------------------------------------

async function newKey(f, which) {
  const warning = which === "upload"
    ? `Make a new upload link for "${f.name}"? The old link will stop working.`
    : `Make a new device key for "${f.name}"? The frame stops updating until you enter the new key in its setup portal (hold KEY3 and press reset).`;
  if (!confirm(warning)) return;
  const res = await api(`/${f.id}/keys`, { method: "POST", body: JSON.stringify({ key: which }) });
  const data = await res.json();
  if (!res.ok) return alert(data.error || res.statusText);
  showResult(f.id, data, which === "upload" ? "New upload link" : "New device key");
  load();
}

/** Change how a frame hangs. New pictures are made for it; existing ones can be rebuilt on its page. */
async function turn(f, orientation) {
  const res = await fetch(`/api/frames/${f.id}/settings`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ orientation }),
  });
  if (!res.ok) return alert((await res.json().catch(() => ({}))).error || res.statusText);
  load();
}

async function remove(f) {
  if (prompt(`This deletes "${f.name}" and all its pictures. Type the frame ID (${f.id}) to confirm.`) !== f.id) return;
  const res = await api(`/${f.id}`, { method: "DELETE" });
  if (!res.ok) return alert((await res.json().catch(() => ({}))).error || res.statusText);
  load();
}

$("new-name").addEventListener("input", () => {
  // Suggest an ID from the name until the user edits it
  if ($("new-id").dataset.edited) return;
  $("new-id").value = $("new-name").value.toLowerCase().replace(/'s\b/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
});
$("new-id").addEventListener("input", () => ($("new-id").dataset.edited = "1"));

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await api("", { method: "POST", body: JSON.stringify({ id: $("new-id").value.trim(), name: $("new-name").value.trim() }) });
  const data = await res.json();
  if (!res.ok) return setMsg("create-msg", data.error || res.statusText, "err");
  setMsg("create-msg", "");
  $("create-form").reset();
  delete $("new-id").dataset.edited;
  showResult(data.id, data, `Created "${data.name}"`);
  load();
});

// ---- one-time keys ---------------------------------------------------------

function showResult(id, data, title) {
  $("result-title").textContent = title;
  $("result-note").textContent = "Keys are shown only this once. Copy them now.";
  const body = $("result-body");
  body.replaceChildren();
  if (data.uploadLink) {
    body.append(field("Upload link: send this to your friend", data.uploadLink));
    const qr = qrSvg(data.uploadLink);
    if (qr) body.append(qr);
  }
  if (data.deviceKey) {
    body.append(field("Frame ID: enter in the frame's setup portal", id));
    body.append(field("Device key: enter in the frame's setup portal", data.deviceKey));
    if (isLocal) {
      const a = el("a", "chip", "Open virtual frame");
      a.href = `/sim.html#id=${id}&key=${encodeURIComponent(data.deviceKey)}`;
      a.target = "_blank";
      body.append(a);
    }
  }
  $("result").hidden = false;
  $("result").scrollIntoView({ behavior: "smooth" });
}

$("result-close").addEventListener("click", () => {
  $("result").hidden = true;
  $("result-body").replaceChildren(); // don't leave keys on screen
});

function field(label, value) {
  const wrap = el("label", "slider", label);
  const row = el("div", "copy-row");
  const input = el("input", "text");
  input.readOnly = true;
  input.value = value;
  input.addEventListener("focus", () => input.select());
  const copy = button("Copy", async () => {
    await navigator.clipboard.writeText(value);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  });
  row.append(input, copy);
  wrap.append(row);
  return wrap;
}

function qrSvg(text) {
  if (typeof window.qrcode !== "function") return null; // CDN unavailable: the link is enough
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const box = el("div", "qr");
  box.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  box.append(el("p", "muted small", "Or scan this with their phone's camera."));
  return box;
}

load();
