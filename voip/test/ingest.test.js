const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mapCdrRow, parseCdrDate } = require("../jobs/ingest");

// Two locations sharing one VoIP.ms account (the multi-location case).
const CTX = {
  tzOffset: 0,
  didByNumber: new Map([
    ["+12505550100", { didId: 11, locationId: 1 }], // Kelowna gbp
    ["+12505550101", { didId: 12, locationId: 1 }], // Kelowna website
    ["+14035550200", { didId: 13, locationId: 2 }], // Red Deer main
  ]),
  subByName: new Map([
    ["123456_frontdesk", { subId: 21, locationId: 1 }],
    ["123456_bay", { subId: 22, locationId: 1 }],
    ["123456_reddeer", { subId: 23, locationId: 2 }],
  ]),
};

const BASE = {
  date: "2026-07-15 17:30:00",
  callerid: "JANE DOE <2508881234>",
  destination: "2505550100",
  description: "Kelowna GBP line",
  account: "123456",
  disposition: "ANSWERED",
  duration: "00:03:12",
  seconds: "192",
  uniqueid: "1752601800.123",
};

test("inbound answered call to a tracked DID", () => {
  const c = mapCdrRow(BASE, CTX);
  assert.equal(c.direction, "inbound");
  assert.equal(c.didId, 11);
  assert.equal(c.locationId, 1);
  assert.equal(c.callerNumber, "+12508881234");
  assert.equal(c.disposition, "answered");
  assert.equal(c.durationSec, 192);
  assert.equal(c.uniqueid, "1752601800.123");
  assert.equal(c.startedAt.toISOString(), "2026-07-15T17:30:00.000Z");
});

test("disposition normalization", () => {
  assert.equal(mapCdrRow({ ...BASE, disposition: "NO ANSWER" }, CTX).disposition, "no-answer");
  assert.equal(mapCdrRow({ ...BASE, disposition: "BUSY" }, CTX).disposition, "busy");
  assert.equal(mapCdrRow({ ...BASE, disposition: "FAILED" }, CTX).disposition, "failed");
  assert.equal(mapCdrRow({ ...BASE, disposition: "weird??" }, CTX).disposition, "failed");
});

test("voicemail detected from description routing text", () => {
  const c = mapCdrRow(
    { ...BASE, disposition: "ANSWERED", description: "Routing to Voicemail" }, CTX);
  assert.equal(c.disposition, "voicemail");
});

test("inbound routed sub-account extracted from description", () => {
  const c = mapCdrRow(
    { ...BASE, description: "Routing to sub-account: 123456_frontdesk" }, CTX);
  assert.equal(c.subAccountId, 21);
});

test("outbound call from a tracked sub-account", () => {
  const c = mapCdrRow({
    ...BASE,
    destination: "2508881234",       // external number, not one of our DIDs
    account: "123456_bay",
    callerid: "2505550100",
  }, CTX);
  assert.equal(c.direction, "outbound");
  assert.equal(c.subAccountId, 22);
  assert.equal(c.locationId, 1);
  assert.equal(c.callerNumber, "+12508881234"); // the external party
  assert.equal(c.didId, null);
});

test("cross-location call: inbound classification wins and picks the DID's location", () => {
  // Red Deer's handset calls Kelowna's GBP DID: this is Kelowna's inbound
  // call (and potentially Kelowna's missed-call alert), not Red Deer outbound.
  const c = mapCdrRow({
    ...BASE,
    destination: "2505550100",       // Kelowna DID
    account: "123456_reddeer",       // Red Deer sub-account
    disposition: "NO ANSWER",
  }, CTX);
  assert.equal(c.direction, "inbound");
  assert.equal(c.locationId, 1);     // Kelowna, not Red Deer
  assert.equal(c.didId, 11);
  assert.equal(c.disposition, "no-answer");
});

test("traffic that matches neither DIDs nor sub-accounts is skipped (legacy line safety)", () => {
  const c = mapCdrRow({
    ...BASE,
    destination: "2509999999",       // legacy Hwy 97 number — not tracked
    account: "someone_else",
  }, CTX);
  assert.equal(c, null);
});

test("rows without uniqueid or parseable date are skipped", () => {
  assert.equal(mapCdrRow({ ...BASE, uniqueid: "" }, CTX), null);
  assert.equal(mapCdrRow({ ...BASE, uniqueid: null }, CTX), null);
  assert.equal(mapCdrRow({ ...BASE, date: "not a date" }, CTX), null);
});

test("re-ingesting the same row maps identically (idempotency input)", () => {
  assert.deepEqual(mapCdrRow(BASE, CTX), mapCdrRow({ ...BASE }, CTX));
});

test("parseCdrDate honors the requested UTC offset", () => {
  assert.equal(parseCdrDate("2026-07-15 10:00:00", -7).toISOString(),
    "2026-07-15T17:00:00.000Z");
  assert.equal(parseCdrDate("2026-07-15 10:00:00", 0).toISOString(),
    "2026-07-15T10:00:00.000Z");
  assert.equal(parseCdrDate("garbage", 0), null);
});

test("anonymous caller on inbound keeps the call but nulls the number", () => {
  const c = mapCdrRow({ ...BASE, callerid: "Anonymous" }, CTX);
  assert.equal(c.direction, "inbound");
  assert.equal(c.callerNumber, null);
});
