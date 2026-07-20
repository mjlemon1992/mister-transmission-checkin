// CDR ingestion: poll VoIP.ms getCDR once per distinct VoIP.ms account,
// classify rows against EVERY location on that account, upsert into
// voip_calls. Idempotent via voip_calls.voipms_uniqueid — re-runs and
// overlapping windows never duplicate.
//
// VoIP.ms field notes (verified against docs/wrappers 2026-07-19):
//  - CDR rows: date ("YYYY-MM-DD HH:MM:SS"), callerid, destination,
//    description, account, disposition, duration, seconds, uniqueid
//  - There is NO direction field. Derived here: destination matches a
//    tracked DID -> inbound (wins, and decides the location); otherwise
//    account/description matches a tracked sub-account -> outbound from that
//    sub-account's location; matches neither -> not ours, skipped. That skip
//    is what keeps the legacy Hwy 97 line's traffic out of these tables.
//  - `timezone` request param is a required integer UTC offset; we parse the
//    returned timestamps at that same offset (VOIP_CDR_TZ_PARAM, default 0).
//    Verify once with a test call — see README "go-live checks".

const db = require("../lib/db");
const voipms = require("../lib/voipms");
const { toE164 } = require("../lib/phone");

// Steady-state window: a few cycles of overlap covers slow cycles and short
// outages. Longer gaps are a backfill (README).
const LOOKBACK_HOURS = Number(process.env.VOIP_CDR_LOOKBACK_HOURS || 6);

const DISPOSITIONS = {
  answered: "answered",
  "no answer": "no-answer",
  noanswer: "no-answer",
  busy: "busy",
  failed: "failed",
};

function parseCdrDate(s, offsetHours) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const sign = offsetHours < 0 ? "-" : "+";
  const abs = Math.abs(offsetHours);
  const hh = String(Math.trunc(abs)).padStart(2, "0");
  const mm = String(Math.round((abs % 1) * 60)).padStart(2, "0");
  const d = new Date(`${m[1]}T${m[2]}${sign}${hh}:${mm}`);
  return isNaN(d.getTime()) ? null : d;
}

