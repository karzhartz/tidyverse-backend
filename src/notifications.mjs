// Sending the two customer emails, in one place.
//
// Each helper renders the template, hands it to the mailer, and only then
// stamps the booking. That order matters: if the provider rejects the message
// the stamp is not written, so the next attempt (a webhook redelivery, or the
// resend endpoint) still sees the email as due.

import { bookingReceivedEmail, paymentReceivedEmail } from "./emails.mjs";
import { markEmailSent } from "./bookings.mjs";

/** "Booking received" — sent as soon as a booking exists. */
export async function sendBookingReceived({ mailer, client, detail, checkoutUrl, siteUrl }) {
  const message = bookingReceivedEmail({ booking: detail, checkoutUrl, siteUrl });
  const result = await mailer.send({ to: detail.customer.email, ...message });
  await markEmailSent(client, detail.reference, "booking");
  return result;
}

/** "Payment received" — sent once Stripe confirms the charge cleared. */
export async function sendPaymentReceived({ mailer, client, detail, siteUrl }) {
  const message = paymentReceivedEmail({ booking: detail, siteUrl });
  const result = await mailer.send({ to: detail.customer.email, ...message });
  await markEmailSent(client, detail.reference, "payment");
  return result;
}
