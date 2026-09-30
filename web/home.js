import { ditherToPalette, indicesToRGBA } from "./dither.js";
import { normalizeCode, parseLink, frameLink, rememberedFrames, forgetFrame, savedKey } from "./code.js";
import { ask } from "./dialog.js";

const $ = (id) => document.getElementById(id);

// ---- Tabs: About / My frame (#frame opens the second, so it can be linked to) ------

function showPage(name, push = true) {
  for (const t of document.querySelectorAll(".site-tabs [data-page]")) t.setAttribute("aria-selected", t.dataset.page === name);
  for (const p of document.querySelectorAll("[data-page-panel]")) p.hidden = p.dataset.pagePanel !== name;
  if (push) history.replaceState(null, "", name === "frame" ? "#frame" : location.pathname);
  if (name === "frame") {
    showSaved();
    if (!rememberedFrames().length) $("open-id").focus({ preventScroll: true });
  }
}
for (const el of document.querySelectorAll("[data-page], [data-go]")) {
  el.addEventListener("click", () => {
    showPage(el.dataset.page || el.dataset.go);
    window.scrollTo({ top: 0 });
  });
}
showPage(location.hash === "#frame" ? "frame" : "about", false);

// ---- Frames this device has opened ------------------------------------------------

function showSaved() {
  const frames = rememberedFrames();
  $("saved").hidden = !frames.length;
  $("open-title").textContent = frames.length ? "Or open another frame" : "Enter your frame's details";
  $("saved-list").replaceChildren(...frames.map((f) => {
    const li = document.createElement("li");
    const open = document.createElement("a");
    open.className = "saved-open";
    open.href = frameLink(f.id, savedKey(f.id));
    const name = document.createElement("b");
    name.textContent = f.name;
    const id = document.createElement("span");
    id.textContent = f.id;
    open.append(name, id);
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "link";
    forget.textContent = "Forget";
    forget.setAttribute("aria-label", `Forget ${f.name} on this device`);
    forget.addEventListener("click", async () => {
      const ok = await ask({
        title: `Forget “${f.name}” on this device?`,
        message: "The frame and its pictures stay as they are. You'll need its ID and code (or link) to open it here again.",
        ok: "Forget",
      });
      if (ok) { forgetFrame(f.id); showSaved(); }
    });
    li.append(open, forget);
    return li;
  }));
}

// ---- Open a frame by ID and code (or a pasted link) ----------------------------------

function msg(text, kind = "") {
  $("open-msg").textContent = text;
  $("open-msg").className = `msg ${kind}`;
}

// Tidy the code as it's typed: capitals, dashes every four
$("open-code").addEventListener("input", (e) => {
  const el = e.target;
  const clean = el.value.toUpperCase().replace(/[\s-]/g, "");
  // Only frame codes (up to 16 letters and digits); a link or an older long key stays as typed
  if (!/^[0-9A-Z]{0,16}$/.test(clean)) return;
  const shown = clean.match(/.{1,4}/g)?.join("-") || "";
  if (shown !== el.value) el.value = shown;
});
// A link pasted into either box fills both
for (const el of [$("open-id"), $("open-code")]) {
  el.addEventListener("paste", (e) => {
    const link = parseLink(e.clipboardData.getData("text"));
    if (!link) return;
    e.preventDefault();
    $("open-id").value = link.id;
    $("open-code").value = link.key;
    msg("");
  });
}

$("open-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  let id = $("open-id").value.trim().toLowerCase();
  let key = normalizeCode($("open-code").value);
  const link = parseLink($("open-id").value) || parseLink($("open-code").value);
  if (link) ({ id, key } = link);
  if (!id || !key) return msg("Enter both the frame ID and its code.", "err");
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) return msg("A frame ID is lowercase letters, numbers and dashes, like emma or gran-kitchen.", "err");

  $("open-go").disabled = true;
  msg("Checking…");
  try {
    const res = await fetch(`/api/frames/${id}/info`, { headers: { Authorization: `Bearer ${key}` } });
    if (res.ok) {
      location.href = frameLink(id, key); // the frame page saves it for next time
      return;
    }
    msg(res.status === 404 ? "That ID and code don't match a frame. Check both and try again." : "Something went wrong. Try again in a moment.", "err");
  } catch {
    msg("Couldn't reach the server. Check your connection.", "err");
  } finally {
    $("open-go").disabled = false;
  }
});

// ---- The example picture: a little scene, dithered like a real upload ----------------

function drawSample() {
  const c = $("sample");
  const w = c.width, h = c.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.7);
  sky.addColorStop(0, "#3d6fb8");
  sky.addColorStop(0.55, "#e9a06a");
  sky.addColorStop(1, "#f6d98a");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  const sun = ctx.createRadialGradient(w * 0.68, h * 0.52, 4, w * 0.68, h * 0.52, 46);
  sun.addColorStop(0, "#fff6c8");
  sun.addColorStop(0.45, "#ffd23a");
  sun.addColorStop(1, "rgba(255,160,60,0)");
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, h);
  // hills, far to near
  const hill = (y0, amp, freq, phase, top, bottom) => {
    const g = ctx.createLinearGradient(0, y0 - amp, 0, h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 4) ctx.lineTo(x, y0 + Math.sin(x * freq + phase) * amp + Math.sin(x * freq * 2.7) * amp * 0.3);
    ctx.lineTo(w, h);
    ctx.fill();
  };
  hill(h * 0.62, 10, 0.018, 1, "#7d7aa8", "#5a5f86");
  hill(h * 0.72, 12, 0.012, 3, "#4f8a4a", "#2e5a2c");
  hill(h * 0.85, 8, 0.02, 0.5, "#2f6b33", "#1b3a1d");
  // a red barn
  ctx.fillStyle = "#b2231c";
  ctx.fillRect(w * 0.18, h * 0.66, 46, 30);
  ctx.beginPath();
  ctx.moveTo(w * 0.18 - 4, h * 0.66);
  ctx.lineTo(w * 0.18 + 23, h * 0.66 - 16);
  ctx.lineTo(w * 0.18 + 50, h * 0.66);
  ctx.fill();
  ctx.fillStyle = "#f2efe6";
  ctx.fillRect(w * 0.18 + 17, h * 0.66 + 12, 12, 18);

  const img = ctx.getImageData(0, 0, w, h);
  const idx = ditherToPalette(img.data, w, h, { saturation: 1.3, contrast: 1.1 });
  ctx.putImageData(new ImageData(indicesToRGBA(idx), w, h), 0, 0);
}
drawSample();
