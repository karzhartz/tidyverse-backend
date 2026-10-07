import test from "node:test";
import assert from "node:assert/strict";

import {
  isValidReference,
  normalizeBookingPayload,
  normalizePricingInputs,
  normalizeReference,
} from "../src/booking-payload.mjs";

test("normalizeBookingPayload trims and lower-cases the customer email", () => {
  const payload = normalizeBookingPayload({
    customer: {
      name: "  Amara   Okafor ",
      email: "  Amara@Example.COM ",
      phone: " (555) 123-4567 ",
      address: " 12 Riverside Drive ",
    },
    serviceId: " deep-cleaning ",
    date: "2026-10-12",
    startTime: "09:00",
    frequency: "fortnightly",
    addOnIds: ["oven", "windows"],
    notes: "Gate code 1234",
  });

  assert.equal(payload.customer.email, "amara@example.com");
  assert.equal(payload.customer.name, "Amara   Okafor");
  assert.equal(payload.serviceId, "deep-cleaning");
  assert.deepEqual(payload.addOnIds, ["oven", "windows"]);
  assert.equal(payload.startTime, "09:00");
});

test("normalizeBookingPayload survives a missing or malformed body", () => {
  const empty = normalizeBookingPayload(undefined);
  assert.equal(empty.customer.email, "");
  assert.equal(empty.serviceId, "");
  assert.deepEqual(empty.addOnIds, []);
  assert.equal(empty.startTime, "09:00");
  assert.equal(empty.frequency, "one_off");
});

test("normalizeBookingPayload drops non-string add-on ids", () => {
  const payload = normalizeBookingPayload({ addOnIds: ["oven", 42, null, "", "windows"] });
  assert.deepEqual(payload.addOnIds, ["oven", "windows"]);
});

test("normalizeBookingPayload truncates over-long text", () => {
  const payload = normalizeBookingPayload({ notes: "x".repeat(5000) });
  assert.equal(payload.notes.length, 2000);
});

test("references are normalised to upper case", () => {
  assert.equal(normalizeReference(" wtc-abc123 "), "WTC-ABC123");
  assert.equal(normalizeReference(undefined), "");
});

test("only generated reference shapes are accepted", () => {
  assert.ok(isValidReference("WTC-ABC123"));
  assert.ok(isValidReference("wtc-abc123"));
  assert.ok(!isValidReference("ABC-123"));
  assert.ok(!isValidReference("WTC-"));
  assert.ok(!isValidReference("WTC-ABC12345678901"));
  assert.ok(!isValidReference(""));
});

// ── Pricing inputs ───────────────────────────────────────────────────────────
// The service re-prices from these, so only selections travel — never a figure.

test("pricing inputs keep the selections and drop anything amount-shaped", () => {
  const inputs = normalizePricingInputs({
    rooms: 3,
    bathrooms: 2,
    options: { size: ["2-bed"], tasks: ["mowing", "hedges"] },
    total: 12345,
    basePrice: 999,
    discount: 50,
  });

  assert.deepEqual(inputs, {
    rooms: 3,
    bathrooms: 2,
    options: { size: ["2-bed"], tasks: ["mowing", "hedges"] },
  });
  assert.equal("total" in inputs, false);
  assert.equal("basePrice" in inputs, false);
});

test("a single option value is wrapped into a list", () => {
  assert.deepEqual(normalizePricingInputs({ options: { size: "2-bed" } }), {
    options: { size: ["2-bed"] },
  });
});

test("pricing inputs are null when nothing usable was sent", () => {
  assert.equal(normalizePricingInputs(undefined), null);
  assert.equal(normalizePricingInputs(null), null);
  assert.equal(normalizePricingInputs({}), null);
  assert.equal(normalizePricingInputs({ options: {} }), null);
  assert.equal(normalizePricingInputs({ rooms: 0 }), null);
  assert.equal(normalizePricingInputs({ rooms: "many" }), null);
});

test("malformed group keys and option values are dropped", () => {
  assert.deepEqual(
    normalizePricingInputs({
      options: { "bad key": ["x"], good_key: ["y"], other: ["", 42, "ok"] },
    }),
    { options: { good_key: ["y"], other: ["ok"] } }
  );
});

test("normalizeBookingPayload attaches pricingInputs only when there are some", () => {
  const withInputs = normalizeBookingPayload({
    serviceId: "deep-cleaning",
    pricingInputs: { rooms: 2, bathrooms: 1 },
  });
  assert.deepEqual(withInputs.pricingInputs, { rooms: 2, bathrooms: 1 });

  const withoutInputs = normalizeBookingPayload({ serviceId: "deep-cleaning" });
  assert.equal("pricingInputs" in withoutInputs, false);
});
