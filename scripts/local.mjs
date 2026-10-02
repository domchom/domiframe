// Run the whole thing locally, no Netlify account or frame hardware needed:
//   npm run local
// Serves web/, the API functions, and the virtual frame at /sim.html (also on the real site).
// Blobs live in .local/blobs so pictures survive restarts; delete .local/ to start over.

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BlobsServer } from "@netlify/blobs/server";
import { setEnvironmentContext } from "@netlify/blobs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = join(ROOT, ".local");
const PORT = Number(process.env.PORT) || 8888;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "local-admin";

await mkdir(join(LOCAL, "blobs"), { recursive: true });
const blobs = new BlobsServer({ directory: join(LOCAL, "blobs"), token: "local" });
const { port: blobsPort } = await blobs.start();
const edgeURL = `http://localhost:${blobsPort}`;
setEnvironmentContext({ siteID: "local", token: "local", edgeURL, uncachedEdgeURL: edgeURL });
process.env.ADMIN_TOKEN = ADMIN_TOKEN;
process.env.PUBLIC_URL ||= `http://localhost:${PORT}`;
globalThis.Netlify = { env: { get: (k) => process.env[k] } };

const admin = (await import("../netlify/functions/admin-frames.mjs")).default;
const frameImage = (await import("../netlify/functions/frame-image.mjs")).default;
const frameInfo = (await import("../netlify/functions/frame-info.mjs")).default;
const frameCode = (await import("../netlify/functions/frame-code.mjs")).default;
const frameAlerts = (await import("../netlify/functions/frame-alerts.mjs")).default;
const { runAlerts } = await import("../netlify/functions/send-alerts.mjs");
const { sendTo } = await import("../netlify/lib/push.mjs");
const { loadFrame } = await import("../netlify/lib/common.mjs");
globalThis.__domiframeClockOffset = 0;

// Same routes as the functions' `config.path`.
function route(pathname) {
  let m;
  if ((m = pathname.match(/^\/api\/admin\/frames(?:\/([^/]+)(?:\/(?:keys|settings))?)?$/))) return { fn: admin, params: m[1] ? { id: m[1] } : {} };
  if ((m = pathname.match(/^\/api\/frames\/([^/]+)\/image$/))) return { fn: frameImage, params: { id: m[1] } };
  if ((m = pathname.match(/^\/api\/frames\/([^/]+)\/code$/))) return { fn: frameCode, params: { id: m[1] } };
  if ((m = pathname.match(/^\/api\/frames\/([^/]+)\/alerts$/))) return { fn: frameAlerts, params: { id: m[1] } };
  if ((m = pathname.match(/^\/api\/frames\/([^/]+)\/(?:info|preview|settings|restore|trash|pictures(?:\/[^/]+){0,2}|albums(?:\/[^/]+)?)$/))) {
    return { fn: frameInfo, params: { id: m[1] } };
  }
  return null;
}

// Dev-only clock, so the virtual frame can skip ahead hours or days to test schedules.
//   GET /__dev/clock -> { now, offsetMinutes }   POST /__dev/clock { advanceMinutes } or { reset: true }
async function devClock(req, res) {
  if (req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    const { advanceMinutes, reset } = JSON.parse(body || "{}");
    globalThis.__domiframeClockOffset = reset ? 0 : (globalThis.__domiframeClockOffset || 0) + Number(advanceMinutes || 0) * 60e3;
  }
  const offset = globalThis.__domiframeClockOffset || 0;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ now: new Date(Date.now() + offset).toISOString(), offsetMinutes: Math.round(offset / 60e3) }));
}

// Alerts are checked every half hour, as on Netlify (functions/send-alerts.mjs); POST
// /__dev/alerts checks now. APNs only sends with APNS_* set; otherwise the alert is printed here.
const apnsSet = !!process.env.APNS_KEY;
const devSend = (sub, payload) => {
  if (sub.kind === "apns" && !apnsSet) {
    console.log(`alert (APNs not set up) to ${sub.token.slice(0, 8)}…: ${payload.title}: ${payload.body}`);
    return "ok";
  }
  return sendTo(sub, payload);
};
const checkAlerts = async () => {
  const sent = await runAlerts({ send: devSend });
  for (const a of sent) console.log(`alert for ${a.id}: ${a.title} (${a.to} got it)`);
  return sent;
};
setInterval(() => checkAlerts().catch((e) => console.error("alerts:", e)), 30 * 60e3);
async function devAlerts(req, res) {
  const sent = await checkAlerts();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ sent }));
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

