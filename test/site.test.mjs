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
