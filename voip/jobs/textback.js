// Missed-call SMS text-back with CASL guardrails.
//
// CASL position (hard requirements from the spec):
//  - implied consent only: we ONLY text a number that just called us
//  - transactional content only — the template must never carry promo copy
//  - every send logged with timestamp + trigger call id (voip_sms_log)
//  - do_not_text list honored
//  - never text the same number more than once per 24h
//  - only during the location's configured business hours — checked at BOTH
//    call time and send time (a 16:58 call must not trigger a 17:40 text)
//
// Send idempotency: a 'pending' voip_sms_log row is written BEFORE the send
// and updated after. If we crash mid-send, the pending row blocks any retry
// (never risk a double text; a missed text is the lesser failure). The 24h
// guard counts both 'sent' and 'pending' rows for the same reason.
//
// Channel routing (locked decision 4 + verified 2026-07-19):
//  - Caller matches a Shopmonkey customer -> POST /v3/message sendSms:true
//    (thread lands in Shopmonkey's native inbox — plan A)
//  - Unknown caller (lead) -> VoIP.ms sendSMS from the DID they called
//    (plan B fallback; replies arrive via the inbound-SMS callback -> Slack)

const db = require("../lib/db");
const voipms = require("../lib/voipms");
const shopmonkey = require("../lib/shopmonkey");
const { isOpen } = require("../lib/hours");
const { toNanpDigits } = require("../lib/phone");

// call: row from the missed-call query (includes location + DID config).
// Returns a short note for the Slack card, e.g. "💬 Text-back sent (Shopmonkey)".
async function maybeTextBack(call) {
  if (!call.textback_enabled) return null;
  if (call.textback_sms_id) return null;              // already sent for this call
  if (!call.caller_number) return "⚠️ No caller ID — no text-back";
  if (!call.did_sms_enabled) return null;             // DID can't send SMS

  const now = new Date();
  if (!isOpen(call.business_hours, call.timezone, new Date(call.started_at)) ||
      !isOpen(call.business_hours, call.timezone, now)) {
    return null; // after-hours (at call OR send time) — no text, per spec
  }

  // Freshness guard: text-back is a "we just missed you" message. A call that
  // surfaced late (downtime, backfill) must never trigger a stale text.
  const maxAgeMin = Number(process.env.VOIP_TEXTBACK_MAX_AGE_MIN || 60);
  if (now.getTime() - new Date(call.started_at).getTime() > maxAgeMin * 60_000) {
    return "⏱ Call surfaced too late — no text-back";
  }

  const dnt = await db.query(
    "SELECT 1 FROM voip_do_not_text WHERE number = $1", [call.caller_number]);
  if (dnt.rowCount > 0) return "🚫 On do-not-text list — no text-back";

  const recent = await db.query(
    `SELECT 1 FROM voip_sms_log
     WHERE to_number = $1 AND status IN ('sent','pending')
       AND sent_at > now() - interval '24 hours'`,
    [call.caller_number]);
  if (recent.rowCount > 0) return "⏱ Already texted in last 24h — no text-back";

  const body = call.textback_template;

  // Decide the channel, then log BEFORE sending (see idempotency note above).
  const customer = await shopmonkey.findCustomerByPhone(call.caller_number)
    .catch((e) => { console.error("[voip] SM lookup failed:", e.message); return null; });
  const channel = customer ? "shopmonkey" : "voipms";

  const log = await db.query(
    `INSERT INTO voip_sms_log (call_id, location_id, to_number, body, channel, status)
     VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
    [call.id, call.location_id, call.caller_number, body, channel]);
  const smsId = log.rows[0].id;

  let error = null;
  try {
    if (customer) {
      await shopmonkey.sendCustomerSms({
        customerId: customer.customerId,
        phoneNumberId: customer.phoneNumberId,
        text: body,
      });
    } else {
      // VoIP.ms hard-rejects SMS over 160 chars ("it will not be sent").
      const sms = body.length > 160 ? body.slice(0, 157) + "..." : body;
      if (sms !== body) {
        console.error(`[voip] textback_template for location ${call.location_id} ` +
          `exceeds 160 chars; truncated for VoIP.ms send`);
      }
      await voipms.call("sendSMS", {
        did: toNanpDigits(call.did),
        dst: toNanpDigits(call.caller_number),
        message: sms,
      });
    }
  } catch (err) {
    error = err.message.slice(0, 500);
  }

  await db.query(
    "UPDATE voip_sms_log SET status = $2, error = $3 WHERE id = $1",
    [smsId, error ? "failed" : "sent", error]);

  if (!error) {
    await db.query(
      "UPDATE voip_calls SET textback_sms_id = $2 WHERE id = $1", [call.id, smsId]);
    return channel === "shopmonkey"
      ? "💬 Text-back sent — thread in Shopmonkey inbox"
      : "💬 Text-back sent from tracking number (replies → Slack)";
  }
  console.error(`[voip] text-back failed for call ${call.id}:`, error);
  return "⚠️ Text-back FAILED — see logs";
}

module.exports = { maybeTextBack };
