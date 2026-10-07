// Shape the booking request before it reaches the database.
//
// The database is still the authority — public.create_public_booking() checks
// every rule and prices the job from the catalogue. This only guarantees the
// function receives the types it expects, so a malformed body is a clean 400
// rather than a Postgres cast error.

import { normalizeEmail } from "./validate.mjs";

const text = (value, max) => String(value ?? "").trim().slice(0, max);

/**
 * Shape the funnel selections the quote is computed from.
 *
 * Only the *inputs* are accepted — rooms, bathrooms and the chosen option keys.
 * Never a price: the database looks every figure up itself. Returns null when
 * nothing was supplied, so an older client keeps the catalogue price instead of
 * being quoted zero for a grouped service.
 */
export function normalizePricingInputs(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const result = {};

  const rooms = Number(input.rooms);
  if (Number.isFinite(rooms) && rooms > 0) result.rooms = Math.min(Math.round(rooms), 50);

  const bathrooms = Number(input.bathrooms);
  if (Number.isFinite(bathrooms) && bathrooms > 0) {
    result.bathrooms = Math.min(Math.round(bathrooms), 50);
  }

  const options = {};
  if (input.options && typeof input.options === "object" && !Array.isArray(input.options)) {
    for (const [key, value] of Object.entries(input.options).slice(0, 20)) {
      if (!/^[a-z0-9_]{1,40}$/.test(key)) continue;
      const list = (Array.isArray(value) ? value : [value])
        .filter((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 60)
        .slice(0, 30);
      if (list.length > 0) options[key] = list;
    }
  }
  if (Object.keys(options).length > 0) result.options = options;

  return Object.keys(result).length > 0 ? result : null;
}

export function normalizeBookingPayload(input) {
  const source = input && typeof input === "object" ? input : {};
  const customer = source.customer && typeof source.customer === "object" ? source.customer : {};

  const addOnIds = Array.isArray(source.addOnIds)
    ? source.addOnIds.filter((id) => typeof id === "string" && id.length > 0).slice(0, 50)
    : [];

  const pricingInputs = normalizePricingInputs(source.pricingInputs);

  return {
    customer: {
      name: text(customer.name, 120),
      email: normalizeEmail(customer.email),
      phone: text(customer.phone, 25),
      address: text(customer.address, 300),
    },
    serviceId: text(source.serviceId, 80),
    date: text(source.date, 10),
    startTime: text(source.startTime, 5) || "09:00",
    frequency: text(source.frequency, 20) || "one_off",
    addOnIds,
    notes: text(source.notes, 2000),
    ...(source.teamSize !== undefined && source.teamSize !== null
      ? { teamSize: Number(source.teamSize) }
      : {}),
    ...(pricingInputs ? { pricingInputs } : {}),
  };
}

/** References are generated as WTC-XXXXXX; reject anything else before a query. */
export function isValidReference(reference) {
  return /^WTC-[A-Z0-9]{4,10}$/.test(normalizeReference(reference));
}

export function normalizeReference(reference) {
  return String(reference ?? "").trim().toUpperCase();
}
