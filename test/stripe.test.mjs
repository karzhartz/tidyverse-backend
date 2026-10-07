import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCheckoutSessionParams,
  buildPaymentUpdate,
  checkoutIdempotencyKey,
  currencyExponent,
  feeBreakdown,
  fromMinorUnits,
  paymentFactsFromStripe,
  toMinorUnits,
  txMetaFromFacts,
} from "../src/stripe.mjs";

// ── Money ────────────────────────────────────────────────────────────────────

test("currencyExponent knows zero- and three-decimal currencies", () => {
  assert.equal(currencyExponent("usd"), 2);
  assert.equal(currencyExponent("EUR"), 2);
  assert.equal(currencyExponent("jpy"), 0);
  assert.equal(currencyExponent("kwd"), 3);
  assert.equal(currencyExponent(undefined), 2);
});

test("toMinorUnits converts major units the way Stripe expects", () => {
  assert.equal(toMinorUnits(150, "usd"), 15000);
  assert.equal(toMinorUnits(12.34, "usd"), 1234);
  assert.equal(toMinorUnits(150, "jpy"), 150);
  assert.equal(toMinorUnits("49.99", "usd"), 4999);
});

test("fromMinorUnits is the inverse", () => {
  assert.equal(fromMinorUnits(15000, "usd"), 150);
  assert.equal(fromMinorUnits(1234, "usd"), 12.34);
  assert.equal(fromMinorUnits(150, "jpy"), 150);
});

test("toMinorUnits refuses a non-numeric amount", () => {
  assert.throws(() => toMinorUnits("not money", "usd"), TypeError);
});

test("feeBreakdown is Stripe fee + tax, with net derived", () => {
  const fees = feeBreakdown({
    amountMinor: 15000,
    stripeFeeMinor: 465,
    taxMinor: 270,
    currency: "usd",
  });

  assert.deepEqual(fees, {
    amountPaid: 150,
    stripeFee: 4.65,
    tax: 2.7,
    fees: 7.35,
    net: 142.65,
    currency: "usd",
  });
});

test("feeBreakdown tolerates missing fee and tax", () => {
  const fees = feeBreakdown({ amountMinor: 10000, currency: "usd" });
  assert.equal(fees.fees, 0);
  assert.equal(fees.net, 100);
});

// ── Idempotency ──────────────────────────────────────────────────────────────

test("the first attempt is keyed by the booking reference itself", () => {
  assert.equal(checkoutIdempotencyKey("WTC-ABC123"), "WTC-ABC123");
  assert.equal(checkoutIdempotencyKey("WTC-ABC123", 1), "WTC-ABC123");
});

test("later attempts get a distinct key so a new session is possible", () => {
  assert.equal(checkoutIdempotencyKey("WTC-ABC123", 2), "WTC-ABC123:retry:2");
  assert.notEqual(checkoutIdempotencyKey("WTC-ABC123", 2), checkoutIdempotencyKey("WTC-ABC123", 1));
});

// ── Checkout Session parameters ──────────────────────────────────────────────

const detailFixture = {
  bookingId: "b1",
  reference: "WTC-ABC123",
  attempt: 1,
  currency: "usd",
  customer: { name: "Amara Okafor", email: "amara@example.com" },
  service: { id: "deep-cleaning", title: "Deep Cleaning" },
  scheduledDate: "2026-10-12",
  startTime: "09:00",
  money: { total: 150 },
};

test("a booking becomes a one-off line item priced from the database total", () => {
  const params = buildCheckoutSessionParams(detailFixture, {
    currency: "usd",
    successUrl: "https://site.test/confirmed?reference={REFERENCE}&session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://site.test/confirmed?reference={REFERENCE}&checkout=cancelled",
  });

  assert.equal(params.mode, "payment");
  assert.equal(params.client_reference_id, "WTC-ABC123");
  assert.equal(params.customer_email, "amara@example.com");
  assert.equal(params.line_items.length, 1);
  assert.equal(params.line_items[0].price_data.unit_amount, 15000);
  assert.equal(params.line_items[0].price_data.currency, "usd");
  assert.match(params.line_items[0].price_data.product_data.name, /Deep Cleaning/);
  assert.equal(params.metadata.bookingReference, "WTC-ABC123");
  assert.equal(params.payment_intent_data.metadata.bookingId, "b1");

  // {REFERENCE} is ours to fill; {CHECKOUT_SESSION_ID} is Stripe's to fill.
  assert.equal(
    params.success_url,
    "https://site.test/confirmed?reference=WTC-ABC123&session_id={CHECKOUT_SESSION_ID}"
  );
  assert.ok(params.cancel_url.includes("reference=WTC-ABC123"));
});

