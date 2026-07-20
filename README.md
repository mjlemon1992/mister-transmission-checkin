# mister-transmission-checkin

Backend for the **Mister Transmission** iPad customer check-in ("booking") app.
*(Renamed 2026-06-25 from `mister-transmission-backend`.)*

## What's in this repo
- **`server.js`** — Express 4 server. Serves `public/index.html` at `/` and handles
  `POST /checkin` → creates a customer + vehicle + repair order in **Shopmonkey**.
- **`public/index.html`** — copy of the intake form.
- **`voip/`** — VoIP.ms call-intelligence module (missed-call Slack alerts +
  CASL-guarded SMS text-back). Opt-in via `VOIP_ENABLED=1`; see `voip/README.md`.

## ⚠️ Live deployment note
As of 2026-06-25 the live Railway backend service is deploying the **`mister-transmission-form`**
repo (which was given a copy of this server) — **not** this repo. This repo holds the
canonical backend code.

To make this repo the live one again:
Railway → **mister transmission booking** project → **mister-transmission-backend** service →
**Settings → Source** → select **`mister-transmission-backend`** (old name; GitHub redirects it
here) → **Deploy**.

## Environment
- `SM_API_KEY` — Shopmonkey JWT bearer token (set on Railway, not in code).

## Notes
- Express **4** only — Express 5 breaks wildcard routes.
- **Fleet** customers: do **not** send `firstName`/`lastName` to Shopmonkey — send
  `companyName` only.
