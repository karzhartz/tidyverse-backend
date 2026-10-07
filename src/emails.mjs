// The two customer emails.
//
// Pure functions returning { subject, html, text } — no sending, no clock, no
// network — so the wording and the figures can be asserted in tests.
//
//   1. booking received: the reference, the job, and a link to pay
//   2. payment received: the confirmation, the transaction, and the date the
//      crew will arrive

import { escapeHtml, formatDate, formatDateTimeRange, formatMoney, formatTime } from "./format.mjs";

const BRAND = {
  sage: "#5F7F63",
  teal: "#1F4E4A",
  cream: "#F7F4EC",
  ink: "#1B2B29",
  muted: "#5B6B69",
  line: "#E3DFD3",
};

const firstName = (booking) =>
  String(booking?.customer?.name ?? "").trim().split(/\s+/)[0] || "there";

const FREQUENCY_LABELS = {
  one_off: "One-off",
  monthly: "Monthly",
  fortnightly: "Fortnightly",
  weekly: "Weekly",
};

function summaryRows(booking) {
  const rows = [
    ["Reference", booking.reference],
    ["Service", booking.service?.title ?? "—"],
    ["Date", formatDate(booking.scheduledDate)],
    ["Arrival", `${formatTime(booking.startTime)} – ${formatTime(booking.endTime)}`],
    ["Address", booking.address || booking.customer?.address || "—"],
  ];

  if (booking.frequency && booking.frequency !== "one_off") {
    rows.push(["Plan", FREQUENCY_LABELS[booking.frequency] ?? booking.frequency]);
  }
  if (Array.isArray(booking.addOns) && booking.addOns.length > 0) {
    rows.push(["Extras", booking.addOns.map((a) => a.label).join(", ")]);
  }
  if (booking.money?.total !== undefined && booking.money?.total !== null) {
    rows.push(["Total", formatMoney(booking.money.total, booking.currency)]);
  }
  if (booking.money?.discount) {
    rows.push(["Discount", `− ${formatMoney(booking.money.discount, booking.currency)}`]);
  }
  return rows;
}

function rowsToHtml(rows) {
  return rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:7px 0;color:${BRAND.muted};font-size:13px;vertical-align:top;width:38%;">${escapeHtml(label)}</td>
          <td style="padding:7px 0;color:${BRAND.ink};font-size:14px;font-weight:600;vertical-align:top;">${escapeHtml(value)}</td>
        </tr>`
    )
    .join("");
}

function rowsToText(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
}

function panel(title, innerHtml) {
  return `
    <div style="border:1px solid ${BRAND.line};border-radius:12px;padding:18px 20px;margin:0 0 18px;background:#ffffff;">
      <p style="margin:0 0 10px;color:${BRAND.teal};font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">${escapeHtml(title)}</p>
      ${innerHtml}
    </div>`;
}

function button(url, label) {
  return `
    <div style="margin:22px 0 6px;">
      <a href="${escapeHtml(url)}" style="display:inline-block;background:${BRAND.sage};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:8px;">${escapeHtml(label)}</a>
    </div>`;
}

function layout({ preview, heading, intro, bodyHtml, footer }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(heading)}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.cream};font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preview)}</div>
    <div style="max-width:600px;margin:0 auto;padding:28px 20px 40px;">
      <div style="text-align:center;margin-bottom:22px;">
        <span style="color:${BRAND.teal};font-size:19px;font-weight:800;letter-spacing:-.01em;">Wimak Total Care</span>
      </div>
      <div style="background:#ffffff;border:1px solid ${BRAND.line};border-radius:16px;padding:28px 26px;">
        <h1 style="margin:0 0 10px;color:${BRAND.ink};font-size:22px;line-height:1.25;">${escapeHtml(heading)}</h1>
        <p style="margin:0 0 20px;color:${BRAND.muted};font-size:15px;line-height:1.6;">${intro}</p>
        ${bodyHtml}
      </div>
      <p style="margin:20px 0 0;color:${BRAND.muted};font-size:12px;line-height:1.6;text-align:center;">${footer}</p>
    </div>
  </body>
</html>`;
}

