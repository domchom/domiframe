import { ditherToPalette, indicesToRGBA } from "./dither.js";
import { normalizeCode, isFrameCode, parseLink, frameLink, rememberedFrames, forgetFrame, savedKey } from "./code.js";
import { frameKeys } from "./seal.js";
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
  // Only frame codes (up to 16 letters and digits); a pasted link stays as typed
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
  key = normalizeCode(key);
  if (!id || !key) return msg("Enter both the frame ID and its code.", "err");
  if (!isFrameCode(key)) return msg("A frame code is 16 letters and numbers, like K7PX-92QD-M4TR-8WZN.", "err");
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) return msg("A frame ID is lowercase letters, numbers and dashes, like emma or gran-kitchen.", "err");

  $("open-go").disabled = true;
  msg("Checking…");
  try {
    const { auth } = await frameKeys(id, key); // the code itself stays in this browser
    const res = await fetch(`/api/frames/${id}/info`, { headers: { Authorization: `Bearer ${auth}` } });
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

// ---- The example picture: a real photo, dithered here like an upload ------------------

async function drawSample() {
  const c = $("sample");
  const w = c.width, h = c.height;
  const photo = new Image();
  photo.src = "/sample.jpg"; // 800×480, the frame's shape
  try {
    await photo.decode();
  } catch {
    return; // the page works without it
  }
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(photo, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const idx = ditherToPalette(img.data, w, h, { saturation: 1.3, contrast: 1.1 });
  ctx.putImageData(new ImageData(indicesToRGBA(idx), w, h), 0, 0);
}
drawSample();
