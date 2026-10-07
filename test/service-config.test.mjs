import test from "node:test";
import assert from "node:assert/strict";

import { ConfigError } from "../src/errors.mjs";
import { readServiceConfig } from "../src/config.mjs";

const base = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_abc",
  STRIPE_SECRET_KEY: "sk_test_abc",
  STRIPE_WEBHOOK_SECRET: "whsec_abc",
};

test("a complete environment produces a usable config", () => {
  const config = readServiceConfig({ ...base });

  assert.equal(config.supabase.url, "https://example.supabase.co");
  assert.equal(config.stripe.currency, "usd");
  assert.equal(config.stripe.automaticTax, false);
  assert.equal(config.email.transport, "console"); // no provider → nothing is sent
  assert.equal(config.http.host, "127.0.0.1");
  assert.equal(config.http.port, 8787);
  assert.deepEqual(config.http.corsOrigins, ["http://localhost:8080"]);
});

test("Stripe return URLs are derived from the site URL and keep both placeholders", () => {
  const config = readServiceConfig({ ...base, PUBLIC_SITE_URL: "https://wimaktotalcare.com" });
  assert.match(config.stripe.successUrl, /^https:\/\/wimaktotalcare\.com\/booking-confirmed/);
  assert.match(config.stripe.successUrl, /\{REFERENCE\}/);
  assert.match(config.stripe.successUrl, /\{CHECKOUT_SESSION_ID\}/);
  assert.match(config.stripe.cancelUrl, /\{REFERENCE\}/);
});

test("an explicit success/cancel URL wins", () => {
  const config = readServiceConfig({
    ...base,
    STRIPE_SUCCESS_URL: "https://x.test/ok?r={REFERENCE}",
    STRIPE_CANCEL_URL: "https://x.test/no?r={REFERENCE}",
  });
  assert.equal(config.stripe.successUrl, "https://x.test/ok?r={REFERENCE}");
  assert.equal(config.stripe.cancelUrl, "https://x.test/no?r={REFERENCE}");
});

test("the Stripe secret key is required and shape-checked", () => {
  assert.throws(
    () => readServiceConfig({ ...base, STRIPE_SECRET_KEY: "" }),
    (error) => error instanceof ConfigError && /STRIPE_SECRET_KEY is not set/.test(error.message)
  );
  assert.throws(
    () => readServiceConfig({ ...base, STRIPE_SECRET_KEY: "pk_test_abc" }),
    (error) => error instanceof ConfigError && /does not look like/.test(error.message)
  );
});

test("the webhook secret is required — an unverifiable webhook is not an option", () => {
  assert.throws(
    () => readServiceConfig({ ...base, STRIPE_WEBHOOK_SECRET: "" }),
    (error) => error instanceof ConfigError && /STRIPE_WEBHOOK_SECRET is not set/.test(error.message)
  );
});

test("the Supabase public-key guard still applies", () => {
  assert.throws(
    () => readServiceConfig({ ...base, SUPABASE_SECRET_KEY: "sb_publishable_abc" }),
    (error) => error instanceof ConfigError && /PUBLIC publishable/.test(error.message)
  );
});

test("email transport falls back to resend when a key is present", () => {
  const config = readServiceConfig({ ...base, RESEND_API_KEY: "re_abc" });
  assert.equal(config.email.transport, "resend");
  assert.equal(config.email.resendApiKey, "re_abc");
});

test("resend without a key, or an unknown transport, is refused", () => {
  assert.throws(
    () => readServiceConfig({ ...base, EMAIL_TRANSPORT: "resend" }),
    (error) => error instanceof ConfigError && /RESEND_API_KEY is not set/.test(error.message)
  );
  assert.throws(
    () => readServiceConfig({ ...base, EMAIL_TRANSPORT: "carrier-pigeon" }),
    (error) => error instanceof ConfigError && /EMAIL_TRANSPORT is/.test(error.message)
  );
});

test("the file transport does not require a key", () => {
  const config = readServiceConfig({ ...base, EMAIL_TRANSPORT: "file", EMAIL_LOG_DIR: "/tmp/mail" });
  assert.equal(config.email.transport, "file");
  assert.equal(config.email.logDir, "/tmp/mail");
});

test("booleans are parsed strictly rather than guessed", () => {
  assert.equal(readServiceConfig({ ...base, STRIPE_AUTOMATIC_TAX: "true" }).stripe.automaticTax, true);
  assert.equal(readServiceConfig({ ...base, STRIPE_AUTOMATIC_TAX: "no" }).stripe.automaticTax, false);
  assert.throws(
    () => readServiceConfig({ ...base, STRIPE_AUTOMATIC_TAX: "maybe" }),
    (error) => error instanceof ConfigError && /must be true or false/.test(error.message)
  );
});

test("CORS origins are split and trailing slashes removed", () => {
  const config = readServiceConfig({
    ...base,
    CORS_ORIGINS: "https://a.test/, https://b.test ,",
  });
  assert.deepEqual(config.http.corsOrigins, ["https://a.test", "https://b.test"]);
});

