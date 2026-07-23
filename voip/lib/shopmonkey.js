// Minimal Shopmonkey v3 client for the voip module (text-back plan A).
// Verified against shopmonkey.dev 2026-07-19:
//   POST /v3/customer/phone_number/search  { phoneNumbers: [...] }
//   POST /v3/message { customerId, text, sendSms: true, phoneNumberId }
// Reuses the SM_API_KEY the check-in app already has on Railway — same
// precedence as server.js so a key rotation can't half-break the deploy
// (SHOPMONKEY_API_KEY accepted as fallback, per the handoff spec).

const { toE164, toNanpDigits } = require("./phone");

const BASE = "https://api.shopmonkey.cloud/v3";

function apiKey() {
  const key = (process.env.SM_API_KEY || process.env.SHOPMONKEY_API_KEY || "").trim();
  if (!key) throw new Error("SM_API_KEY / SHOPMONKEY_API_KEY is not set");
  return key;
}

async function sm(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopmonkey ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

// Returns { customerId, phoneNumberId, name } or null if no match.
// Phone-format expectations of the search endpoint are undocumented, so we
// send both E.164 and bare 10-digit forms.
async function findCustomerByPhone(number) {
  const e164 = toE164(number);
  if (!e164) return null;
  const forms = [e164, toNanpDigits(e164), "1" + toNanpDigits(e164)];
  const out = await sm("POST", "/customer/phone_number/search", { phoneNumbers: forms });
  const rows = (out && out.data) || [];
  if (!rows.length) return null;
  const c = rows[0];
  const phones = c.phoneNumbers || [];
  const match = phones.find((p) => toE164(p.number) === e164) || phones[0];
  const name = c.companyName ||
    [c.firstName, c.lastName].filter(Boolean).join(" ") || null;
  return {
    customerId: c.id,
    phoneNumberId: match ? match.id : undefined,
    name,
  };
}

// Sends an SMS through Shopmonkey so it lands in the native messaging inbox.
async function sendCustomerSms({ customerId, phoneNumberId, text }) {
  return sm("POST", "/message", {
    customerId,
    text,
    sendSms: true,
    sendEmail: false,
    ...(phoneNumberId ? { phoneNumberId } : {}),
  });
}

module.exports = { findCustomerByPhone, sendCustomerSms };
