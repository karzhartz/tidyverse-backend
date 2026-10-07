// Presentation helpers shared by the emails and the API responses.
// Pure functions, so the tests need no network and no clock.

/** 150 → "$150.00". Falls back to a plain suffix for unknown currency codes. */
export function formatMoney(amount, currency = "usd") {
  const value = Number(amount ?? 0);
  const code = String(currency ?? "usd").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

/**
 * "2026-10-12" → "Monday, 12 October 2026".
 *
 * Parsed in UTC on purpose: a date-only booking is a calendar date, and letting
 * the server's timezone shift it is how a booking shows up a day early.
 */
export function formatDate(isoDate) {
  if (!isoDate) return "—";
  const date = new Date(`${String(isoDate).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(isoDate);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** "09:00" → "9:00 AM". Leaves anything unparseable alone. */
export function formatTime(hhmm) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? ""));
  if (!match) return hhmm ? String(hhmm) : "—";
  const hours = Number(match[1]);
  const minutes = match[2];
  const suffix = hours < 12 ? "AM" : "PM";
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${minutes} ${suffix}`;
}

export function formatDateTimeRange(date, start, end) {
  const from = `${formatDate(date)} at ${formatTime(start)}`;
  return end ? `${from} – ${formatTime(end)}` : from;
}

/** Escape a value for interpolation into HTML. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
