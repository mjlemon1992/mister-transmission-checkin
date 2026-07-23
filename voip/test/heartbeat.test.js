const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ymdInTz } = require("../jobs/heartbeat");

test("ymdInTz formats the local calendar date", () => {
  // 2026-07-22 02:30 UTC = Jul 21 evening in Vancouver (PDT, UTC-7)
  assert.equal(ymdInTz(new Date("2026-07-22T02:30:00Z"), "America/Vancouver"),
    "2026-07-21");
  // Same instant is already Jul 22 in UTC
  assert.equal(ymdInTz(new Date("2026-07-22T02:30:00Z"), "UTC"), "2026-07-22");
});

test("ymdInTz falls back on an invalid timezone instead of throwing", () => {
  assert.equal(ymdInTz(new Date("2026-07-22T02:30:00Z"), "America/Kelowna"),
    "2026-07-21"); // Vancouver fallback
});
