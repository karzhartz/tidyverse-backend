// Turning a booking into a Stripe Checkout Session.
//
// One place decides whether an existing session can be reused or a new one is
// needed, because that decision is what stops a customer being charged twice
// and what keeps the reference-as-idempotency-key promise honest.

import { HttpError } from "./errors.mjs";
import { beginCheckout, getBookingDetail } from "./bookings.mjs";
import { checkoutIdempotencyKey, createCheckoutSession } from "./stripe.mjs";

/** Retrieve a session, treating a Stripe hiccup as "no usable session". */
async function retrieveSession(stripe, sessionId, logger) {
  try {
    return await stripe.checkout.sessions.retrieve(sessionId);
  } catch (error) {
    logger?.warn("could not retrieve the existing checkout session", {
      sessionId,
      message: error.message,
    });
    return null;
  }
}

/**
 * Return a usable Checkout Session for a booking.
 *
 * Order matters:
 *   1. an already-paid booking is never charged again;
 *   2. an open session is reused, URL and all, so a refresh or a retry does not
 *      create a second chargeable session;
 *   3. only then is a new attempt claimed, keyed by the booking reference.
 */
export async function ensureCheckoutSession({ client, stripe, config, reference, logger }) {
  const detail = await getBookingDetail(client, reference);

  if (!detail) {
    throw new HttpError(404, `No booking with reference ${reference}.`, {
      code: "not_found",
    });
  }

  if (detail.paymentStatus === "paid") {
    return { detail, session: null, reused: false, alreadyPaid: true };
  }

  if (detail.checkoutSessionId) {
    const existing = await retrieveSession(stripe, detail.checkoutSessionId, logger);
    if (existing?.status === "open" && existing.url) {
      return { detail, session: existing, reused: true, alreadyPaid: false };
    }
  }

  const attemptDetail = await beginCheckout(client, reference);
  const session = await createCheckoutSession(stripe, attemptDetail, {
    currency: attemptDetail.currency || config.stripe.currency,
    successUrl: config.stripe.successUrl,
    cancelUrl: config.stripe.cancelUrl,
    taxRateId: config.stripe.taxRateId,
    automaticTax: config.stripe.automaticTax,
  });

  return {
    detail: attemptDetail,
    session,
    reused: false,
    alreadyPaid: false,
    idempotencyKey: checkoutIdempotencyKey(attemptDetail.reference, attemptDetail.attempt),
  };
}
