// Missed-call pipeline: for every missed, un-alerted inbound call —
//   1. voicemail? fetch audio + transcribe (best-effort)
//   2. attempt CASL-guarded text-back (business hours only)
//   3. post ONE Slack card (dedupe survives restarts via missed_alerted_at)

const db = require("../lib/db");
const { postSlack, missedCallBlocks } = require("../lib/slack");
const { maybeTextBack } = require("./textback");
const { fetchVoicemailTranscript } = require("../lib/voicemail");

const MAX_PER_CYCLE = 50; // backfill safety: don't flood Slack on first run

async function processMissedCalls() {
  const { rows } = await db.query(
    `SELECT c.*, d.did, d.source_label, d.sms_enabled AS did_sms_enabled,
            l.name AS location_name, l.timezone, l.business_hours,
            l.textback_template, l.textback_enabled, l.voicemail_mailbox
     FROM voip_calls c
     JOIN voip_locations l ON l.id = c.location_id
     LEFT JOIN voip_dids d ON d.id = c.did_id
     WHERE c.is_missed AND c.missed_alerted_at IS NULL
     ORDER BY c.started_at
     LIMIT ${MAX_PER_CYCLE + 1}`);

  const overflow = rows.length > MAX_PER_CYCLE;
  const batch = overflow ? rows.slice(0, MAX_PER_CYCLE) : rows;

  let processed = 0;
  for (const call of batch) {
    try {
      let transcript = null;
      if (call.disposition === "voicemail") {
        transcript = await fetchVoicemailTranscript(call)
          .catch((e) => { console.error(`[voip] voicemail fetch failed for call ${call.id}:`, e.message); return null; });
      }

      call.textback_note = await maybeTextBack(call);

      const { blocks, fallback } = missedCallBlocks(call, transcript);
      await postSlack(blocks, fallback);

      // Only mark alerted after Slack accepted the card — a crash before this
      // point means the card is retried next cycle, never lost.
      await db.query(
        "UPDATE voip_calls SET missed_alerted_at = now() WHERE id = $1", [call.id]);
      processed++;
    } catch (err) {
      console.error(`[voip] missed-call processing failed for call ${call.id}:`, err.message);
      // leave un-alerted; next cycle retries (text-back is idempotent via
      // textback_sms_id + the 24h rule, so no double-texting on retry)
    }
  }

  if (overflow) {
    console.log(`[voip] more than ${MAX_PER_CYCLE} pending missed calls; continuing next cycle`);
  }
  return processed;
}

module.exports = { processMissedCalls };
