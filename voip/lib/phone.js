// E.164 normalization for North American numbers (all locations are BC/AB).
// VoIP.ms CDRs return caller IDs in mixed formats: "2505551234",
// "12505551234", "Name <2505551234>", "+1 250 555 1234".

// Returns "+1XXXXXXXXXX" or null if the input isn't a usable NANP number
// (anonymous/blocked callers, international oddities, SIP URIs).
function toE164(raw) {
  if (raw == null) return null;
  let s = String(raw);
  const angle = s.match(/<([^>]*)>/); // "Jane Doe <2505551234>"
  if (angle) s = angle[1];
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10 && digits[0] !== "0" && digits[0] !== "1") {
    return "+1" + digits;
  }
  if (digits.length === 11 && digits[0] === "1" &&
      digits[1] !== "0" && digits[1] !== "1") {
    return "+" + digits;
  }
  return null;
}

// 10-digit national form, for APIs (VoIP.ms sendSMS dst) that reject "+1".
function toNanpDigits(e164) {
  const n = toE164(e164);
  return n ? n.slice(2) : null;
}

module.exports = { toE164, toNanpDigits };
