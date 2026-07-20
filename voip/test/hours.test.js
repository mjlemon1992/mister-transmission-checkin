const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isOpen, parseHHMM } = require("../lib/hours");

const HOURS = {
  mon: { open: "08:00", close: "17:00" },
  tue: { open: "08:00", close: "17:00" },
  wed: { open: "08:00", close: "17:00" },
  thu: { open: "08:00", close: "17:00" },
  fri: { open: "08:00", close: "17:00" },
  sat: null,
  sun: null,
};
const TZ = "America/Vancouver";

// 2026-07-15 is a Wednesday. 10:00 PDT = 17:00 UTC.
test("open mid-morning on a weekday", () => {
  assert.equal(isOpen(HOURS, TZ, new Date("2026-07-15T17:00:00Z")), true);
});

test("closed before opening and after closing", () => {
  // 07:59 PDT
  assert.equal(isOpen(HOURS, TZ, new Date("2026-07-15T14:59:00Z")), false);
  // 17:00 PDT exactly — close is exclusive
  assert.equal(isOpen(HOURS, TZ, new Date("2026-07-16T00:00:00Z")), false);
  // 16:59 PDT
  assert.equal(isOpen(HOURS, TZ, new Date("2026-07-15T23:59:00Z")), true);
});

test("closed on null days (weekend)", () => {
  // Saturday 2026-07-18, 10:00 PDT
  assert.equal(isOpen(HOURS, TZ, new Date("2026-07-18T17:00:00Z")), false);
});

test("timezone matters: 08:30 PDT is open, same instant is 09:30 in Edmonton", () => {
  const d = new Date("2026-07-15T15:30:00Z"); // 08:30 PDT / 09:30 MDT
  assert.equal(isOpen(HOURS, TZ, d), true);
  assert.equal(isOpen(HOURS, "America/Edmonton", d), true);
  // 07:30 PDT / 08:30 MDT — open only in Edmonton
  const early = new Date("2026-07-15T14:30:00Z");
  assert.equal(isOpen(HOURS, TZ, early), false);
  assert.equal(isOpen(HOURS, "America/Edmonton", early), true);
});

test("DST boundary: PST in winter", () => {
  // 2026-01-14 is a Wednesday; 16:30 PST = 00:30 UTC next day
  assert.equal(isOpen(HOURS, TZ, new Date("2026-01-15T00:30:00Z")), true);
  // 17:30 PST = closed
  assert.equal(isOpen(HOURS, TZ, new Date("2026-01-15T01:30:00Z")), false);
});

test("malformed config is closed, never throws", () => {
  assert.equal(isOpen(null, TZ), false);
  assert.equal(isOpen({}, TZ), false);
  assert.equal(isOpen({ wed: { open: "junk", close: "17:00" } }, TZ,
    new Date("2026-07-15T17:00:00Z")), false);
});

test("parseHHMM", () => {
  assert.equal(parseHHMM("08:00"), 480);
  assert.equal(parseHHMM("8:00"), 480);
  assert.equal(parseHHMM("25:00"), null);
  assert.equal(parseHHMM(""), null);
});