// The same security headers as the real site, read from netlify.toml, so a page that breaks the
// CSP breaks here too (minus HSTS, which would stick localhost to HTTPS).
const SECURITY_HEADERS = Object.fromEntries(
  [...(await readFile(join(ROOT, "netlify.toml"), "utf8")).split("[headers.values]")[1].matchAll(/^\s*([\w-]+)\s*=\s*"(.*)"\s*$/gm)]
    .map(([, k, v]) => [k.toLowerCase(), v])
    .filter(([k]) => k !== "strict-transport-security"),
);

async function serveStatic(pathname) {
  if (pathname.startsWith("/f/")) pathname = "/upload.html"; // netlify.toml redirect
  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/.well-known/apple-app-site-association") {
    return { body: await readFile(join(ROOT, "web", pathname)), type: "application/json" }; // as netlify.toml
  }
  const base = join(ROOT, "web");
  const file = normalize(join(base, pathname));
  if (!file.startsWith(base)) return null;
  try {
    return { body: await readFile(file), type: TYPES[extname(file)] || "application/octet-stream" };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const common = SECURITY_HEADERS;
  try {
    if (url.pathname === "/__dev/clock") return devClock(req, res);
    if (url.pathname === "/__dev/alerts" && req.method === "POST") return devAlerts(req, res);
    const r = route(url.pathname);
    if (r) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const hasBody = !["GET", "HEAD"].includes(req.method);
      const request = new Request(url, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });
      const response = await r.fn(request, { params: r.params });
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, { ...common, ...Object.fromEntries(response.headers) });
      res.end(body);
      log(req.method, url.pathname, response.status);
      return;
    }
    const file = await serveStatic(url.pathname);
    if (!file) {
      const page = url.pathname.startsWith("/api/") ? null : await serveStatic("/404.html"); // like Netlify
      res.writeHead(404, { ...common, "content-type": page ? page.type : "text/plain" }).end(page ? page.body : "not found");
      return;
    }
    res.writeHead(200, { ...common, "content-type": file.type, "cache-control": "no-store" }).end(file.body);
  } catch (err) {
    console.error(err);
    res.writeHead(500, common).end(String(err));
  }
});

function log(method, path, status) {
  if (path.startsWith("/api/")) console.log(`${new Date().toLocaleTimeString()}  ${method} ${path} -> ${status}`);
}

// A demo frame whose keys we keep in .local/demo.json (the real server only shows them once).
async function demoFrame() {
  const file = join(LOCAL, "demo.json");
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (await loadFrame(saved.id)) return saved;
  } catch {}
  const res = await admin(
    new Request(`http://localhost:${PORT}/api/admin/frames`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "demo", name: "Demo frame" }),
    }),
    { params: {} },
  );
  const created = await res.json();
  if (res.status !== 201) throw new Error(`could not create demo frame: ${JSON.stringify(created)}`);
  await writeFile(file, JSON.stringify(created, null, 2));
  return created;
}

const demo = await demoFrame();
server.on("error", async (err) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.error(`Port ${PORT} is already in use (another \`npm run local\` or \`netlify dev\`?). Stop it, or run: PORT=8889 npm run local`);
  await blobs.stop();
  process.exit(1);
});
server.listen(PORT, () => {
  const sim = `http://localhost:${PORT}/sim.html#id=${demo.id}&key=${encodeURIComponent(demo.deviceKey)}`;
  console.log(`
DomiFrame running locally (no hardware needed)

  Virtual frame:  ${sim}
  Home page:      http://localhost:${PORT}/#frame
  Admin page:     http://localhost:${PORT}/admin.html  (token: ${ADMIN_TOKEN})

Open the virtual frame first: like a real frame, it makes its own frame code and shows it.
Then press "Open this frame's page" (or enter ID ${demo.id} and the code under My frame),
send a picture, and press KEY1 on the virtual frame.
`);
});

const stop = async () => {
  server.close();
  await blobs.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
