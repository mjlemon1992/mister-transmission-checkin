// Slack alerts via incoming webhook (SLACK_WEBHOOK_MARKETING).
// The webhook is bound to #marketing-metrics; locations.slack_channel is
// carried in config so a future per-location webhook/channel map is a config
// change, not a code change.

async function postSlack(blocks, fallbackText) {
  const url = process.env.SLACK_WEBHOOK_MARKETING;
  if (!url) throw new Error("SLACK_WEBHOOK_MARKETING is not set");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: fallbackText, blocks }),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
  }
}

function fmtLocalTime(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "America/Vancouver",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

// Missed-call card. call: joined row (see jobs/missed.js). transcript: string|null.
function missedCallBlocks(call, transcript) {
  const caller = call.caller_number || "Unknown caller";
  const when = fmtLocalTime(new Date(call.started_at), call.timezone);
  const source = call.source_label
    ? `${call.did} (${call.source_label})`
    : call.did || "unknown DID";
  const kind = call.disposition === "voicemail" ? "Voicemail" : "Missed call";

  // Phase 2 adds a "*Customer:*" line here once Shopmonkey matching enriches
  // the call row (spec 2.1).
  const lines = [
    `*Caller:* ${caller}`,
    `*Line:* ${source}`,
    `*Location:* ${call.location_name}`,
    `*Time:* ${when}`,
    `*Result:* ${call.disposition}`,
  ];

  const blocks = [
    { type: "header", text: { type: "plain_text", text: `📞 ${kind} — ${call.location_name}`, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
  ];
  if (transcript) {
    const trimmed = transcript.length > 2500 ? transcript.slice(0, 2500) + "…" : transcript;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Voicemail:*\n>${trimmed.replace(/\n/g, "\n>")}` } });
  }
  if (call.textback_note) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: call.textback_note }] });
  }
  return { blocks, fallback: `${kind}: ${caller} → ${source} (${call.location_name}) at ${when}` };
}

module.exports = { postSlack, missedCallBlocks, fmtLocalTime };