// Translate one raw CDR row -> insertable call, or null if the row isn't
// tracked traffic / is unusable. Pure function; unit-tested.
// ctx.didByNumber: Map<E164, {didId, locationId}>
// ctx.subByName:   Map<subaccount, {subId, locationId}>
function mapCdrRow(row, ctx) {
  const uniqueid = row.uniqueid != null && String(row.uniqueid).trim() !== ""
    ? String(row.uniqueid) : null;
  if (!uniqueid) return null;

  const startedAt = parseCdrDate(row.date, ctx.tzOffset || 0);
  if (!startedAt) return null;

  const destE164 = toE164(row.destination);
  const did = destE164 ? ctx.didByNumber.get(destE164) : undefined;

  // Sub-account: `account` may carry it; for inbound, VoIP.ms puts routing in
  // description ("Routing to sub-account: NAME") — description wins.
  let sub = ctx.subByName.get(String(row.account || "")) || null;
  const routed = /sub-?account:?\s*([\w.-]+)/i.exec(String(row.description || ""));
  if (routed && ctx.subByName.has(routed[1])) sub = ctx.subByName.get(routed[1]);

  // Inbound classification wins: a call from one location's handset to
  // another location's DID is that DID's inbound call (and its missed-call
  // alert), not an outbound row for the dialing shop.
  let direction, callerNumber, locationId;
  if (did) {
    direction = "inbound";
    callerNumber = toE164(row.callerid);
    locationId = did.locationId;
  } else if (sub) {
    direction = "outbound";
    callerNumber = destE164; // the external party
    locationId = sub.locationId;
  } else {
    return null; // not tracked traffic (legacy line, unrelated DIDs)
  }

  let disposition = DISPOSITIONS[String(row.disposition || "").toLowerCase()] || "failed";
  // Voicemail shows as an answered call routed to voicemail.
  if (direction === "inbound" && /voicemail|voice mail/i.test(String(row.description || ""))) {
    disposition = "voicemail";
  }

  const seconds = parseInt(row.seconds, 10);
  return {
    uniqueid,
    locationId,
    direction,
    didId: did ? did.didId : null,
    callerNumber: callerNumber || null,
    subAccountId: sub ? sub.subId : null,
    startedAt,
    durationSec: Number.isFinite(seconds) ? seconds : null,
    disposition,
  };
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

// Build the classification maps for all locations sharing one VoIP.ms account.
async function buildAccountCtx(locationIds, tzOffset) {
  const dids = await db.query(
    `SELECT id, did, location_id FROM voip_dids
     WHERE active AND location_id = ANY($1)`, [locationIds]);
  const subs = await db.query(
    `SELECT id, voipms_subaccount, location_id FROM voip_sub_accounts
     WHERE location_id = ANY($1)`, [locationIds]);
  return {
    tzOffset,
    didByNumber: new Map(dids.rows.map((d) =>
      [d.did, { didId: d.id, locationId: d.location_id }])),
    subByName: new Map(subs.rows.map((s) =>
      [s.voipms_subaccount, { subId: s.id, locationId: s.location_id }])),
  };
}

// options.suppressAlerts: backfill mode — rows are born already-alerted so a
// historical import can never flood Slack or race the live cycle.
async function ingestAccount(account, locationIds, { dateFrom, dateTo, suppressAlerts } = {}) {
  const now = new Date();
  const from = dateFrom || ymd(new Date(now.getTime() - LOOKBACK_HOURS * 3600_000));
  const to = dateTo || ymd(now);
  const tzOffset = Number(process.env.VOIP_CDR_TZ_PARAM || 0);

  const ctx = await buildAccountCtx(locationIds, tzOffset);
  if (ctx.didByNumber.size === 0 && ctx.subByName.size === 0) return 0;

  const params = {
    date_from: from,
    date_to: to,
    timezone: tzOffset,
    answered: 1, noanswer: 1, busy: 1, failed: 1,
  };
  // 'main' = the whole top-level account (no filter). A location bound to a
  // specific VoIP.ms account/sub-account gets a filtered pull.
  if (account && account !== "main") params.account = account;

  const res = await voipms.call("getCDR", params, { emptyStatuses: ["no_cdr"] });
  if (res.empty) return 0;

  let upserts = 0;
  for (const raw of res.cdr || []) {
    const call = mapCdrRow(raw, ctx);
    if (!call) continue;
    const r = await db.query(
      `INSERT INTO voip_calls (location_id, voipms_uniqueid, direction, did_id,
         caller_number, sub_account_id, started_at, duration_sec, disposition,
         missed_alerted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $10 THEN now() END)
       ON CONFLICT (voipms_uniqueid) DO NOTHING`,
      [call.locationId, call.uniqueid, call.direction, call.didId,
       call.callerNumber, call.subAccountId, call.startedAt, call.durationSec,
       call.disposition, !!suppressAlerts]);
    upserts += r.rowCount;
  }
  return upserts;
}

async function ingestAllLocations(options) {
  const { rows: locations } = await db.query(
    "SELECT id, name, voipms_account FROM voip_locations");
  const byAccount = new Map();
  for (const loc of locations) {
    const acct = loc.voipms_account || "main";
    if (!byAccount.has(acct)) byAccount.set(acct, []);
    byAccount.get(acct).push(loc.id);
  }

  let total = 0;
  for (const [account, locationIds] of byAccount) {
    try {
      total += await ingestAccount(account, locationIds, options);
    } catch (err) {
      console.error(`[voip] CDR ingest failed for account "${account}":`, err.message);
    }
  }
  return total;
}

module.exports = { ingestAllLocations, ingestAccount, mapCdrRow, parseCdrDate };
