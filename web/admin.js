import { ask, tell } from "./dialog.js";
import { ago, until, batteryPct, LOW_BATTERY_PCT, rotateLabel } from "./format.js";

const $ = (id) => document.getElementById(id);
// Kept for this tab only: closing it signs out, so the token doesn't sit in the browser.
const TOKEN_KEY = "domiframe:admin";

let token = "";
try {
  localStorage.removeItem(TOKEN_KEY); // saved there by older versions
  token = sessionStorage.getItem(TOKEN_KEY) || "";
} catch {}

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
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch {}
  } else {
    setMsg("signin-msg", "That token didn't work.", "err");
  }
});

$("signout").addEventListener("click", () => {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
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
    const unseen = f.unseen;

    const head = el("div", "frame-head");
    head.append(el("strong", "", f.name), el("span", "muted small", f.id));
    const battery = el("span", low ? "badge warn" : "badge", pct != null ? `🔋 ${pct}%` : "🔋 –");
    head.append(battery);

    const lines = el("p", "muted small");
    lines.textContent = [
      f.lastSeen ? `Checked in ${ago(f.lastSeen)}` : "Never checked in",
      next && `next ${next}`,
      f.fw && `fw ${f.fw}`,
      f.claimed ? "has its frame code" : "waiting for the frame to make its code",
    ].filter(Boolean).join(" · ");
    const hang = f.settings.orientation || "landscape";
    const pics = el("p", "muted small", `${f.settings.panel || "7.3"}" screen · hangs ${hang} · ` +
      `${f.pictures} picture${f.pictures === 1 ? "" : "s"}` +
      (unseen ? ` (${unseen} new)` : "") +
      (f.albums ? ` · ${f.albums} folder${f.albums === 1 ? "" : "s"}` : "") +
      ` · changes ${rotateLabel(f.settings.rotateHours)}` + (f.settings.order === "shuffle" ? ", shuffled" : "") +
      (f.settings.quiet ? ` · sleeps ${f.settings.quietStart}:00–${f.settings.quietEnd}:00` : ""));

    // No way in to the pictures from here: they're sealed with the frame's code, which only
    // the frame and the people it's shared with have.
    const actions = el("div", "chips");
    actions.append(
      button(hang === "portrait" ? "Turn to landscape" : "Turn to portrait", () => turn(f, hang === "portrait" ? "landscape" : "portrait")),
      button("New device key", () => newKey(f)),
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

async function newKey(f) {
  const warning = `Make a new device key for "${f.name}"? The frame stops updating until you enter the new key in its setup portal (hold KEY3 and press reset). Its frame code and pictures stay as they are.`;
  if (!(await ask({ title: "New device key?", message: warning, ok: "Replace key", danger: true }))) return;
  const res = await api(`/${f.id}/keys`, { method: "POST", body: JSON.stringify({ key: "device" }) });
  const data = await res.json();
  if (!res.ok) return tell("That didn't work", data.error || res.statusText);
  showResult(f.id, data, "New device key");
  load();
}

/** Change how a frame hangs. New pictures are made for it; existing ones can be rebuilt on its page. */
async function turn(f, orientation) {
  const res = await api(`/${f.id}/settings`, { method: "PUT", body: JSON.stringify({ orientation }) });
  if (!res.ok) return tell("That didn't work", (await res.json().catch(() => ({}))).error || res.statusText);
  load();
}

async function remove(f) {
  const typed = await ask({
    title: `Delete “${f.name}”?`,
    message: `This deletes the frame and all its pictures, and its links stop working. Type ${f.id} to confirm.`,
    mustType: f.id, ok: "Delete frame", danger: true,
  });
  if (typed !== f.id) return;
  const res = await api(`/${f.id}`, { method: "DELETE" });
  if (!res.ok) return tell("That didn't work", (await res.json().catch(() => ({}))).error || res.statusText);
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
  const res = await api("", {
    method: "POST",
    body: JSON.stringify({ id: $("new-id").value.trim(), name: $("new-name").value.trim(), panel: $("new-panel").value }),
  });
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
  $("result-note").textContent = "The device key is shown only this once. Copy it now. " +
    "Once the frame is set up it makes its own frame code and shows it on its screen: that code, not anything here, is what opens the frame on the website.";
  const body = $("result-body");
  body.replaceChildren();
  body.append(field("Frame ID: enter in the frame's setup portal", id));
  body.append(field("Device key: enter in the frame's setup portal", data.deviceKey));
  // No hardware yet? The virtual frame does what the real one does, in a browser tab
  const a = el("a", "chip", "Open as a virtual frame");
  // With the screen chosen above, so the virtual frame starts as that screen
  a.href = `/sim.html#id=${id}&key=${encodeURIComponent(data.deviceKey)}&screen=${encodeURIComponent(data.settings?.panel || $("new-panel").value)}`;
  a.target = "_blank";
  a.rel = "noopener";
  body.append(a);
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

load();