function greetingLine(name) {
  return `Hi ${escapeHtml(name)},`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Booking received
// ─────────────────────────────────────────────────────────────────────────────

export function bookingReceivedEmail({ booking, checkoutUrl, siteUrl = "" }) {
  const name = firstName(booking);
  const subject = `Booking ${booking.reference} received — complete your payment`;
  const rows = summaryRows(booking);

  const bodyHtml = [
    panel("Your booking", `<table style="width:100%;border-collapse:collapse;">${rowsToHtml(rows)}</table>`),
    checkoutUrl
      ? `${button(checkoutUrl, "Complete payment")}
         <p style="margin:0;color:${BRAND.muted};font-size:13px;line-height:1.6;">
           Your slot is held but not yet confirmed. Paying now confirms it and reserves your crew.
         </p>`
      : `<p style="margin:0;color:${BRAND.muted};font-size:13px;">We will be in touch to arrange payment.</p>`,
    panel(
      "Keep your reference",
      `<p style="margin:0;color:${BRAND.ink};font-size:22px;font-weight:800;letter-spacing:.02em;">${escapeHtml(booking.reference)}</p>
       <p style="margin:8px 0 0;color:${BRAND.muted};font-size:13px;">Quote it if you call us about this job.</p>`
    ),
  ].join("");

  const text = [
    greetingLine(name),
    "",
    `We have your booking ${booking.reference}. Paying now confirms it.`,
    "",
    rowsToText(rows),
    "",
    checkoutUrl ? `Complete payment: ${checkoutUrl}` : "We will be in touch to arrange payment.",
    "",
    "Wimak Total Care",
  ].join("\n");

  return {
    subject,
    html: layout({
      preview: `Reference ${booking.reference}. Complete payment to confirm your booking.`,
      heading: "We've got your booking",
      intro: `${greetingLine(name)} your slot is reserved. Complete the payment to confirm it.`,
      bodyHtml,
      footer: siteUrl
        ? `Wimak Total Care · <a href="${escapeHtml(siteUrl)}" style="color:${BRAND.sage};">${escapeHtml(siteUrl.replace(/^https?:\/\//, ""))}</a>`
        : "Wimak Total Care",
    }),
    text,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Payment received
// ─────────────────────────────────────────────────────────────────────────────

export function paymentReceivedEmail({ booking, siteUrl = "" }) {
  const name = firstName(booking);
  const subject = `Payment received — booking ${booking.reference} confirmed`;
  const rows = summaryRows(booking);
  const meta = booking.txMeta ?? {};
  const receiptUrl = meta.receiptUrl ?? booking.receipt?.url ?? null;
  const card = meta.card ?? booking.receipt?.card ?? null;
  const cardLabel = card?.last4
    ? `${String(card.brand ?? "card").toUpperCase()} ending ${card.last4}`
    : null;

  const transactionRows = [
    ["Amount paid", formatMoney(booking.amountPaid, booking.currency)],
    ["Paid on", formatDate((booking.paidAt ?? "").slice(0, 10))],
    ...(cardLabel ? [["Paid with", cardLabel]] : []),
    ...(booking.paymentIntentId ? [["Transaction", booking.paymentIntentId]] : []),
    ...(booking.reference ? [["Reference", booking.reference]] : []),
  ];

  const bodyHtml = [
    panel(
      "Your appointment",
      `<p style="margin:0 0 4px;color:${BRAND.ink};font-size:17px;font-weight:700;">
         ${escapeHtml(formatDateTimeRange(booking.scheduledDate, booking.startTime, booking.endTime))}
       </p>
       <p style="margin:0;color:${BRAND.muted};font-size:14px;">
         ${escapeHtml(booking.service?.title ?? "Your service")} · ${escapeHtml(booking.address || booking.customer?.address || "")}
       </p>`
    ),
    panel(
      "Booking details",
      `<table style="width:100%;border-collapse:collapse;">${rowsToHtml(rows)}</table>`
    ),
    panel(
      "Transaction",
      `<table style="width:100%;border-collapse:collapse;">${rowsToHtml(transactionRows)}</table>
       ${
         receiptUrl
           ? `<p style="margin:12px 0 0;"><a href="${escapeHtml(receiptUrl)}" style="color:${BRAND.sage};font-size:14px;font-weight:600;">View your Stripe receipt</a></p>`
           : ""
       }`
    ),
    `<p style="margin:0;color:${BRAND.muted};font-size:14px;line-height:1.6;">
       Your crew will arrive on the date above. If anything changes, reply to this email or call us
       and quote <strong style="color:${BRAND.ink};">${escapeHtml(booking.reference)}</strong>.
     </p>`,
  ].join("");

  const text = [
    greetingLine(name),
    "",
    `Payment received — booking ${booking.reference} is confirmed.`,
    "",
    `Appointment: ${formatDateTimeRange(booking.scheduledDate, booking.startTime, booking.endTime)}`,
    `Service:     ${booking.service?.title ?? "Your service"}`,
    `Address:     ${booking.address || booking.customer?.address || "—"}`,
    "",
    rowsToText(rows),
    "",
    "Transaction",
    rowsToText(transactionRows),
    ...(receiptUrl ? ["", `Receipt: ${receiptUrl}`] : []),
    "",
    "Wimak Total Care",
  ].join("\n");

  return {
    subject,
    html: layout({
      preview: `Paid ${formatMoney(booking.amountPaid, booking.currency)} — your appointment is confirmed.`,
      heading: "Payment received — you're confirmed",
      intro: `${greetingLine(name)} thank you. Your payment has been received and your booking is confirmed.`,
      bodyHtml,
      footer: siteUrl
        ? `Wimak Total Care · <a href="${escapeHtml(siteUrl)}" style="color:${BRAND.sage};">${escapeHtml(siteUrl.replace(/^https?:\/\//, ""))}</a>`
        : "Wimak Total Care",
    }),
    text,
  };
}
