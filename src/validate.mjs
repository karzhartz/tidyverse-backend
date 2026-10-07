// Pure validation and generation helpers.
//
// Everything here is deliberately free of I/O so it can be unit-tested without
// a database, a network, or a secret key.

import { randomInt } from "node:crypto";

/** The role names the Postgres `staff_role` enum accepts. */
export const ROLES = /** @type {const} */ (["admin", "manager", "viewer"]);

/** What each role may do, mirroring the `can_edit()` / `is_admin()` policies. */
export const ROLE_DESCRIPTIONS = {
  admin: "everything, including staff and settings",
  manager: "everything except staff and settings",
  viewer: "read-only",
};

/** Lower-cased, trimmed — the form Supabase Auth and `staff.email` agree on. */
export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value) {
  const email = normalizeEmail(value);
  return email.length > 3 && email.length <= 254 && EMAIL_PATTERN.test(email);
}

export function normalizeName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function isValidName(value) {
  const name = normalizeName(value);
  return name.length >= 2 && name.length <= 120;
}

/** @returns {typeof ROLES[number] | null} */
export function parseRole(value) {
  const role = String(value ?? "").trim().toLowerCase();
  return ROLES.includes(role) ? role : null;
}

/** Supabase's own floor is 6; we hold the line at 8 for staff accounts. */
export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt (what GoTrue uses) only considers the first 72 bytes. */
export const MAX_PASSWORD_LENGTH = 72;

export function validatePassword(value, { min = MIN_PASSWORD_LENGTH } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, reason: "a password is required" };
  }
  if (value.length < min) {
    return { ok: false, reason: `must be at least ${min} characters` };
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: `must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  return { ok: true };
}

const CHARACTER_SETS = [
  "ABCDEFGHJKLMNPQRSTUVWXYZ", // no I/O: they get misread when typed from a screen
  "abcdefghijkmnopqrstuvwxyz",
  "23456789",
  "!@#$%^&*()-_=+[]{}",
];

/**
 * Generate a password that always contains at least one character from every
 * set. Uses crypto.randomInt, not Math.random.
 */
export function generatePassword(length = 20) {
  if (!Number.isInteger(length) || length < CHARACTER_SETS.length) {
    throw new RangeError(`password length must be an integer >= ${CHARACTER_SETS.length}`);
  }

  const everything = CHARACTER_SETS.join("");
  const chars = CHARACTER_SETS.map((set) => set[randomInt(set.length)]);
  while (chars.length < length) {
    chars.push(everything[randomInt(everything.length)]);
  }

  // Fisher–Yates so the guaranteed characters are not always at the front.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}
