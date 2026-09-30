import { PANEL_W, PANEL_H, ditherToPalette, rotatePortraitToPanel, pack, indicesToRGBA } from "./dither.js";

const $ = (id) => document.getElementById(id);
const frameId = (location.pathname.match(/^\/f\/([a-z0-9-]+)/) || [])[1];
const storageKey = `domiframe:${frameId}`;

let uploadKey = new URLSearchParams(location.hash.slice(1)).get("k");
try {
  if (uploadKey) localStorage.setItem(storageKey, uploadKey);
  else uploadKey = localStorage.getItem(storageKey);
} catch { /* storage unavailable */ }

const auth = { Authorization: `Bearer ${uploadKey}` };
let bitmap = null;
let packed = null;

function msg(text, kind = "") {
  $("msg").textContent = text;
  $("msg").className = `msg ${kind}`;
}

function ago(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function batteryPct(mv) {
  if (!mv) return null;
  return Math.max(0, Math.min(100, Math.round(((mv - 3300) / (4150 - 3300)) * 100)));
}

async function loadInfo() {
  if (!frameId || !uploadKey) {
    $("frame-status").textContent = "This link is incomplete. Ask for a new one.";
    $("file").disabled = true;
    return;
  }
  const res = await fetch(`/api/frames/${frameId}/info`, { headers: auth });
  if (!res.ok) {
    $("frame-status").textContent = "This link doesn't work. Ask for a new one.";
    $("file").disabled = true;
    return;
  }
  const info = await res.json();
  $("frame-name").textContent = info.name || "Your frame";
  document.title = `${info.name || "Frame"} · DomiFrame`;
  const pct = batteryPct(info.batteryMv);
  $("frame-status").textContent =
    `Last checked in ${ago(info.lastSeen)}` + (pct != null ? ` · battery ${pct}%` : "");
  if (info.imageUploadedAt) loadCurrent(info.imageUploadedAt);
}

async function loadCurrent(uploadedAt) {
  const res = await fetch(`/api/frames/${frameId}/preview`, { headers: auth });
  if (!res.ok) return;
  $("current-img").src = URL.createObjectURL(await res.blob());
  $("current-img").hidden = false;
  $("current-caption").textContent = `Sent ${ago(uploadedAt)}`;
}

function opts() {
  const val = (name) => document.querySelector(`input[name=${name}]:checked`).value;
  return {
    portrait: val("orient") === "portrait",
    fit: val("fit"),
    saturation: parseFloat($("saturation").value),
    brightness: parseFloat($("brightness").value),
  };
}

function render() {
  if (!bitmap) return;
  const o = opts();
  const w = o.portrait ? PANEL_H : PANEL_W;
  const h = o.portrait ? PANEL_W : PANEL_H;

  const work = document.createElement("canvas");
  work.width = w;
  work.height = h;
  const ctx = work.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  const scale = (o.fit === "cover" ? Math.max : Math.min)(w / bitmap.width, h / bitmap.height);
  const dw = bitmap.width * scale, dh = bitmap.height * scale;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (w - dw) / 2, (h - dh) / 2, dw, dh);

  const idx = ditherToPalette(ctx.getImageData(0, 0, w, h).data, w, h, o);

  const pv = $("preview");
  pv.width = w;
  pv.height = h;
  pv.getContext("2d").putImageData(new ImageData(indicesToRGBA(idx), w, h), 0, 0);

  packed = pack(o.portrait ? rotatePortraitToPanel(idx) : idx);
}

let pending = 0;
function scheduleRender() {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(render);
}

$("file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  msg("");
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    msg("Couldn't open that photo. Try a JPEG or PNG.", "err");
    return;
  }
  // default orientation from the photo itself
  const portrait = bitmap.height > bitmap.width;
  document.querySelector(`input[name=orient][value=${portrait ? "portrait" : "landscape"}]`).checked = true;
  $("editor").hidden = false;
  render();
});

document.querySelectorAll("#editor input").forEach((el) => el.addEventListener("input", scheduleRender));

$("send").addEventListener("click", async () => {
  if (!packed) return;
  $("send").disabled = true;
  msg("Sending…");
  try {
    const preview = await new Promise((r) => $("preview").toBlob(r, "image/png"));
    const form = new FormData();
    form.append("image", new Blob([packed], { type: "application/octet-stream" }), "image.bin");
    form.append("preview", preview, "preview.png");
    const res = await fetch(`/api/frames/${frameId}/image`, { method: "POST", headers: auth, body: form });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    msg("Sent! The frame will show it at its next check-in.", "ok");
    loadCurrent(new Date().toISOString());
  } catch (err) {
    msg(`Upload failed: ${err.message}`, "err");
  } finally {
    $("send").disabled = false;
  }
});

loadInfo();
