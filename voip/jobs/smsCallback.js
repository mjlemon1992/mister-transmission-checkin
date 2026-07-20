// Inbound SMS webhook for plan-B threads (leads texted from a VoIP.ms DID).
// VoIP.ms "SMS URL Callback" (set per-DID in the portal) fires a GET like:
//   {URL}?to={TO}&from={FROM}&message={MESSAGE}&id={ID}&date={TIMESTAMP}
// Point it at:  https://<railway-app>/voip/sms-callback?secret=<VOIP_SMS_CALLBACK_SECRET>
// Replies from Shopmonkey-matched customers don't come here — they land in
// Shopmonkey's own inbox (plan A).

const db = require("../lib/db");
const { postSlack } = require("../lib/slack");
const { toE164 } = require("../lib/phone");

function registerSmsCallback(app) {
  app.get("/voip/sms-callback", async (req, res) => {
    // Always answer "ok" fast — VoIP.ms retries/disables noisy callbacks.
    res.type("text").send("ok");

    try {
      // Fail closed: without a configured secret this endpoint would let
      // anyone forge STOP entries or spam the Slack channel.
      const secret = process.env.VOIP_SMS_CALLBACK_SECRET;
      if (!secret) {
        console.error("[voip] sms-callback hit but VOIP_SMS_CALLBACK_SECRET is unset — ignoring");
        return;
      }
      if (req.query.secret !== secret) {
        console.error("[voip] sms-callback: bad secret, ignoring");
        return;
      }
      const from = toE164(req.query.from) || String(req.query.from || "unknown");
      const to = toE164(req.query.to) || String(req.query.to || "unknown");
      const message = String(req.query.message || "").slice(0, 1600);
      if (!message) return;

      // CASL opt-out FIRST — it must stick even if the Slack post fails.
      if (/^\s*(stop|unsubscribe|arret|arrêt)\b/i.test(message)) {
        await db.query(
          `INSERT INTO voip_do_not_text (number, reason)
           VALUES ($1, 'replied STOP') ON CONFLICT (number) DO NOTHING`, [from]);
      }

      const did = await db.query(
        `SELECT d.did, d.source_label, l.name AS location_name
         FROM voip_dids d JOIN voip_locations l ON l.id = d.location_id
         WHERE d.did = $1`, [to]);
      const loc = did.rows[0];

      await postSlack(
        [
          { type: "header", text: { type: "plain_text", text: "💬 SMS reply", emoji: true } },
          { type: "section", text: { type: "mrkdwn", text:
            `*From:* ${from}\n*To:* ${to}${loc ? ` (${loc.source_label}, ${loc.location_name})` : ""}\n>${message.replace(/\n/g, "\n>")}` } },
          { type: "context", elements: [{ type: "mrkdwn", text:
            "Lead reply on a tracking number — respond by calling or texting from the shop line." }] },
        ],
        `SMS reply from ${from}: ${message.slice(0, 100)}`
      );
    } catch (err) {
      console.error("[voip] sms-callback error:", err.message);
    }
  });
}

module.exports = { registerSmsCallback };
