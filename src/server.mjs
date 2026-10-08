#!/usr/bin/env node
// wimak-service — the HTTP API in front of Supabase and Stripe.
//
//   npm start        node src/server.mjs
//   npm run dev      node --watch src/server.mjs
//
// Boots only with a complete configuration: a missing Stripe key or webhook
// secret is a startup error, not a surprise on the first customer's checkout.

import { createRequire } from "node:module";
import { loadEnvFile, readServiceConfig } from "./config.mjs";
import { ConfigError } from "./errors.mjs";
import { createLogger } from "./logger.mjs";
import { createAdminClient } from "./supabase.mjs";
import { createStripeClient } from "./stripe.mjs";
import { createMailer } from "./mailer.mjs";
import { createApp } from "./app.mjs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

/**
 * Check the SMTP settings in the background: connects and authenticates but
 * sends nothing. A failure is logged, never fatal — the email stays "due" for a
 * retry, and bookings keep flowing.
 */
async function verifySmtp(mailer, smtp, logger) {
  logger.info("checking the SMTP connection", {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
  });

  try {
    await mailer.verify();
    logger.info("SMTP connection verified", { host: smtp.host, port: smtp.port });
  } catch (error) {
    logger.error("SMTP verification failed", {
      host: smtp.host,
      port: smtp.port,
      message: error.message,
    });
    logger.warn("emails will fail until the SMTP settings are fixed");
  }

  if (!smtp.secure && !smtp.requireTLS) {
    logger.warn(
      "SMTP is neither implicit TLS nor STARTTLS — traffic is sent in the clear"
    );
  }
}

async function main() {
  const envFile = process.env.ENV_FILE || ".env";
  const loaded = loadEnvFile(envFile);

  if (!loaded.loaded && !process.env.SUPABASE_URL) {
    throw new ConfigError(`No env file at ${loaded.path} and no environment set.`, {
      hint: "cp .env.example .env, or export the variables and pass ENV_FILE=/dev/null.",
    });
  }

  const config = readServiceConfig();
  const logger = createLogger(process.env.LOG_LEVEL || "info");
  const stripeMode = /_(live)_/.test(config.stripe.secretKey) ? "live" : "test";

  logger.info("starting wimak-service", {
    version,
    host: config.http.host,
    port: config.http.port,
    envFile: loaded.loaded ? loaded.path : null,
    stripeMode,
    email: config.email.transport,
    corsOrigins: config.http.corsOrigins,
  });

  if (stripeMode === "test") {
    logger.warn("Stripe is in TEST mode — no real money will move");
  }
  if (config.email.transport === "console") {
    logger.warn("email transport is 'console' — nothing will actually be delivered");
  }

  const client = createAdminClient(config.supabase);
  const stripe = createStripeClient(config.stripe);
  const mailer = createMailer(config.email, logger);

  const app = createApp({ config, client, stripe, mailer, logger, version });

  const server = app.listen(config.http.port, config.http.host, () => {
    logger.info("listening", {
      url: `http://${config.http.host}:${config.http.port}`,
      health: `http://${config.http.host}:${config.http.port}/health`,
      webhook: `http://${config.http.host}:${config.http.port}/webhooks/stripe`,
    });
    logger.warn(
      "this process holds the Supabase secret key — keep it on loopback or behind a TLS proxy"
    );
  });

  // Check the SMTP settings once the listener is already up. Awaiting this
  // first would hold the whole service hostage to a slow mail host — a
  // container healthcheck would fail — and taking bookings must not depend on
  // the mail server being reachable.
  if (config.email.transport === "smtp") {
    void verifySmtp(mailer, config.email.smtp, logger);
  }

  const shutdown = (signal) => {
    logger.info("shutting down", { signal });
    server.close(() => process.exit(0));
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`✗ ${error.message}\n`);
    if (error.hint) process.stderr.write(`  ${error.hint}\n`);
  } else {
    process.stderr.write(`✗ ${error?.stack ?? error}\n`);
  }
  process.exit(1);
});
