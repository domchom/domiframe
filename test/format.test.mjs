import test from "node:test";
import assert from "node:assert/strict";
import { isLate } from "../web/format.js";

test("a frame is late once well past its check-in", () => {
  const seen = "2026-06-01T12:00:00Z", due = "2026-06-01T13:00:00Z"; // checks in hourly
  const at = (iso) => Date.parse(iso);
  assert.equal(isLate(seen, due, at("2026-06-01T13:10:00Z")), false, "a few minutes' drift");
  assert.equal(isLate(seen, due, at("2026-06-01T13:20:00Z")), true);
  // a week's sleep drifts more: 10% of it
  const weekDue = "2026-06-08T12:00:00Z";
  assert.equal(isLate(seen, weekDue, at("2026-06-08T22:00:00Z")), false);
  assert.equal(isLate(seen, weekDue, at("2026-06-09T06:00:00Z")), true);
  assert.equal(isLate(null, due, at("2026-06-09T00:00:00Z")), false, "never checked in isn't late");
});
