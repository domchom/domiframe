// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("universal links: invite links open the iPhone app", async () => {
  const aasa = JSON.parse(await readFile(new URL("../web/.well-known/apple-app-site-association", import.meta.url), "utf8"));
  const [detail] = aasa.applinks.details;
  assert.deepEqual(detail.appIDs, ["2LY5UM4K8T.art.domiframe.app"]);
  assert.ok(detail.components.some((c) => c["/"] === "/f/*"), "invite links are /f/<id>#k=<code>");
  const toml = await readFile(new URL("../netlify.toml", import.meta.url), "utf8");
  assert.match(toml, /for = "\/\.well-known\/apple-app-site-association"[\s\S]*?Content-Type = "application\/json"/);
});

test("short links: every page links the app, and support anchors exist", async () => {
  const toml = await readFile(new URL("../netlify.toml", import.meta.url), "utf8");
  const links = Object.fromEntries([...toml.matchAll(/from = "(\/[\w-]+)"\s*\n\s*to = "(.*)"\s*\n\s*status = 302/g)].map(([, f, t]) => [f, t]));
  // The App Store, or the home page's app section until the app is live
  assert.match(links["/app"], /^(https:\/\/apps\.apple\.com\/|\/#app$)/);
  if (links["/app"] === "/#app") {
    assert.match(await readFile(new URL("../web/index.html", import.meta.url), "utf8"), /id="app"/);
  }
  const support = await readFile(new URL("../web/support.html", import.meta.url), "utf8");
  for (const to of Object.values(links)) {
    const anchor = to.match(/^\/support\.html#(.+)$/)?.[1];
    if (anchor) assert.match(support, new RegExp(`id="${anchor}"`), `support.html has #${anchor}`);
  }
  for (const page of ["index", "support", "privacy", "terms", "upload"]) {
    const html = await readFile(new URL(`../web/${page}.html`, import.meta.url), "utf8");
    assert.match(html, /href="\/app"/, `${page}.html links the app`);
  }
});
