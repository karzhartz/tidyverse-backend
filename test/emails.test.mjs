import test from "node:test";
import assert from "node:assert/strict";

import { bookingReceivedEmail, paymentReceivedEmail } from "../src/emails.mjs";

const booking = {
  bookingId: "b1",
  reference: "WTC-ABC123",
  status: "pending",
  paymentStatus: "unpaid",
  amountPaid: 0,
  currency: "usd",
  customer: { name: "Amara Okafor", email: "amara@example.com" },
  service: { id: "deep-cleaning", title: "Deep Cleaning" },
  scheduledDate: "2026-10-12",
  startTime: "09:00",
  endTime: "13:00",
  address: "12 Riverside Drive",
  frequency: "one_off",
  addOns: [{ label: "Oven clean", price: 30 }],
  money: { basePrice: 120, addOnTotal: 30, subtotal: 150, discount: 0, total: 150 },
};

const paidBooking = {
  ...booking,
  paymentStatus: "paid",
  amountPaid: 150,
  paidAt: "2026-10-07T10:00:00.000Z",
  paymentIntentId: "pi_test_1",
  txMeta: {
    receiptUrl: "https://pay.stripe.com/receipts/1",
    card: { brand: "visa", last4: "4242" },
  },
};

// ── Booking received ─────────────────────────────────────────────────────────

test("the booking email carries the reference, the job, and the pay link", () => {
  const email = bookingReceivedEmail({
    booking,
    checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_1",
    siteUrl: "https://wimaktotalcare.com",
  });

  assert.match(email.subject, /WTC-ABC123/);
  assert.match(email.html, /WTC-ABC123/);
  assert.match(email.html, /Deep Cleaning/);
  assert.match(email.html, /Monday, 12 October 2026/);
  assert.match(email.html, /9:00 AM/);
  assert.match(email.html, /12 Riverside Drive/);
  assert.match(email.html, /\$150\.00/);
  assert.match(email.html, /https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_1/);

  // The plain-text alternative says the same things.
  assert.match(email.text, /WTC-ABC123/);
  assert.match(email.text, /Monday, 12 October 2026/);
  assert.match(email.text, /Complete payment: https:\/\/checkout\.stripe\.com/);
});

test("the booking email degrades when there is no checkout link", () => {
  const email = bookingReceivedEmail({ booking, checkoutUrl: null });
  assert.doesNotMatch(email.html, /Complete payment</);
  assert.match(email.text, /We will be in touch to arrange payment/);
});

test("customer-supplied text is escaped into the HTML", () => {
  const nasty = {
    ...booking,
    customer: { name: "<script>alert(1)</script>", email: "x@y.co" },
    address: "<img src=x onerror=alert(1)>",
  };
  const email = bookingReceivedEmail({ booking: nasty, checkoutUrl: null });
  assert.doesNotMatch(email.html, /<script>alert\(1\)<\/script>/);
  assert.match(email.html, /&lt;script&gt;/);
  assert.doesNotMatch(email.html, /<img src=x/);
});

// ── Payment received ─────────────────────────────────────────────────────────

test("the receipt email carries the confirmation, the transaction and the date", () => {
  const email = paymentReceivedEmail({ booking: paidBooking, siteUrl: "https://wimaktotalcare.com" });

  assert.match(email.subject, /Payment received/);
  assert.match(email.subject, /WTC-ABC123/);

  // Booking detail.
  assert.match(email.html, /Monday, 12 October 2026/);
  assert.match(email.html, /Deep Cleaning/);
  assert.match(email.html, /12 Riverside Drive/);

  // Transaction detail.
  assert.match(email.html, /\$150\.00/);
  assert.match(email.html, /VISA ending 4242/);
  assert.match(email.html, /pi_test_1/);
  assert.match(email.html, /https:\/\/pay\.stripe\.com\/receipts\/1/);
  assert.match(email.html, /Wednesday, 7 October 2026/);

  assert.match(email.text, /Payment received — booking WTC-ABC123 is confirmed/);
  assert.match(email.text, /Amount paid\s+\$150\.00/);
  assert.match(email.text, /Transaction\s+pi_test_1/);
  assert.match(email.text, /Receipt: https:\/\/pay\.stripe\.com\/receipts\/1/);
});

test("the receipt email works without card or receipt detail", () => {
  const email = paymentReceivedEmail({
    booking: { ...paidBooking, txMeta: {} },
  });
  assert.doesNotMatch(email.html, /Paid with/);
  assert.doesNotMatch(email.html, /Stripe receipt/);
  assert.match(email.html, /\$150\.00/);
});

test("the receipt email personalises with the first name only", () => {
  const email = paymentReceivedEmail({ booking: paidBooking });
  assert.match(email.html, /Hi Amara,/);
  assert.doesNotMatch(email.html, /Hi Amara Okafor,/);
});