test("a tax rate is attached only when configured", () => {
  const withTax = buildCheckoutSessionParams(detailFixture, {
    successUrl: "https://x.test/{REFERENCE}",
    cancelUrl: "https://x.test/{REFERENCE}",
    taxRateId: "txr_123",
  });
  assert.deepEqual(withTax.line_items[0].tax_rates, ["txr_123"]);

  const withoutTax = buildCheckoutSessionParams(detailFixture, {
    successUrl: "https://x.test/{REFERENCE}",
    cancelUrl: "https://x.test/{REFERENCE}",
  });
  assert.equal(withoutTax.line_items[0].tax_rates, undefined);
});

test("automatic tax is opt-in", () => {
  const params = buildCheckoutSessionParams(detailFixture, {
    successUrl: "https://x.test/{REFERENCE}",
    cancelUrl: "https://x.test/{REFERENCE}",
    automaticTax: true,
  });
  assert.deepEqual(params.automatic_tax, { enabled: true });
});

test("a booking with no total is refused rather than charged zero", () => {
  assert.throws(
    () =>
      buildCheckoutSessionParams(
        { ...detailFixture, money: {} },
        { successUrl: "https://x.test", cancelUrl: "https://x.test" }
      ),
    TypeError
  );
});

// ── Facts from a fully-expanded session ──────────────────────────────────────

const expandedSession = {
  id: "cs_test_1",
  object: "checkout.session",
  payment_status: "paid",
  client_reference_id: "WTC-ABC123",
  currency: "usd",
  amount_total: 15000,
  total_details: { amount_tax: 270 },
  livemode: false,
  payment_intent: {
    id: "pi_test_1",
    latest_charge: {
      id: "ch_test_1",
      amount: 15000,
      amount_refunded: 0,
      currency: "usd",
      receipt_url: "https://pay.stripe.com/receipts/1",
      receipt_number: "1234-5678",
      payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
      balance_transaction: { id: "txn_test_1", amount: 15000, fee: 465, net: 14535, currency: "usd" },
    },
  },
};

test("payment facts flatten Stripe's objects into the figures we store", () => {
  const facts = paymentFactsFromStripe({ session: expandedSession });

  assert.equal(facts.amountPaid, 150);
  assert.equal(facts.stripeFee, 4.65);
  assert.equal(facts.tax, 2.7);
  assert.equal(facts.fees, 7.35);
  assert.equal(facts.net, 142.65);
  assert.equal(facts.cardBrand, "visa");
  assert.equal(facts.cardLast4, "4242");
  assert.equal(facts.receiptUrl, "https://pay.stripe.com/receipts/1");
  assert.equal(facts.paymentIntentId, "pi_test_1");
  assert.equal(facts.balanceTransactionId, "txn_test_1");
});

test("tx_meta carries the transaction detail the requirement asks for", () => {
  const facts = paymentFactsFromStripe({ session: expandedSession });
  const meta = txMetaFromFacts(facts, {
    eventId: "evt_1",
    eventType: "checkout.session.completed",
    status: "paid",
  });

  assert.equal(meta.provider, "stripe");
  assert.equal(meta.amounts.stripeFee, 4.65);
  assert.equal(meta.amounts.tax, 2.7);
  assert.equal(meta.amounts.fees, 7.35);
  assert.equal(meta.amounts.net, 142.65);
  assert.deepEqual(meta.card, { brand: "visa", last4: "4242" });
  assert.equal(meta.lastEvent.id, "evt_1");
});

// ── Event → booking update ───────────────────────────────────────────────────
// These branches do not touch the network: the session arrives fully expanded,
// or the event carries no fee data at all.

