// Sending alerts to the iPhone app, through Apple's push service (APNs). Returns "ok", "gone"
// (the token no longer works: forget it) or "error" (try again next time).
//
// Environment (Netlify site configuration):
//   APNS_KEY                              the .p8 key from Apple (Certificates, IDs & Profiles → Keys, with APNs)
//   APNS_KEY_ID, APNS_TEAM_ID             its key ID, and the developer team ID
//   APNS_TOPIC                            the app's bundle ID (default art.domiframe.app)

import { connect } from "node:http2";
import { createSign } from "node:crypto";

const env = (k) => globalThis.Netlify?.env.get(k) ?? process.env[k];

// The APNs token (a JWT signed with the .p8 key) is good for up to an hour; Apple refuses ones
// renewed more than every 20 minutes, so it's kept and reused
let apnsJwt = { token: null, at: 0 };
function apnsToken() {
  if (apnsJwt.token && Date.now() - apnsJwt.at < 40 * 60e3) return apnsJwt.token;
  const key = (env("APNS_KEY") || "").replace(/\\n/g, "\n");
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: "ES256", kid: env("APNS_KEY_ID") })}.${b64({ iss: env("APNS_TEAM_ID"), iat })}`;
  const sig = createSign("SHA256").update(head).sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  apnsJwt = { token: `${head}.${sig}`, at: Date.now() };
  return apnsJwt.token;
}

const apnsReady = () => !!(env("APNS_KEY") && env("APNS_KEY_ID") && env("APNS_TEAM_ID"));

/** payload: { title, body, frame } */
export async function sendApns(sub, payload) {
  if (!apnsReady()) return "error";
  // Debug builds of the app get their tokens from Apple's sandbox
  const host = sub.sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const body = JSON.stringify({
    aps: { alert: { title: payload.title, body: payload.body }, sound: "default", "thread-id": payload.frame },
    frame: payload.frame,
  });
  return new Promise((resolve) => {
    let client;
    try {
      client = connect(host);
    } catch {
      return resolve("error");
    }
    const done = (r) => { client.close(); resolve(r); };
    client.on("error", () => done("error"));
    let req;
    try {
      req = client.request({
        ":method": "POST",
        ":path": `/3/device/${sub.token}`,
        authorization: `bearer ${apnsToken()}`,
        "apns-topic": env("APNS_TOPIC") || "art.domiframe.app",
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(Date.now() / 1000) + 6 * 3600),
        "content-type": "application/json",
      });
    } catch {
      return done("error");
    }
    let status = 0, reply = "";
    req.setTimeout(10e3, () => { req.close(); done("error"); });
    req.on("response", (h) => { status = h[":status"]; });
    req.on("data", (c) => { reply += c; });
    req.on("end", () => {
      if (status === 200) return done("ok");
      const reason = (() => { try { return JSON.parse(reply).reason; } catch { return ""; } })();
      done(status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" ? "gone" : "error");
    });
    req.on("error", () => done("error"));
    req.end(body);
  });
}

/** Send to one push address. */
export const sendTo = (sub, payload) => (sub.kind === "apns" ? sendApns(sub, payload) : Promise.resolve("gone"));
