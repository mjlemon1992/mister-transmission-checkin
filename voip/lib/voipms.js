// VoIP.ms REST client. Generic call() plus per-call empty-status allowlists.
// API: https://voip.ms/m/apidocs.php — every request is
// GET https://voip.ms/api/v1/rest.php?api_username=..&api_password=..&method=..
// The account email + API password must have API access enabled AND the
// caller's IP whitelisted in the VoIP.ms portal (Railway egress IP).

const API_URL = "https://voip.ms/api/v1/rest.php";

function creds() {
  const user = process.env.VOIPMS_USER;
  const pass = process.env.VOIPMS_API_PASSWORD;
  if (!user || !pass) throw new Error("VOIPMS_USER / VOIPMS_API_PASSWORD not set");
  return { api_username: user, api_password: pass };
}

// Small courtesy delay between calls; VoIP.ms asks integrators to be polite.
let lastCall = 0;
const MIN_GAP_MS = 500;

// emptyStatuses: statuses that mean "no rows", not failure — ONLY for read
// methods. A write like sendSMS must treat every non-success status as an
// error ("no_credit"/"no_did" are real failures, not empty results).
async function call(method, params = {}, { emptyStatuses = [] } = {}) {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  const qs = new URLSearchParams({ ...creds(), method, ...params });
  const res = await fetch(`${API_URL}?${qs}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`VoIP.ms HTTP ${res.status} for ${method}`);
  const json = await res.json();
  if (json.status !== "success") {
    if (emptyStatuses.includes(json.status)) return { status: json.status, empty: true };
    throw new Error(`VoIP.ms ${method} failed: ${json.status}`);
  }
  return json;
}

module.exports = { call };
