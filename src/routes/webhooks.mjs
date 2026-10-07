// Stripe webhook.
//
// Mounted before express.json() so the body stays a raw Buffer — the signature
// is computed over the exact bytes Stripe sent, and re-serialising JSON would
// break it.
//
// Processing is idempotent at two levels: Stripe's event id is the primary key
// of public.stripe_events, and the receipt email is stamped only once. That is
// what makes it safe for Stripe to redeliver an event, which it will.

import express, { Router } from "express";
import { buildPaymentUpdate, constructWebhookEvent } from "../stripe.mjs";
import { applyPayment, getBookingDetail } from "../bookings.mjs";
import { sendPaymentReceived } from "../notifications.mjs";

export function webhookRoutes({ client, stripe, config, mailer, logger }) {
  const router = Router();

  router.post(
    "/stripe",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res) => {
      // ── Verify ─────────────────────────────────────────────────────────
      let event;
      try {
        event = constructWebhookEvent(
          stripe,
          req.body,
          req.get("stripe-signature"),
          config.stripe.webhookSecret
        );
      } catch (error) {
        logger.warn("stripe webhook rejected", { message: error.message });
        return res.status(400).json({ ok: false, error: "invalid_signature" });
      }

      logger.info(event)

      // ── Translate ──────────────────────────────────────────────────────
      let update;
      try {
        update = await buildPaymentUpdate(stripe, event, {
          currency: config.stripe.currency,
        });
      } catch (error) {
        logger.error("could not interpret the stripe event", {
          id: event.id,
          type: event.type,
          message: error.message,
        });
        return res.status(500).json({ ok: false, error: "event_interpretation_failed" });
      }

      if (!update) {
        logger.info("stripe event ignored", { id: event.id, type: event.type });
        return res.json({ ok: true, ignored: true, type: event.type });
      }

      // ── Apply ──────────────────────────────────────────────────────────
      let result;
      try {
        result = await applyPayment(client, {
          ...update,
          eventId: event.id,
          eventType: event.type,
        });
      } catch (error) {
        // 500 so Stripe retries; the event id guard means a retry is safe.
        logger.error("could not apply the stripe event", {
          id: event.id,
          type: event.type,
          message: error.message,
        });
        return res.status(500).json({ ok: false, error: "apply_failed" });
      }

      // ── Receipt email ──────────────────────────────────────────────────
      // Only when the database says it is due. A failure here is logged but
      // not fatal: the payment state is already correct, and the email can be
      // re-sent with the admin endpoint rather than by replaying the webhook.
      let email = "not_due";
      if (result.needsPaymentEmail) {
        try {
          const detail = await getBookingDetail(client, result.reference);
          await sendPaymentReceived({ mailer, client, detail, siteUrl: config.http.siteUrl });
          email = "sent";
        } catch (error) {
          email = "failed";
          logger.error("receipt email failed", {
            reference: result.reference,
            message: error.message,
          });
        }
      }

      logger.info("stripe event applied", {
        id: event.id,
        type: event.type,
        reference: result.reference,
        paymentStatus: result.paymentStatus,
        transitionedToPaid: result.transitionedToPaid,
        email,
      });

      res.json({
        ok: true,
        type: event.type,
        reference: result.reference,
        paymentStatus: result.paymentStatus,
        transitionedToPaid: result.transitionedToPaid,
        email,
      });
    }
  );

  return router;
}
