#!/usr/bin/env node
// Idempotent config seeder. Usage: node voip/seed.js voip/seed.kelowna.json
// Upserts a location + its DIDs + sub-accounts from a JSON file, so adding a
// location (Penticton, Vernon, West Kelowna…) is a new JSON file, not code.
const fs = require("fs");
const { getPool } = require("./lib/db");
const { toE164 } = require("./lib/phone");

async function seed(file) {
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!cfg.name || !cfg.business_hours || !cfg.textback_template) {
    throw new Error("seed file needs: name, business_hours, textback_template");
  }
  const tz = cfg.timezone || "America/Vancouver";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`invalid IANA timezone: "${tz}"`);
  }
  if (cfg.textback_template.length > 160) {
    throw new Error(`textback_template is ${cfg.textback_template.length} chars; ` +
      "VoIP.ms rejects SMS over 160 — shorten it");
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const loc = await client.query(
      `INSERT INTO voip_locations (name, voipms_account, slack_channel, timezone,
                                   business_hours, textback_template, textback_enabled,
                                   voicemail_mailbox)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (name) DO UPDATE SET
         voipms_account=EXCLUDED.voipms_account, slack_channel=EXCLUDED.slack_channel,
         timezone=EXCLUDED.timezone, business_hours=EXCLUDED.business_hours,
         textback_template=EXCLUDED.textback_template,
         textback_enabled=EXCLUDED.textback_enabled,
         voicemail_mailbox=EXCLUDED.voicemail_mailbox
       RETURNING id`,
      [cfg.name, cfg.voipms_account || "main", cfg.slack_channel || "#marketing-metrics",
       cfg.timezone || "America/Vancouver", JSON.stringify(cfg.business_hours),
       cfg.textback_template, cfg.textback_enabled !== false,
       cfg.voicemail_mailbox || null]
    );
    const locationId = loc.rows[0].id;

    for (const d of cfg.dids || []) {
      const did = toE164(d.did);
      if (!did) throw new Error(`DID not a valid NANP number: ${d.did}`);
      await client.query(
        `INSERT INTO voip_dids (location_id, did, source_label, sms_enabled, active)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (did) DO UPDATE SET
           location_id=EXCLUDED.location_id, source_label=EXCLUDED.source_label,
           sms_enabled=EXCLUDED.sms_enabled, active=EXCLUDED.active`,
        [locationId, did, d.source_label || "main", !!d.sms_enabled, d.active !== false]);
    }

    for (const s of cfg.sub_accounts || []) {
      await client.query(
        `INSERT INTO voip_sub_accounts (location_id, voipms_subaccount, default_advisor)
         VALUES ($1,$2,$3)
         ON CONFLICT (voipms_subaccount) DO UPDATE SET
           location_id=EXCLUDED.location_id, default_advisor=EXCLUDED.default_advisor`,
        [locationId, s.voipms_subaccount, s.default_advisor || null]);
    }

    await client.query("COMMIT");
    console.log(`[voip] seeded location "${cfg.name}" (id ${locationId}): ` +
      `${(cfg.dids || []).length} DIDs, ${(cfg.sub_accounts || []).length} sub-accounts`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node voip/seed.js <seed-file.json>"); process.exit(1); }
  seed(file)
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { seed };
