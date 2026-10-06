// Invite links (https://domiframe.art/f/<id>#k=<code>) as a rich link in Messages, Slack, WhatsApp...
// Those apps read the page's Open Graph tags; this names the frame in them and uses the invite card
// (web/og-invite.png, with the home page's photo in its frame). Only the frame ID goes in, as it's already in the link: the code is after the #,
// so it never reaches the server, and the frame's name isn't shown to anyone who only has its ID.
// No og:url either, or an app might open that instead of the link, and lose the code.
// scripts/local.mjs runs this too.

const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/; // as FrameCode.isValidID and web/code.js

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** upload.html -> the same page, with its preview tags for the frame `id`. */
export function invitePage(html, id) {
  if (!ID_RE.test(id)) return html;
  const tags = {
    "og:title": `Send pictures to the frame “${id}”`,
    "og:description": "You're invited to a DomiFrame, a color e-paper photo frame. Open the link to send it photos, or to add it in the DomiFrame app.",
    "og:image": "https://domiframe.art/og-invite.png",
    "og:image:alt": "An invite to a DomiFrame: the home page's photo of sea cliffs in a frame, and the words Send pictures to this frame",
  };
  for (const [name, value] of Object.entries(tags)) {
    html = html.replace(new RegExp(`(<meta property="${name}" content=")[^"]*(">)`), `$1${escape(value)}$2`);
  }
  return html.replace(/<title>[^<]*<\/title>/, `<title>${escape(id)} · DomiFrame</title>`);
}

export default async (req, context) => {
  const res = await context.next();
  if (!res.ok || !res.headers.get("content-type")?.includes("text/html")) return res;
  const id = new URL(req.url).pathname.split("/")[2] || ""; // invitePage leaves anything but a frame ID alone
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(invitePage(await res.text(), id), { status: res.status, headers });
};

export const config = { path: "/f/*" };
