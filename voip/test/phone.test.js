const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toE164, toNanpDigits } = require("../lib/phone");

test("normalizes bare 10-digit", () => {
  assert.equal(toE164("2505551234"), "+12505551234");
});

test("normalizes 11-digit with leading 1", () => {
  assert.equal(toE164("12505551234"), "+12505551234");
});

test("normalizes formatted numbers", () => {
  assert.equal(toE164("+1 (250) 555-1234"), "+12505551234");
  assert.equal(toE164("250-555-1234"), "+12505551234");
});

test("extracts number from CNAM angle format", () => {
  assert.equal(toE164("JANE DOE <2505551234>"), "+12505551234");
  assert.equal(toE164('"Kelowna BC" <12505551234>'), "+12505551234");
});

test("rejects garbage, anonymous, and non-NANP", () => {
  assert.equal(toE164("anonymous"), null);
  assert.equal(toE164(""), null);
  assert.equal(toE164(null), null);
  assert.equal(toE164(undefined), null);
  assert.equal(toE164("011442071234567"), null); // international
  assert.equal(toE164("911"), null);
  assert.equal(toE164("0505551234"), null); // NANP area codes can't start 0/1
  assert.equal(toE164("1105551234"), null);
});

test("toNanpDigits returns 10-digit national form", () => {
  assert.equal(toNanpDigits("+12505551234"), "2505551234");
  assert.equal(toNanpDigits("2505551234"), "2505551234");
  assert.equal(toNanpDigits("junk"), null);
});
