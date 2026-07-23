// Daily heartbeat: one Slack card per location each morning with yesterday's
// numbers. Doubles as a liveness check — "no card by 8am" means the pipeline
// is broken, which otherwise looks identical to a quiet phone day.

const db = require("../lib/db");
const { postSlack } = require("../lib/slack");
const { localParts } = require("../lib/hours");

const POST_AFTER_HOUR = 7; // local shop time

// "2026-07-21" for a Date in an IANA timezone (en-CA formats as YYYY-MM-DD).
function ymdInTz(date, timezone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(date);
  }
}

async function postHeartbeats() {
  const { rows: locations } = await db.query(
    "SELECT id, name, timezone FROM voip_locations");
  let posted = 0;

  for (const loc of locations) {
    try {
      const now = new Date();
      const { minutes } = localParts(now, loc.timezone);
      if (minutes < POST_AFTER_HOUR * 60) continue; // too early locally

      const yesterday = ymdInTz(new Date(now.getTime() - 86400_000), loc.timezone);

      // Claim the (location, day) slot first; DO NOTHING = already posted.
      const claim = await db.query(
        `INSERT INTO voip_heartbeats (location_id, day) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`, [loc.id, yesterday]);
      if (claim.rowCount === 0) continue;

      const calls = await db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
                count(*) FILTER (WHERE is_missed)::int AS missed,
                count(*) FILTER (WHERE disposition = 'voicemail')::int AS voicemails
         FROM voip_calls
         WHERE location_id = $1 AND (started_at AT TIME ZONE $2)::date = $3::date`,
        [loc.id, loc.timezone, yesterday]);
      const sms = await db.query(
        `SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent,
                count(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM voip_sms_log
         WHERE location_id = $1 AND (sent_at AT TIME ZONE $2)::date = $3::date`,
        [loc.id, loc.timezone, yesterday]);

      const c = calls.rows[0];
      const s = sms.rows[0];
      const line =
        `*${c.total}* calls (${c.inbound} in) · *${c.missed}* missed · ` +
        `${c.voicemails} voicemail${c.voicemails === 1 ? "" : "s"} · ` +
        `*${s.sent}* text-back${s.sent === 1 ? "" : "s"}` +
        (s.failed ? ` · ⚠️ ${s.failed} failed` : "");

      try {
        await postSlack(
          [{ type: "context", elements: [{ type: "mrkdwn",
              text: `📊 *${loc.name}* — ${yesterday}: ${line}` }] }],
          `${loc.name} ${yesterday}: ${c.total} calls, ${c.missed} missed, ${s.sent} text-backs`);
        posted++;
      } catch (err) {
        // Release the claim so the next cycle retries the post.
        await db.query(
          "DELETE FROM voip_heartbeats WHERE location_id = $1 AND day = $2",
          [loc.id, yesterday]);
        throw err;
      }
    } catch (err) {
      console.error(`[voip] heartbeat failed for "${loc.name}":`, err.message);
    }
  }
  return posted;
}

module.exports = { postHeartbeats, ymdInTz };
