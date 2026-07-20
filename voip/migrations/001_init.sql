-- VoIP call-intelligence module — initial schema (Phase 1).
-- Every table carries location_id: Kelowna is location #1, but Penticton /
-- Vernon / West Kelowna must be addable as config rows, never code changes.

CREATE TABLE voip_locations (
  id serial PRIMARY KEY,
  name text UNIQUE NOT NULL,
  -- VoIP.ms main account or the account whose CDRs cover this location's DIDs
  voipms_account text NOT NULL DEFAULT 'main',
  slack_channel text NOT NULL DEFAULT '#marketing-metrics',
  timezone text NOT NULL DEFAULT 'America/Vancouver',
  -- {"mon":{"open":"08:00","close":"17:00"},...,"sun":null} — null day = closed
  business_hours jsonb NOT NULL,
  textback_template text NOT NULL,
  textback_enabled bool NOT NULL DEFAULT true,
  voicemail_mailbox text,               -- VoIP.ms mailbox ID; null = skip VM transcription
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voip_dids (
  id serial PRIMARY KEY,
  location_id int NOT NULL REFERENCES voip_locations(id),
  did text UNIQUE NOT NULL,             -- E.164, e.g. +12505551234
  source_label text NOT NULL,           -- 'gbp' | 'website' | 'facebook' | 'main'
  sms_enabled bool NOT NULL DEFAULT false, -- SMS is per-DID on VoIP.ms; verify in portal
  active bool NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voip_sub_accounts (
  id serial PRIMARY KEY,
  location_id int NOT NULL REFERENCES voip_locations(id),
  voipms_subaccount text UNIQUE NOT NULL, -- e.g. '123456_frontdesk'
  default_advisor text,                   -- nullable; shared handsets stay null
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voip_calls (
  id bigserial PRIMARY KEY,
  location_id int NOT NULL REFERENCES voip_locations(id),
  voipms_uniqueid text UNIQUE NOT NULL,   -- idempotency key from CDR
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  did_id int REFERENCES voip_dids(id),
  caller_number text,                     -- E.164
  sub_account_id int REFERENCES voip_sub_accounts(id),
  started_at timestamptz NOT NULL,
  duration_sec int,
  disposition text NOT NULL,              -- answered|no-answer|busy|failed|voicemail
  is_missed bool GENERATED ALWAYS AS
    (direction = 'inbound' AND disposition IN ('no-answer','voicemail','busy')) STORED,
  -- Alert/text-back state — these make dedupe survive restarts ("one alert per
  -- missed call, ever").
  missed_alerted_at timestamptz,
  textback_sms_id bigint,                 -- FK added after voip_sms_log exists
  -- Phase 2 (columns reserved so Phase 2 is additive, not a rewrite)
  shopmonkey_customer_id text,
  advisor_resolved text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX voip_calls_started_at_idx ON voip_calls (started_at);
CREATE INDEX voip_calls_missed_unalerted_idx ON voip_calls (id)
  WHERE is_missed AND missed_alerted_at IS NULL;
CREATE INDEX voip_calls_caller_idx ON voip_calls (caller_number);

CREATE TABLE voip_recordings (
  id bigserial PRIMARY KEY,
  call_id bigint NOT NULL REFERENCES voip_calls(id),
  voipms_recording_id text UNIQUE,        -- idempotency for recording pulls
  r2_key text,                            -- Phase 2; Phase 1 voicemails may skip R2
  duration_sec int,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voip_transcripts (
  id bigserial PRIMARY KEY,
  recording_id bigint NOT NULL REFERENCES voip_recordings(id),
  text text NOT NULL,
  scoring jsonb,                          -- Phase 2 structured output
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE voip_sms_log (
  id bigserial PRIMARY KEY,
  call_id bigint REFERENCES voip_calls(id), -- trigger call (CASL audit trail)
  location_id int REFERENCES voip_locations(id),
  to_number text NOT NULL,                -- E.164
  body text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('shopmonkey','voipms')),
  status text NOT NULL DEFAULT 'sent',    -- sent|failed
  error text,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX voip_sms_log_number_time_idx ON voip_sms_log (to_number, sent_at);

ALTER TABLE voip_calls
  ADD CONSTRAINT voip_calls_textback_sms_fk
  FOREIGN KEY (textback_sms_id) REFERENCES voip_sms_log(id);

CREATE TABLE voip_do_not_text (
  number text PRIMARY KEY,                -- E.164
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