test("the port must be a real port", () => {
  assert.equal(readServiceConfig({ ...base, PORT: "9000" }).http.port, 9000);
  assert.throws(
    () => readServiceConfig({ ...base, PORT: "seven" }),
    (error) => error instanceof ConfigError && /port number/.test(error.message)
  );
  assert.throws(
    () => readServiceConfig({ ...base, PORT: "70000" }),
    (error) => error instanceof ConfigError && /port number/.test(error.message)
  );
});

test("an invalid site URL is refused with a readable message", () => {
  assert.throws(
    () => readServiceConfig({ ...base, PUBLIC_SITE_URL: "not a url" }),
    (error) => error instanceof ConfigError && /PUBLIC_SITE_URL/.test(error.message)
  );
});

// ── SMTP ─────────────────────────────────────────────────────────────────────

test("setting SMTP_HOST alone switches delivery to SMTP", () => {
  const config = readServiceConfig({ ...base, SMTP_HOST: "smtp.example.com" });

  assert.equal(config.email.transport, "smtp");
  assert.equal(config.email.smtp.host, "smtp.example.com");
  assert.equal(config.email.smtp.port, 587);
  assert.equal(config.email.smtp.secure, false);
  assert.equal(config.email.smtp.requireTLS, false);
  assert.equal(config.email.smtp.rejectUnauthorized, true);
  assert.equal(config.email.smtp.user, null);
});

test("SMTP takes precedence over a leftover Resend key", () => {
  const config = readServiceConfig({ ...base, SMTP_HOST: "smtp.example.com", RESEND_API_KEY: "re_x" });
  assert.equal(config.email.transport, "smtp");
});

test("port 465 implies implicit TLS", () => {
  const config = readServiceConfig({ ...base, SMTP_HOST: "smtp.example.com", SMTP_PORT: "465" });
  assert.equal(config.email.smtp.port, 465);
  assert.equal(config.email.smtp.secure, true);
});

test("SMTP_SECURE overrides what the port would imply", () => {
  const config = readServiceConfig({
    ...base,
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "465",
    SMTP_SECURE: "false",
  });
  assert.equal(config.email.smtp.secure, false);
});

test("SMTP credentials must be supplied as a pair", () => {
  assert.throws(
    () => readServiceConfig({ ...base, SMTP_HOST: "smtp.example.com", SMTP_USER: "apikey" }),
    (error) => error instanceof ConfigError && /SMTP_PASSWORD is not/.test(error.message)
  );
  assert.throws(
    () => readServiceConfig({ ...base, SMTP_HOST: "smtp.example.com", SMTP_PASSWORD: "s3cret" }),
    (error) => error instanceof ConfigError && /SMTP_USER is not/.test(error.message)
  );
});

test("credentials are carried through when both are set", () => {
  const config = readServiceConfig({
    ...base,
    SMTP_HOST: "smtp.example.com",
    SMTP_USER: "apikey",
    SMTP_PASSWORD: "s3cret",
  });
  assert.equal(config.email.smtp.user, "apikey");
  assert.equal(config.email.smtp.password, "s3cret");
});

test("EMAIL_TRANSPORT=smtp without a host is refused", () => {
  assert.throws(
    () => readServiceConfig({ ...base, EMAIL_TRANSPORT: "smtp" }),
    (error) => error instanceof ConfigError && /SMTP_HOST is not set/.test(error.message)
  );
});

test("an explicit transport still wins over a configured SMTP host", () => {
  const config = readServiceConfig({
    ...base,
    SMTP_HOST: "smtp.example.com",
    EMAIL_TRANSPORT: "console",
  });
  assert.equal(config.email.transport, "console");
});

test("the SMTP From default is on the company domain, not Resend's", () => {
  const smtp = readServiceConfig({ ...base, SMTP_HOST: "smtp.example.com" });
  assert.match(smtp.email.from, /wimaktotalcare\.com/);
  assert.doesNotMatch(smtp.email.from, /resend\.dev/);

  const resend = readServiceConfig({ ...base, RESEND_API_KEY: "re_x" });
  assert.match(resend.email.from, /resend\.dev/);
});

test("EMAIL_FROM overrides the transport default", () => {
  const config = readServiceConfig({
    ...base,
    SMTP_HOST: "smtp.example.com",
    EMAIL_FROM: "Ops <ops@example.com>",
  });
  assert.equal(config.email.from, "Ops <ops@example.com>");
});

test("SMTP timeouts are milliseconds, not ports", () => {
  const config = readServiceConfig({
    ...base,
    SMTP_HOST: "smtp.example.com",
    SMTP_CONNECTION_TIMEOUT_MS: "5000",
  });
  assert.equal(config.email.smtp.connectionTimeoutMs, 5000);

  assert.throws(
    () => readServiceConfig({ ...base, SMTP_HOST: "smtp.example.com", SMTP_CONNECTION_TIMEOUT_MS: "50" }),
    (error) => error instanceof ConfigError && /milliseconds/.test(error.message)
  );
});

test("an invalid SMTP port or boolean is refused", () => {
  assert.throws(
    () => readServiceConfig({ ...base, SMTP_HOST: "smtp.example.com", SMTP_PORT: "not-a-port" }),
    ConfigError
  );
  assert.throws(
    () => readServiceConfig({ ...base, SMTP_HOST: "smtp.example.com", SMTP_SECURE: "sometimes" }),
    (error) => error instanceof ConfigError && /SMTP_SECURE/.test(error.message)
  );
});
