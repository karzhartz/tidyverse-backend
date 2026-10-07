import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PASSWORD_LENGTH,
  ROLE_DESCRIPTIONS,
  ROLES,
  generatePassword,
  isValidEmail,
  isValidName,
  normalizeEmail,
  normalizeName,
  parseRole,
  validatePassword,
} from "../src/validate.mjs";

test("normalizeEmail trims and lower-cases", () => {
  assert.equal(normalizeEmail("  Amara@WimakTotalCare.com "), "amara@wimaktotalcare.com");
  assert.equal(normalizeEmail(null), "");
});

test("isValidEmail accepts ordinary addresses and rejects malformed ones", () => {
  assert.ok(isValidEmail("amara@wimaktotalcare.com"));
  assert.ok(isValidEmail("a.b+tag@sub.example.co.uk"));
  assert.ok(!isValidEmail("no-at-sign"));
  assert.ok(!isValidEmail("two@@example.com"));
  assert.ok(!isValidEmail("spaces in@example.com"));
  assert.ok(!isValidEmail("trailing@example."));
  assert.ok(!isValidEmail(""));
});

test("normalizeName collapses whitespace", () => {
  assert.equal(normalizeName("  Amara   Okafor "), "Amara Okafor");
});

test("isValidName needs two characters", () => {
  assert.ok(isValidName("Amara Okafor"));
  assert.ok(isValidName("Jo"));
  assert.ok(!isValidName("J"));
  assert.ok(!isValidName("   "));
});

test("parseRole accepts exactly the enum values", () => {
  assert.deepEqual(ROLES, ["admin", "manager", "viewer"]);
  assert.equal(parseRole("admin"), "admin");
  assert.equal(parseRole(" ADMIN "), "admin");
  assert.equal(parseRole("Viewer"), "viewer");
  assert.equal(parseRole("owner"), null);
  assert.equal(parseRole(undefined), null);
  assert.equal(parseRole(""), null);
});

test("every role has a description", () => {
  for (const role of ROLES) {
    assert.equal(typeof ROLE_DESCRIPTIONS[role], "string");
    assert.ok(ROLE_DESCRIPTIONS[role].length > 0);
  }
});

test("validatePassword enforces the floor and the bcrypt ceiling", () => {
  assert.equal(validatePassword("correct-horse-battery").ok, true);
  assert.equal(validatePassword("short").ok, false);
  assert.equal(validatePassword("").ok, false);
  assert.equal(validatePassword(undefined).ok, false);
  assert.equal(validatePassword("x".repeat(MAX_PASSWORD_LENGTH)).ok, true);
  assert.equal(validatePassword("x".repeat(MAX_PASSWORD_LENGTH + 1)).ok, false);

  // A custom floor is honoured.
  assert.equal(validatePassword("short", { min: 4 }).ok, true);
});

test("generated passwords have the requested length", () => {
  for (const length of [8, 20, 40]) {
    assert.equal(generatePassword(length).length, length);
  }
});

test("generated passwords include every character class", () => {
  for (let i = 0; i < 25; i += 1) {
    const password = generatePassword(20);
    assert.match(password, /[A-Z]/, "upper case");
    assert.match(password, /[a-z]/, "lower case");
    assert.match(password, /[0-9]/, "digit");
    assert.match(password, /[^A-Za-z0-9]/, "symbol");
  }
});

test("generated passwords do not repeat", () => {
  const passwords = new Set(Array.from({ length: 50 }, () => generatePassword(24)));
  assert.equal(passwords.size, 50);
});

test("generatePassword rejects impossible lengths", () => {
  assert.throws(() => generatePassword(2), RangeError);
  assert.throws(() => generatePassword(8.5), RangeError);
});
