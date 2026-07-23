# VoIP Call-Intelligence Module (Phase 1)

Call-intelligence pipeline on VoIP.ms for Mister Transmission Kelowna (Hwy 97
Transmissions integration). Lives entirely inside `voip/` — the only host-app
touchpoint is `server.js` calling `require("./voip").start(app)` behind
`VOIP_ENABLED=1`. The module (or just the recordings pipeline in Phase 2) can be
lifted into its own service later without surgery.

**What it does every cycle (default 15 min):**
1. Pulls CDRs from VoIP.ms (`getCDR`) once per distinct `voipms_account`
   (locations sharing an account share one pull) and classifies rows across
   all locations — idempotent on `uniqueid`, so re-runs/restarts never
   duplicate. Traffic matching no tracked DID or sub-account is skipped,
   which is what keeps the legacy Hwy 97 line out of these tables.
2. For each new missed inbound call on a business DID: transcribes the voicemail
   (if any), sends a CASL-guarded text-back (business hours only), and posts one
   Slack card to `#marketing-metrics`. One card per missed call, ever.

**Text-back routing (verified 2026-07-19):**
- Caller matches a Shopmonkey customer (`POST /v3/customer/phone_number/search`)
  → sent via Shopmonkey `POST /v3/message` with `sendSms: true` — the thread and
  any replies live in Shopmonkey's native messaging inbox (**plan A**).
- Unknown caller (lead) → VoIP.ms `sendSMS` from the DID they called; replies hit
  the `GET /voip/sms-callback` webhook and are posted to Slack (**plan B fallback**;
  Shopmonkey can't message a phone number that isn't a customer yet).

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `VOIP_ENABLED` | yes | `1` to start the module; anything else = check-in app runs untouched |
| `DATABASE_URL` | yes | Railway Postgres |
| `VOIPMS_USER` | yes | VoIP.ms account email |
| `VOIPMS_API_PASSWORD` | yes | portal → SOAP/REST API; enable API + IP whitelist first |
| `SLACK_WEBHOOK_MARKETING` | yes | incoming webhook bound to `#marketing-metrics` |
| `OPENAI_API_KEY` | for VM transcripts | Whisper |
| `SM_API_KEY` (or `SHOPMONKEY_API_KEY`) | for plan-A text-back | already set on Railway for /checkin |
| `VOIP_SMS_CALLBACK_SECRET` | yes (for plan-B replies) | shared secret for the inbound-SMS webhook — the endpoint ignores all traffic until it's set (fail closed) |
| `VOIP_CRON_MINUTES` | no (15) | poll interval |
| `VOIP_CDR_LOOKBACK_HOURS` | no (6) | per-cycle CDR window (overlap is safe; longer gaps → run a backfill) |
| `VOIP_CDR_TZ_PARAM` | no (0) | integer UTC offset sent to `getCDR` and used to parse returned timestamps — see go-live checks |
| `VOIP_TEXTBACK_MAX_AGE_MIN` | no (60) | never text a call that surfaced later than this |

## Setup / runbook

1. **Migrate:** `npm run voip:migrate` (uses `DATABASE_URL`; Railway: run as a
   one-off or pre-deploy command. Migrations are transactional and re-runnable.)
2. **Seed Kelowna:** edit `voip/seed.kelowna.json` (real DIDs, sub-account names,
   voicemail mailbox ID, confirmed store hours), then
   `npm run voip:seed voip/seed.kelowna.json`. Re-running updates in place.
3. **VoIP.ms portal:**
   - Main Menu → SOAP/REST API: enable, set API password, whitelist the caller IP.
     ⚠️ **Railway egress IPs are not static.** Options: VoIP.ms's allow-all IP
     setting (check portal), a Railway static-IP/proxy add-on, or run the module
     somewhere with a fixed IP. Watch logs for `ip_not_enabled` errors.
   - Per DID → SMS/MMS settings: confirm **SMS is enabled per DID**, and set the
     SMS URL Callback to
     `https://<app>/voip/sms-callback?secret=<VOIP_SMS_CALLBACK_SECRET>&to={TO}&from={FROM}&message={MESSAGE}&id={ID}&date={TIMESTAMP}`
     with "URL Callback Retry" on (endpoint answers literal `ok`).
4. **Set env vars, deploy, watch logs** for `[voip] cycle done`.
5. **Backfill (optional):** `node voip/backfill.js --from 2026-06-01`.
   Backfilled rows are inserted already-alerted (atomically, per row) — no
   Slack flood, no stale texts, and safe to run while the live cycle is up.

