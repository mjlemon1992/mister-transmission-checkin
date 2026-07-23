// Business-hours check, timezone-aware without any date library.
// business_hours jsonb: {"mon":{"open":"08:00","close":"17:00"},...,"sun":null}
// A null/missing day means closed. Times are local to the location's timezone.

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Returns {dayKey, minutes} for `date` in `timezone` using Intl (no deps).
// An invalid IANA name in config must degrade, not throw — a throwing
// isOpen() would put every missed call at that location into a permanent
// retry loop with no Slack card ever posted.
function localParts(date, timezone) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch (err) {
    console.error(`[voip] invalid timezone "${timezone}" — falling back to America/Vancouver`);
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Vancouver",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const dayKey = parts.weekday.toLowerCase().slice(0, 3);
  // "24" can appear for midnight in some ICU versions
  const hour = Number(parts.hour) % 24;
  return { dayKey, minutes: hour * 60 + Number(parts.minute) };
}

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins <= 24 * 60 ? mins : null;
}

// businessHours: parsed jsonb object. date: JS Date (defaults to now).
function isOpen(businessHours, timezone, date = new Date()) {
  if (!businessHours || typeof businessHours !== "object") return false;
  const { dayKey, minutes } = localParts(date, timezone || "America/Vancouver");
  if (!DAY_KEYS.includes(dayKey)) return false;
  const day = businessHours[dayKey];
  if (!day) return false; // null or absent = closed
  const open = parseHHMM(day.open);
  const close = parseHHMM(day.close);
  if (open == null || close == null) return false;
  return minutes >= open && minutes < close;
}

module.exports = { isOpen, localParts, parseHHMM, DAY_KEYS };