test("a paid Checkout Session becomes a paid, fully-costed update", async () => {
  const update = await buildPaymentUpdate(
    {},
    { id: "evt_1", type: "checkout.session.completed", created: 1700000000, data: { object: expandedSession } }
  );

  assert.equal(update.status, "paid");
  assert.equal(update.reference, "WTC-ABC123");
  assert.equal(update.amountPaid, 150);
  assert.equal(update.fees, 7.35);
  assert.equal(update.paidAt, "2023-11-14T22:13:20.000Z");
  assert.equal(update.txMeta.amounts.net, 142.65);
});

test("an unpaid completed session is pending, not paid", async () => {
  const update = await buildPaymentUpdate(
    {},
    {
      id: "evt_2",
      type: "checkout.session.completed",
      data: { object: { ...expandedSession, payment_status: "unpaid" } },
    }
  );
  assert.equal(update.status, "pending");
  assert.equal(update.checkoutSessionId, "cs_test_1");
});

test("an expired session is recorded as expired", async () => {
  const update = await buildPaymentUpdate(
    {},
    {
      id: "evt_3",
      type: "checkout.session.expired",
      data: { object: { id: "cs_test_1", client_reference_id: "WTC-ABC123" } },
    }
  );
  assert.equal(update.status, "expired");
  assert.equal(update.reference, "WTC-ABC123");
});

test("a failed payment intent is recorded as failed with the reason", async () => {
  const update = await buildPaymentUpdate(
    {},
    {
      id: "evt_4",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          object: "payment_intent",
          id: "pi_test_1",
          currency: "usd",
          metadata: { bookingReference: "WTC-ABC123" },
          last_payment_error: { message: "Your card was declined." },
        },
      },
    }
  );
  assert.equal(update.status, "failed");
  assert.equal(update.txMeta.failureMessage, "Your card was declined.");
});

test("a full refund resolves the booking through the payment intent", async () => {
  const update = await buildPaymentUpdate(
    {},
    {
      id: "evt_5",
      type: "charge.refunded",
      data: {
        object: {
          object: "charge",
          id: "ch_test_1",
          payment_intent: "pi_test_1",
          amount: 15000,
          amount_refunded: 15000,
          currency: "usd",
        },
      },
    }
  );

  assert.equal(update.status, "refunded");
  assert.equal(update.paymentIntentId, "pi_test_1");
  assert.equal(update.amountPaid, 0);
  assert.equal(update.txMeta.refund.fully, true);
  // No reference: the database matches on stripe_payment_intent_id.
  assert.equal(update.reference, null);
});

test("a partial refund is named as such", async () => {
  const update = await buildPaymentUpdate(
    {},
    {
      id: "evt_6",
      type: "charge.refunded",
      data: {
        object: {
          object: "charge",
          id: "ch_test_1",
          payment_intent: "pi_test_1",
          amount: 15000,
          amount_refunded: 5000,
          currency: "usd",
        },
      },
    }
  );
  assert.equal(update.status, "partially_refunded");
  assert.equal(update.amountPaid, 100);
});

test("a dispute is recorded", async () => {
  const update = await buildPaymentUpdate(
    {},
    {
      id: "evt_7",
      type: "charge.dispute.created",
      data: {
        object: {
          object: "dispute",
          payment_intent: "pi_test_1",
          reason: "fraudulent",
          status: "needs_response",
          amount: 15000,
          currency: "usd",
        },
      },
    }
  );
  assert.equal(update.status, "disputed");
  assert.equal(update.txMeta.dispute.reason, "fraudulent");
});

test("unrelated events are ignored", async () => {
  for (const type of ["customer.created", "invoice.paid", "ping", "payment_intent.succeeded"]) {
    const update = await buildPaymentUpdate({}, { id: "evt_x", type, data: { object: {} } });
    assert.equal(update, null, `${type} should be ignored`);
  }
});

test("a session event with no reference and no booking id is ignored", async () => {
  const update = await buildPaymentUpdate(
    {},
    { id: "evt_8", type: "checkout.session.expired", data: { object: { id: "cs_orphan" } } }
  );
  assert.equal(update, null);
});
