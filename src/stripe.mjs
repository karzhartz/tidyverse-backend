// Stripe: the Checkout Session we hand the customer, and the webhook that tells
// us what happened to it.
//
// The money rules live here, not in the route, so they can be tested without a
// network: how a booking becomes a Checkout Session, how a Stripe event becomes
// a payment_status/tx_meta update, and how fees and tax turn into net_amount.
//
// Idempotency: the booking reference *is* the Stripe idempotency key for the
// first Checkout Session. A retry of the same request returns that same session
// instead of charging twice. A later attempt (after an expiry) is keyed
// `<reference>:retry:<n>` so a genuinely new session is still possible.

import Stripe from "stripe";

/** Currencies Stripe treats as having no minor unit. */
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

/** Currencies with three decimal places. */
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

export function createStripeClient({ secretKey }) {
  return new Stripe(secretKey, {
    // No explicit apiVersion: the SDK uses the version it was built against,
    // which is pinned by the installed stripe package. Hardcoding a different
    // string here is how an upgrade turns into a runtime surprise.
    appInfo: { name: "wimak-service", version: "1.0.0" },
    maxNetworkRetries: 2,
    timeout: 20000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Money
// ─────────────────────────────────────────────────────────────────────────────

export function currencyExponent(currency) {
  const code = String(currency ?? "usd").toLowerCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** Major units (150.00) → Stripe minor units (15000). */
export function toMinorUnits(amount, currency = "usd") {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new TypeError(`Not an amount: ${amount}`);
  return Math.round(value * 10 ** currencyExponent(currency));
}

/** Stripe minor units (15000) → major units (150.00). */
export function fromMinorUnits(minor, currency = "usd") {
  const exponent = currencyExponent(currency);
  return Number((Number(minor) / 10 ** exponent).toFixed(exponent));
}

/**
 * The fee breakdown for one payment.
 *
 * `fees` is the total cost of the transaction, inclusive of tax, and
 * `net_amount` is what the business keeps: amount_paid - fees. Both are
 * derived here and in the database (net_amount is a generated column), from the
 * same two inputs, so they cannot drift.
 */
export function feeBreakdown({
  amountMinor,
  stripeFeeMinor = 0,
  taxMinor = 0,
  currency = "usd",
}) {
  const exponent = currencyExponent(currency);
  const amountPaid = fromMinorUnits(amountMinor ?? 0, currency);
  const stripeFee = fromMinorUnits(stripeFeeMinor ?? 0, currency);
  const tax = fromMinorUnits(taxMinor ?? 0, currency);
  const fees = Number((stripeFee + tax).toFixed(exponent));
  const net = Number((amountPaid - fees).toFixed(exponent));
  return { amountPaid, stripeFee, tax, fees, net, currency: String(currency).toLowerCase() };
}

/**
 * The Stripe idempotency key for a Checkout Session attempt.
 *
 * Attempt 1 is the booking reference itself, exactly as specified. Later
 * attempts must differ or Stripe would replay the expired session.
 */
export function checkoutIdempotencyKey(reference, attempt = 1) {
  const n = Number(attempt) || 1;
  return n <= 1 ? reference : `${reference}:retry:${n}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkout Session
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the Checkout Session parameters for a booking.
 *
 * `booking` is what public.begin_booking_checkout() returned: totals, customer,
 * service and schedule. Everything priced here comes from `booking.money.total`,
 * which the database calculated — never from the request body.
 */
export function buildCheckoutSessionParams(booking, {
  currency = "usd",
  successUrl,
  cancelUrl,
  taxRateId = null,
  automaticTax = false,
} = {}) {
  const reference = booking.reference;
  const total = booking.money?.total;
  if (total === undefined || total === null) {
    throw new TypeError(`Booking ${reference} has no total to charge`);
  }

  const fill = (url) => String(url).replaceAll("{REFERENCE}", encodeURIComponent(reference));
  const lineItem = {
    quantity: 1,
    price_data: {
      currency,
      unit_amount: toMinorUnits(total, currency),
      product_data: {
        name: `${booking.service?.title ?? "Service"} — ${reference}`,
        description: [booking.scheduledDate, booking.startTime]
          .filter(Boolean)
          .join(" at "),
      },
    },
    ...(taxRateId ? { tax_rates: [taxRateId] } : {}),
  };

  return {
    mode: "payment",
    client_reference_id: reference,
    customer_email: booking.customer?.email ?? undefined,
    line_items: [lineItem],
    metadata: {
      bookingId: booking.bookingId ?? "",
      bookingReference: reference,
      serviceId: booking.service?.id ?? "",
      scheduledDate: booking.scheduledDate ?? "",
    },
    payment_intent_data: {
      metadata: {
        bookingId: booking.bookingId ?? "",
        bookingReference: reference,
      },
      description: `${booking.service?.title ?? "Service"} — ${reference}`,
      ...(booking.customer?.email ? { receipt_email: booking.customer.email } : {}),
    },
    // Stripe substitutes {CHECKOUT_SESSION_ID}; we substitute {REFERENCE}.
    success_url: fill(successUrl),
    cancel_url: fill(cancelUrl),
    ...(automaticTax ? { automatic_tax: { enabled: true } } : {}),
  };
}

/** Create the session, idempotently for this booking attempt. */
export async function createCheckoutSession(stripe, booking, options) {
  const params = buildCheckoutSessionParams(booking, options);
  return stripe.checkout.sessions.create(params, {
    idempotencyKey: checkoutIdempotencyKey(booking.reference, booking.attempt),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook
// ─────────────────────────────────────────────────────────────────────────────

/** Verify a webhook came from Stripe. Throws on a bad or missing signature. */
export function constructWebhookEvent(stripe, rawBody, signature, webhookSecret) {
  if (!signature) throw new Error("Missing stripe-signature header");
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

/** Pull the charge and its balance transaction for fee data. */
export async function collectPaymentFacts(stripe, session) {
  let intent = session.payment_intent ?? null;
  if (typeof intent === "string") {
    intent = await stripe.paymentIntents.retrieve(intent, {
      expand: ["latest_charge.balance_transaction"],
    });
  }

  let charge = intent?.latest_charge ?? null;
  if (typeof charge === "string") {
    charge = await stripe.charges.retrieve(charge, {
      expand: ["balance_transaction"],
    });
  }

  let balance = charge?.balance_transaction ?? null;
  if (typeof balance === "string") {
    balance = await stripe.balanceTransactions.retrieve(balance);
  }

  return { intent, charge, balance };
}

/** Turn the Stripe objects into the flat facts the database and emails use. */
export function paymentFactsFromStripe({ session, intent, charge, balance, fallbackCurrency = "usd" }) {
  // A caller may hand us a fully-expanded session and nothing else, or the three
  // objects separately. Resolve whichever it is, so fee data is never missed
  // just because it arrived nested.
  const resolvedIntent =
    intent ?? (typeof session?.payment_intent === "object" ? session.payment_intent : null);
  const resolvedCharge =
    charge ?? (typeof resolvedIntent?.latest_charge === "object" ? resolvedIntent.latest_charge : null);
  const resolvedBalance =
    balance ?? (typeof resolvedCharge?.balance_transaction === "object" ? resolvedCharge.balance_transaction : null);

  const currency = String(
    resolvedBalance?.currency ?? session?.currency ?? fallbackCurrency
  ).toLowerCase();
  const amountMinor = resolvedBalance?.amount ?? session?.amount_total ?? 0;
  const stripeFeeMinor = resolvedBalance?.fee ?? 0;
  const taxMinor = session?.total_details?.amount_tax ?? 0;
  const money = feeBreakdown({ amountMinor, stripeFeeMinor, taxMinor, currency });

  const card = resolvedCharge?.payment_method_details?.card ?? null;
  const piId =
    typeof session?.payment_intent === "string"
      ? session.payment_intent
      : resolvedIntent?.id ?? null;

  return {
    ...money,
    checkoutSessionId: session?.id ?? null,
    paymentIntentId: piId,
    customerId:
      typeof session?.customer === "string"
        ? session.customer
        : session?.customer?.id ?? null,
    chargeId: resolvedCharge?.id ?? null,
    balanceTransactionId: resolvedBalance?.id ?? null,
    receiptUrl: resolvedCharge?.receipt_url ?? null,
    receiptNumber: resolvedCharge?.receipt_number ?? null,
    cardBrand: card?.brand ?? null,
    cardLast4: card?.last4 ?? null,
    paymentMethodType: resolvedCharge?.payment_method_details?.type ?? null,
    livemode: Boolean(session?.livemode),
  };
}

/** The tx_meta document: what the transaction cost and how it was paid. */
export function txMetaFromFacts(facts, { eventId, eventType, status }) {
  return {
    provider: "stripe",
    status,
    currency: facts.currency,
    sessionId: facts.checkoutSessionId,
    paymentIntentId: facts.paymentIntentId,
    chargeId: facts.chargeId,
    balanceTransactionId: facts.balanceTransactionId,
    amounts: {
      gross: facts.amountPaid,
      stripeFee: facts.stripeFee,
      tax: facts.tax,
      fees: facts.fees,
      net: facts.net,
    },
    card: facts.cardBrand
      ? { brand: facts.cardBrand, last4: facts.cardLast4 }
      : null,
    paymentMethodType: facts.paymentMethodType,
    receiptUrl: facts.receiptUrl,
    receiptNumber: facts.receiptNumber,
    livemode: facts.livemode,
    lastEvent: { id: eventId, type: eventType, at: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event → booking update
// ─────────────────────────────────────────────────────────────────────────────

function sessionIdentifiers(session) {
  return {
    reference: session?.client_reference_id || session?.metadata?.bookingReference || null,
    bookingId: session?.metadata?.bookingId || null,
  };
}

function intentIdentifiers(object) {
  const paymentIntentId =
    typeof object?.payment_intent === "string"
      ? object.payment_intent
      : object?.payment_intent?.id ?? (object?.object === "payment_intent" ? object.id : null);
  return {
    reference: object?.metadata?.bookingReference || null,
    bookingId: object?.metadata?.bookingId || null,
    paymentIntentId,
  };
}

async function paidUpdate(stripe, event, session, fallbackCurrency) {
  const { reference, bookingId } = sessionIdentifiers(session);
  if (!reference && !bookingId) return null;

  const { intent, charge, balance } = await collectPaymentFacts(stripe, session);
  const facts = paymentFactsFromStripe({ session, intent, charge, balance, fallbackCurrency });

  return {
    reference,
    bookingId,
    status: "paid",
    amountPaid: facts.amountPaid,
    fees: facts.fees,
    currency: facts.currency,
    checkoutSessionId: facts.checkoutSessionId,
    paymentIntentId: facts.paymentIntentId,
    customerId: facts.customerId,
    // event.created is when Stripe recorded it; a stable, replay-safe instant.
    paidAt: new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    txMeta: txMetaFromFacts(facts, { eventId: event.id, eventType: event.type, status: "paid" }),
  };
}

function statusUpdate(event, fields, status, extraMeta = {}) {
  return {
    ...fields,
    status,
    txMeta: {
      provider: "stripe",
      status,
      ...extraMeta,
      lastEvent: { id: event.id, type: event.type, at: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Translate a Stripe event into the argument public.apply_stripe_payment()
 * expects, or null when the event is not one we act on.
 */
export async function buildPaymentUpdate(stripe, event, { currency = "usd" } = {}) {
  const type = event?.type;
  const object = event?.data?.object ?? {};

  switch (type) {
    case "checkout.session.completed": {
      // For card payments the session is already paid. For delayed methods it
      // is `unpaid` now and `async_payment_succeeded` follows later.
      if (object.payment_status === "paid") {
        return paidUpdate(stripe, event, object, currency);
      }
      const ids = sessionIdentifiers(object);
      if (!ids.reference && !ids.bookingId) return null;
      return statusUpdate(
        event,
        {
          ...ids,
          checkoutSessionId: object.id ?? null,
          currency: object.currency ?? currency,
        },
        "pending",
        { sessionId: object.id ?? null, awaitingAsyncMethod: true }
      );
    }

    case "checkout.session.async_payment_succeeded":
      return paidUpdate(stripe, event, object, currency);

    case "checkout.session.async_payment_failed": {
      const ids = sessionIdentifiers(object);
      if (!ids.reference && !ids.bookingId) return null;
      return statusUpdate(event, { ...ids, checkoutSessionId: object.id ?? null }, "failed");
    }

    case "checkout.session.expired": {
      const ids = sessionIdentifiers(object);
      if (!ids.reference && !ids.bookingId) return null;
      return statusUpdate(event, { ...ids, checkoutSessionId: object.id ?? null }, "expired");
    }

    case "payment_intent.payment_failed": {
      const ids = intentIdentifiers(object);
      if (!ids.reference && !ids.bookingId && !ids.paymentIntentId) return null;
      return statusUpdate(
        event,
        { ...ids, currency: object.currency ?? currency },
        "failed",
        { failureMessage: object.last_payment_error?.message ?? null }
      );
    }

    case "charge.refunded": {
      const ids = intentIdentifiers(object);
      if (!ids.reference && !ids.bookingId && !ids.paymentIntentId) return null;

      const amountMinor = object.amount ?? 0;
      const refundedMinor = object.amount_refunded ?? 0;
      const refundCurrency = String(object.currency ?? currency).toLowerCase();
      const fully = amountMinor > 0 && refundedMinor >= amountMinor;

      return {
        // Match by payment intent when the charge carries no metadata; the
        // database resolves a booking from stripe_payment_intent_id too.
        ...ids,
        status: fully ? "refunded" : "partially_refunded",
        amountPaid: fromMinorUnits(Math.max(0, amountMinor - refundedMinor), refundCurrency),
        currency: refundCurrency,
        txMeta: {
          provider: "stripe",
          refund: {
            amount: fromMinorUnits(refundedMinor, refundCurrency),
            fully,
            chargeId: object.id ?? null,
          },
          lastEvent: { id: event.id, type: event.type, at: new Date().toISOString() },
          updatedAt: new Date().toISOString(),
        },
      };
    }

    case "charge.dispute.created": {
      const ids = intentIdentifiers(object);
      if (!ids.reference && !ids.bookingId && !ids.paymentIntentId) return null;
      return statusUpdate(event, ids, "disputed", {
        dispute: {
          reason: object.reason ?? null,
          status: object.status ?? null,
          amount: object.amount != null ? fromMinorUnits(object.amount, object.currency) : null,
        },
      });
    }

    default:
      return null;
  }
}
