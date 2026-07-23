# Plan: Text-Capture Extensions (Phase 1.5)

Two additions on top of Phase 1, so the system captures **text-first leads**
(website click-to-text, Google listing) as well as missed calls, and so staff
have exactly one place to answer them. Decided 2026-07-22.

The resulting playbook rule these enable:
- **Leads → Slack.** Message #1 is automated; humans continue in the thread.
- **Customers → Shopmonkey.** Once a profile exists, texting moves there for good.

---

## A. First-contact auto-reply

When an SMS arrives on a tracked DID from a number that isn't a known
customer, the system replies immediately from that same DID and does the
detail-collecting before a human is even looking:

> "Thanks for texting Mister Transmission Hwy 97 — who are we speaking with,
> and what's the vehicle? We'll get right back to you."

### Rules
1. Fires on inbound SMS to any active tracked DID, 24/7 (it is a direct
   transactional response to a message the customer just sent — CASL-clean).
2. **Skip when the number matches a Shopmonkey customer** (lookup by phone).
   A known customer texting in gets a human response, not a who-are-you.
3. Skip when the number is on `voip_do_not_text` (STOP handling runs first,
   as in Phase 1).
4. **Max one auto-reply per number per 24h** — a lead who texts three times
   gets one auto-ask, not three.
5. Template is a per-location config value (`auto_reply_template`), ≤160
   chars. Optional later refinement: after-hours variant.
6. Every send logged like all other SMS.

### Build notes
- New table `voip_sms_inbound` (id, did_id, from_number E.164, body,
  `voipms_sms_id` UNIQUE, received_at, slack_channel, slack_thread_ts).
  Storing inbound texts is required for threading (feature B) and also fixes
  a known Phase 1 gap: VoIP.ms callback retries are currently not deduped —
  the unique `{ID}` param makes redelivery a no-op.
- `voip_sms_log` gains a `kind` column: `textback | auto_reply | manual`.
- `voip_locations` gains `auto_reply_template` (nullable = feature off for
  that location).
- Logic lives in the existing `/voip/sms-callback` handler: dedupe → STOP →
  store inbound → Slack post → auto-reply decision.

---

## B. Slack reply bridge

Staff reply to a lead by typing in the Slack thread; a bot sends it as an
SMS **from the same DID the customer texted**. Slack becomes the lead
texting console — no VoIP.ms portal, no number switching.

### Behavior
1. Inbound lead texts post to the configured channel (`#missed-calls`) as
   **bot messages** (not webhook posts), so each has a `thread_ts` the
   system remembers.
2. Follow-up texts from the same number within an active window append to
   the same thread — one conversation, one thread.
3. A staff reply in the thread → bridge looks up the thread's number + DID →
   `sendSMS` from that DID → on success adds ✅ to the reply (❌ + error
   message on failure, e.g. daily API cap hit).
4. Replies over 160 chars are split into segments (or sent via `sendMMS`).
5. `voip_do_not_text` is enforced on manual sends too — the bridge refuses
   with a visible ❌ and reason.
6. Bot ignores its own messages and non-thread channel chatter (loop/noise
   safety).
7. All manual sends logged (`kind = 'manual'`, with Slack user id in a
   `sent_by` column) — complete CASL + dispute audit trail.

### Build notes
- Requires a real Slack app instead of the incoming webhook: bot token,
  scopes `chat:write`, `channels:history`, `reactions:write`; Events API
  subscription (`message.channels`) pointed at a new
  `POST /voip/slack-events` route with Slack signing-secret verification.
- New env: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_SMS_CHANNEL`.
  `SLACK_WEBHOOK_MARKETING` stays for metrics-style posts.
- Thread state lives on `voip_sms_inbound` (channel + thread_ts); a thread
  is "active" for 7 days of inactivity, then a new text starts a new thread.
- Missed-call cards (Phase 1) move to the same bot + channel so voicemail
  alerts, text-backs, and lead threads all live in one place.

### Explicitly out of scope
- Replying to **Shopmonkey-matched customers** from Slack — their texting
  stays in Shopmonkey (system of record). The bridge is for leads only.
- Any AI-generated replies. Humans type; the only automation is feature A's
  single template message.

---

## Playbook (the human half)

1. Dedicated **`#missed-calls`** channel; owner-per-shift sets it to
   "All new messages" on mobile. One named owner at a time.
2. ✅ reaction on a card/thread = claimed.
3. Target: respond inside 5–10 minutes. **Call-first for leads** — text is
   the fallback, the bridge makes the fallback effortless.
4. The moment a lead's name is known: search Shopmonkey by phone (dedupe),
   create the customer (name + number is enough, vehicle when it surfaces),
   and continue any further texting from Shopmonkey.
5. VoIP.ms native SMS→email forward to the main shop account stays on as a
   passive audit/backup — nobody works from email.

## Sequencing & effort
- Feature A: small — one migration, template config, ~a day inside the
  existing callback handler, plus tests.
- Feature B: the real (still modest) build — Slack app setup + events
  endpoint + thread state + send path; est. 2–4 days including testing
  against a real workspace.
- Ship order: A can ship with Phase 1 (it makes the zero-bridge interim
  workable: auto-reply collects details, humans call). B follows as its own
  deploy. Neither blocks Phase 1 go-live.

## Acceptance checks
- Text a tracked DID from an unknown cell → auto-reply arrives in seconds;
  Slack thread appears; second text from same cell lands in same thread; no
  second auto-reply.
- Reply in the thread → SMS arrives on the cell from the same DID; ✅ on the
  Slack message; `voip_sms_log` row with kind='manual' and sent_by.
- Text STOP → do-not-text row created; bridge refuses subsequent manual
  sends with ❌; auto-reply suppressed.
- Text from a number that is a Shopmonkey customer → Slack card shows the
  match, no auto-reply sent.
- VoIP.ms callback redelivery of the same message id → no duplicate thread
  post.