### ⚠️ Railway deploy caveat
Per the top-level README, the live Railway service currently deploys the
**`mister-transmission-form`** repo copy of the server. This module only ships if
Railway → mister-transmission-backend service → Settings → Source points back at
**this** repo. Do that before setting `VOIP_ENABLED=1`.

### Go-live checks (one test call each)
- **Timestamps:** make a test call, compare `voip_calls.started_at` (UTC) to the
  wall clock. If it's shifted, adjust `VOIP_CDR_TZ_PARAM` (VoIP.ms's timezone
  parameter semantics aren't publicly documented; 0 is assumed UTC).
- **Sub-account attribution:** answer a call on a handset and check
  `sub_account_id` landed (mapping reads "Routing to sub-account: X" from the CDR
  description; the `account` field's semantics on inbound legs are unverified).
- **Voicemail:** leave a test voicemail; confirm the Slack card carries the
  transcript. If logs show `no recognizable audio field`, the
  `getVoicemailMessageFile` response shape differs — fix `pickBase64Audio()` in
  `voip/lib/voicemail.js` (one function, logged keys tell you the real field).
- **Text-back:** miss a call from your cell during business hours; confirm the
  SMS arrives and `voip_sms_log` has the row (channel `shopmonkey` if your cell
  is a Shopmonkey customer, else `voipms`).

## Adding a location
Create `voip/seed.<city>.json` (copy Kelowna's), run `npm run voip:seed` with it.
Everything — DIDs, sub-accounts, hours, template, timezone, Slack channel — is
config. No code changes. (Slack currently posts through one webhook; per-location
channels become a webhook map when a second location goes live.)

## Adding a DID
Add it to the location's seed file and re-run the seeder (upserts in place), or
insert into `voip_dids` directly. Enable SMS on the DID in the VoIP.ms portal and
set its callback URL (step 3 above).

## CASL guardrails (all enforced in `voip/jobs/textback.js`)
- Only numbers that **just called us** are ever texted (implied consent), and
  only within `VOIP_TEXTBACK_MAX_AGE_MIN` of the call.
- Transactional template only — keep promotional copy out of
  `textback_template`. VoIP.ms sends are truncated at 160 chars.
- Every send logged in `voip_sms_log` with trigger `call_id` + timestamp.
- `voip_do_not_text` honored; inbound `STOP`/`ARRET` replies auto-add to it.
- Max one text per number per rolling 24h, across all channels.
- Business hours only (per-location, tz-aware) — checked at both call time
  and send time, so a 16:58 call never triggers a 17:40 text.
- A send is logged as `pending` before the API call and finalized after; a
  crash mid-send blocks retry (never risk a double text — a missed text is
  the lesser failure).

## Failure modes
| Symptom | Cause / fix |
|---|---|
| `VoIP.ms getCDR failed: ip_not_enabled` | caller IP not whitelisted (Railway egress rotated?) — fix whitelist strategy |
| No CDRs but calls happened | DIDs/sub-accounts in DB don't match VoIP.ms values — rows that match neither are skipped by design (that's the legacy-line guard) |
| Slack card missing | webhook failing → card retries next cycle (calls stay un-alerted until Slack accepts); check `SLACK_WEBHOOK_MARKETING` |
| Duplicate-looking Slack SMS-reply posts | VoIP.ms retries the callback every 30 min unless it got `ok` — check the endpoint is reachable |
| Text-back rows `status='failed'` in `voip_sms_log` | error column has the API response; VoIP.ms API SMS is capped at **100/day** account-wide |
| Cycle logs `previous cycle still running` | one slow cycle (big backfill, slow Whisper) — next tick catches up; persistent = investigate |
| Voicemail transcript missing | `voicemail_mailbox` not set for the location, VM outside INBOX, or caller-ID mismatch (fuzzy match window is ±15 min) |

## Planned next (Phase 1.5 — see PLAN-text-capture.md)
Text-first lead capture: automated first-contact auto-reply on tracked DIDs
+ a Slack reply bridge so staff answer leads from the Slack thread (SMS goes
out from the same DID the customer texted). Decided 2026-07-22; neither
blocks Phase 1 go-live.

## Phase 2 notes
`shopmonkey_customer_id` / `advisor_resolved` columns, `voip_recordings.r2_key`,
and `voip_transcripts.scoring` are already in the schema — Phase 2 (customer
matching, recording→scoring pipeline, revenue attribution, coaching digest, MCP
tools) is additive. Per the handoff: **Phase 2 starts only after Phase 1 has run
clean in production for at least a week.**
