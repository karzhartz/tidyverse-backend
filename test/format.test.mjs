import test from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  formatDate,
  formatDateTimeRange,
  formatMoney,
  formatTime,
} from "../src/format.mjs";

test("formatMoney renders the booking currency", () => {
  assert.equal(formatMoney(150, "usd"), "$150.00");
  assert.equal(formatMoney(1234.5, "usd"), "$1,234.50");
  assert.equal(formatMoney(0, "usd"), "$0.00");
});

test("formatMoney handles a currency code Intl rejects", () => {
  // Intl accepts any three-letter code (ZZZ renders as "ZZZ 10.00"), so the
  // fallback is exercised with something it genuinely cannot parse.
  assert.equal(formatMoney(10, "NOPE"), "10.00 NOPE");
  assert.match(formatMoney(10, "zzz"), /10\.00/);
});

test("formatDate is a calendar date and does not drift with the timezone", () => {
  assert.equal(formatDate("2026-10-12"), "Monday, 12 October 2026");
  assert.equal(formatDate("2026-10-07"), "Wednesday, 7 October 2026");
  assert.equal(formatDate(""), "—");
  assert.equal(formatDate("nonsense"), "nonsense");
});

test("formatTime turns 24-hour times into readable ones", () => {
  assert.equal(formatTime("09:00"), "9:00 AM");
  assert.equal(formatTime("13:30"), "1:30 PM");
  assert.equal(formatTime("00:15"), "12:15 AM");
  assert.equal(formatTime("12:00"), "12:00 PM");
  assert.equal(formatTime(""), "—");
});

test("formatDateTimeRange joins the two", () => {
  assert.equal(
    formatDateTimeRange("2026-10-12", "09:00", "13:00"),
    "Monday, 12 October 2026 at 9:00 AM – 1:00 PM"
  );
});

test("escapeHtml neutralises markup", () => {
  assert.equal(
    escapeHtml(`<script>alert("x")</script> & 'y'`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;"
  );
  assert.equal(escapeHtml(null), "");
});
