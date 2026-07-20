// Voicemail audio -> Whisper transcript for missed-call Slack cards.
//
// VoIP.ms voicemail is its own API family (NOT getCallRecordings):
//   getVoicemailMessages { mailbox, folder, date_from, date_to }
//   getVoicemailMessageFile { mailbox, folder, message_num }
// The message list has no CDR uniqueid, so we match a voicemail to its call
// by caller number + time proximity. Response field names for the audio
// payload vary by docs generation, so we probe the common shapes.

const db = require("./db");
const voipms = require("./voipms");
const whisper = require("./whisper");
const { toE164 } = require("./phone");

// Wide on purpose: getVoicemailMessages has no timezone request param (unlike
// getCDR), so its timestamps can be skewed from started_at by the account's
// tz offset. Caller-ID equality is the real matching key; time only breaks
// ties between messages from the same caller and rejects ancient ones.
const MATCH_WINDOW_HOURS = 26;

function pickBase64Audio(res) {
  // Observed/likely shapes: {message:{data}}, {data}, {file}, {message:{file}}
  const cands = [
    res && res.message && res.message.data,
    res && res.data,
    res && res.message && res.message.file,
    res && res.file,
  ];
  for (const c of cands) {
    if (typeof c === "string" && c.length > 100) return c;
  }
  return null;
}

// Returns transcript text or null. Never throws for "no voicemail found".
async function fetchVoicemailTranscript(call) {
  // Retry safety: if a previous cycle already transcribed this call, reuse it.
  const prior = await db.query(
    `SELECT t.text FROM voip_transcripts t
     JOIN voip_recordings r ON r.id = t.recording_id
     WHERE r.call_id = $1 ORDER BY t.id DESC LIMIT 1`, [call.id]);
  if (prior.rowCount > 0) return prior.rows[0].text;

  // voicemail_mailbox rides in on the missed-call query's location join.
  const mailbox = call.voicemail_mailbox;
  if (!mailbox) return null; // VM transcription not configured for location
  if (!call.caller_number) return null; // can't attribute a VM without caller ID

  const started = new Date(call.started_at);
  const dayBefore = new Date(started.getTime() - 86400_000);
  const dayAfter = new Date(started.getTime() + 86400_000);
  const list = await voipms.call("getVoicemailMessages", {
    mailbox,
    folder: "INBOX",
    date_from: dayBefore.toISOString().slice(0, 10),
    date_to: dayAfter.toISOString().slice(0, 10),
  }, { emptyStatuses: ["no_messages", "no_voicemail_messages", "no_messages_found"] });
  if (list.empty) return null;

  // Caller ID must match — never attach someone else's voicemail to this
  // call. Among same-caller messages, take the closest in time.
  const messages = list.messages || list.voicemail_messages || [];
  const match = messages
    .filter((m) => toE164(m.callerid) === call.caller_number)
    .map((m) => {
      const t = new Date(String(m.date || "").replace(" ", "T"));
      return { m, delta: isNaN(t) ? Infinity : Math.abs(t.getTime() - started.getTime()) };
    })
    .filter((x) => x.delta <= MATCH_WINDOW_HOURS * 3600_000)
    .sort((a, b) => a.delta - b.delta)
    .map((x) => x.m)[0];
  if (!match) return null;

  const file = await voipms.call("getVoicemailMessageFile", {
    mailbox,
    folder: match.folder || "INBOX",
    message_num: match.message_num,
  });
  const b64 = pickBase64Audio(file);
  if (!b64) {
    console.error("[voip] getVoicemailMessageFile returned no recognizable audio field; " +
      "keys: " + Object.keys(file || {}).join(","));
    return null;
  }

  const audio = Buffer.from(b64, "base64");
  const text = await whisper.transcribe(audio, "voicemail.mp3");
  if (!text) return null;

  const rec = await db.query(
    `INSERT INTO voip_recordings (call_id, voipms_recording_id, duration_sec)
     VALUES ($1,$2,$3)
     ON CONFLICT (voipms_recording_id) DO UPDATE SET call_id = EXCLUDED.call_id
     RETURNING id`,
    [call.id, `vm:${mailbox}:${match.message_num}:${match.date || ""}`,
     Number.isFinite(parseInt(match.duration, 10)) ? parseInt(match.duration, 10) : null]);
  await db.query(
    "INSERT INTO voip_transcripts (recording_id, text) VALUES ($1,$2)",
    [rec.rows[0].id, text]);
  return text;
}

module.exports = { fetchVoicemailTranscript };
