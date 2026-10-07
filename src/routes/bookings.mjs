// Booking routes.
//
//   POST /api/bookings                       create a booking + Checkout Session
//   POST /api/bookings/:reference/checkout   (re)start checkout for a booking
//   GET  /api/bookings/:reference            the booking and its payment state
//   POST /api/bookings/:reference/emails/:kind/resend
//
// A reference is short and guessable, so reading or re-checking-out a booking
// requires the email used to make it (or the Stripe Checkout Session id). The
// booking-received email cannot be sent twice by accident: the stamp in the
// database is written only after the provider accepts the message.

import { Router } from "express";
import { HttpError } from "../errors.mjs";
import {
  isValidReference,
  normalizeBookingPayload,
  normalizeReference,
} from "../booking-payload.mjs";
import { createBooking, getBookingDetail, toPublicBooking } from "../bookings.mjs";
import { ensureCheckoutSession } from "../checkout.mjs";
import { sendBookingReceived, sendPaymentReceived } from "../notifications.mjs";

const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function readReference(req) {
  const reference = normalizeReference(req.params.reference);
  if (!isValidReference(reference)) {
    throw new HttpError(400, "That does not look like a booking reference.", {
      code: "validation_error",
    });
  }
  return reference;
}

/** Reads and re-checkouts are limited to whoever can prove they own it. */
function assertOwner(detail, req) {
  const email = String(req.query.email ?? req.body?.email ?? "").trim().toLowerCase();
  const sessionId = String(req.query.session_id ?? req.body?.session_id ?? "").trim();

  const ownsByEmail =
    email.length > 0 && email === String(detail.customer?.email ?? "").toLowerCase();
  const ownsBySession = sessionId.length > 0 && sessionId === detail.checkoutSessionId;

  if (!ownsByEmail && !ownsBySession) {
    throw new HttpError(
      403,
      "Provide the email address used for this booking to view it.",
      { code: "forbidden" }
    );
  }
}

function checkoutPayload(session, reused) {
  if (!session) return null;
  return { url: session.url ?? null, sessionId: session.id ?? null, reused };
}

export function bookingRoutes({ client, stripe, config, mailer, logger }) {
  const router = Router();
  const siteUrl = config.http.siteUrl;

  // ── Create ───────────────────────────────────────────────────────────────
  router.post(
    "/bookings",
    asyncRoute(async (req, res) => {
      const payload = normalizeBookingPayload(req.body);

      if (!payload.serviceId) {
        throw new HttpError(400, "A service is required.", { code: "validation_error" });
      }

      // The database validates and prices; the request body is only a hint.
      const created = await createBooking(client, payload);
      const reference = created.reference;

      let session = null;
      let reused = false;
      let checkoutError = null;

      try {
        const outcome = await ensureCheckoutSession({ client, stripe, config, reference, logger });
        session = outcome.session;
        reused = outcome.reused;
      } catch (error) {
        // The booking is real and the customer can retry payment from the
        // confirmation page, so a Stripe failure does not lose the booking.
        // The customer gets a plain sentence; the provider's detail — which can
        // name keys and accounts — goes to the log instead.
        checkoutError = "We could not start the payment session. Please try again.";
        logger.error("could not start checkout", { reference, message: error.message });
      }

      const detail = await getBookingDetail(client, reference);

      let email = "skipped";
      try {
        await sendBookingReceived({
          mailer,
          client,
          detail,
          checkoutUrl: session?.url ?? null,
          siteUrl,
        });
        email = "sent";
      } catch (error) {
        email = "failed";
        logger.error("booking email failed", { reference, message: error.message });
      }

      res.status(201).json({
        ok: true,
        reference,
        bookingId: created.bookingId,
        paymentStatus: detail.paymentStatus,
        booking: toPublicBooking(detail),
        checkout: checkoutPayload(session, reused),
        checkoutError,
        email,
      });
    })
  );

  // ── (Re)start checkout ───────────────────────────────────────────────────
  router.post(
    "/bookings/:reference/checkout",
    asyncRoute(async (req, res) => {
      const reference = readReference(req);

      const detail = await getBookingDetail(client, reference);
      if (!detail) {
        throw new HttpError(404, "No booking with that reference.", { code: "not_found" });
      }
      assertOwner(detail, req);

      const outcome = await ensureCheckoutSession({ client, stripe, config, reference, logger });

      if (outcome.alreadyPaid) {
        return res.json({
          ok: true,
          reference,
          paymentStatus: "paid",
          alreadyPaid: true,
          checkout: null,
          booking: toPublicBooking(outcome.detail),
        });
      }

      res.json({
        ok: true,
        reference,
        paymentStatus: outcome.detail.paymentStatus,
        alreadyPaid: false,
        checkout: checkoutPayload(outcome.session, outcome.reused),
        booking: toPublicBooking(outcome.detail),
      });
    })
  );

  // ── Read ─────────────────────────────────────────────────────────────────
  router.get(
    "/bookings/:reference",
    asyncRoute(async (req, res) => {
      const reference = readReference(req);

      const detail = await getBookingDetail(client, reference);
      if (!detail) {
        throw new HttpError(404, "No booking with that reference.", { code: "not_found" });
      }
      assertOwner(detail, req);

      res.json({ ok: true, booking: toPublicBooking(detail) });
    })
  );

  // ── Resend an email (operator use) ───────────────────────────────────────
  router.post(
    "/bookings/:reference/emails/:kind/resend",
    asyncRoute(async (req, res) => {
      if (!config.http.adminToken) {
        // Disabled unless a token is configured — an open resend endpoint is a
        // way to spam a customer.
        throw new HttpError(404, "Not found.", { code: "not_found" });
      }

      const authorization = req.get("authorization") ?? "";
      if (authorization !== `Bearer ${config.http.adminToken}`) {
        throw new HttpError(401, "A valid admin token is required.", {
          code: "unauthorized",
        });
      }

      const reference = readReference(req);
      const kind = String(req.params.kind).toLowerCase();
      if (!["booking", "payment"].includes(kind)) {
        throw new HttpError(400, "kind must be booking or payment.", {
          code: "validation_error",
        });
      }

      const detail = await getBookingDetail(client, reference);
      if (!detail) {
        throw new HttpError(404, "No booking with that reference.", { code: "not_found" });
      }

      if (kind === "booking") {
        let checkoutUrl = null;
        if (detail.paymentStatus !== "paid") {
          try {
            const outcome = await ensureCheckoutSession({ client, stripe, config, reference, logger });
            checkoutUrl = outcome.session?.url ?? null;
          } catch (error) {
            logger.warn("resend could not start checkout", { reference, message: error.message });
          }
        }
        await sendBookingReceived({ mailer, client, detail, checkoutUrl, siteUrl });
      } else {
        if (detail.paymentStatus !== "paid") {
          throw new HttpError(409, "That booking is not paid, so there is no receipt to resend.", {
            code: "conflict",
          });
        }
        await sendPaymentReceived({ mailer, client, detail, siteUrl });
      }

      res.json({ ok: true, sent: kind, to: detail.customer.email, reference });
    })
  );

  return router;
}
