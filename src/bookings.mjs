// Booking access. Everything goes through the SECURITY DEFINER functions in
// the payments migration, so the server never writes the payment columns
// directly and the money logic stays in one place.

import { HttpError } from "./errors.mjs";
import { normalizeReference } from "./booking-payload.mjs";

/** Turn a PostgREST/SQLSTATE error into an HTTP error with a useful body. */
function mapRpcError(error, action) {
  const code = error?.code;
  const message = error?.message ?? String(error);

  if (code === "23514" || code === "check_violation") {
    return new HttpError(400, message, { code: "validation_error" });
  }
  if (code === "P0002" || code === "no_data_found") {
    return new HttpError(404, message, { code: "not_found" });
  }
  if (code === "23505" || code === "unique_violation") {
    return new HttpError(409, message, { code: "conflict" });
  }
  return new HttpError(502, `Could not ${action}: ${message}`, {
    code: "database_error",
    details: { sqlstate: code },
  });
}

/** Create a booking. The database validates and prices it. */
export async function createBooking(client, payload) {
  // The quoted variant is create_public_booking() plus the funnel-aware price:
  // bedrooms, bathrooms, property/scope/finish, sizes and extras are all priced
  // server-side from the catalogue config, and the result is stored on the
  // booking so Stripe charges exactly what the customer was quoted.
  const { data, error } = await client.rpc("create_public_booking_quoted", { payload });
  if (error) throw mapRpcError(error, "create the booking");
  return data;
}

/** Claim the next Checkout Session attempt and read the full booking detail. */
export async function beginCheckout(client, reference) {
  const { data, error } = await client.rpc("begin_booking_checkout", {
    p_reference: normalizeReference(reference),
  });
  if (error) throw mapRpcError(error, "start a checkout for the booking");
  return data;
}

/** Full booking detail (customer, service, money, payment state) or null. */
export async function getBookingDetail(client, reference) {
  const { data, error } = await client.rpc("get_booking_detail", {
    p_reference: normalizeReference(reference),
  });
  if (error) throw mapRpcError(error, "read the booking");
  return data ?? null;
}

/** The only writer of the payment columns. Idempotent on `payload.eventId`. */
export async function applyPayment(client, payload) {
  const { data, error } = await client.rpc("apply_stripe_payment", { payload });
  if (error) throw mapRpcError(error, "record the payment");
  return data;
}

/** Stamp an email as delivered. The first call wins. */
export async function markEmailSent(client, reference, kind) {
  const { data, error } = await client.rpc("mark_booking_email_sent", {
    p_reference: normalizeReference(reference),
    p_kind: kind,
  });
  if (error) throw mapRpcError(error, "record the email");
  return data;
}

/**
 * The booking as the customer and the website may see it.
 *
 * `fees`, `net_amount` and the raw `tx_meta` are internal accounting and are
 * deliberately left out — the customer gets their receipt details, not the
 * business's margin.
 */
export function toPublicBooking(detail) {
  if (!detail) return null;

  const meta = detail.txMeta ?? {};
  const hasReceipt = Boolean(meta.receiptUrl || meta.receiptNumber || meta.card);

  return {
    bookingId: detail.bookingId,
    reference: detail.reference,
    status: detail.status,
    paymentStatus: detail.paymentStatus,
    amountPaid: detail.amountPaid,
    currency: detail.currency,
    paidAt: detail.paidAt,
    scheduledDate: detail.scheduledDate,
    startTime: detail.startTime,
    endTime: detail.endTime,
    frequency: detail.frequency,
    address: detail.address,
    teamSize: detail.teamSize,
    customer: detail.customer,
    service: detail.service,
    money: detail.money,
    addOns: detail.addOns,
    receipt: hasReceipt
      ? {
          url: meta.receiptUrl ?? null,
          number: meta.receiptNumber ?? null,
          card: meta.card ?? null,
          paymentIntentId: meta.paymentIntentId ?? null,
        }
      : null,
  };
}
