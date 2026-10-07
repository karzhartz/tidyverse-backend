// Configuration: load .env, read the two values, and refuse to run with the
// wrong kind of key.
//
// This project is the one place the Supabase *secret* key is allowed to live,
// so it is worth being pedantic about which key it is. A publishable/anon key
// pasted here produces a confusing 401 from the admin API; catching it at
// startup turns that into a sentence that says what is wrong.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ConfigError } from "./errors.mjs";

/** Names accepted for the secret key, newest first. */
export const SECRET_ENV_NAMES = [
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_SECRET",
];

export const DEFAULT_ENV_FILE = ".env";

/**
 * Load `path` into process.env.
 *
 * `process.loadEnvFile` (Node >= 20.12) does not overwrite variables that are
 * already set, so a value exported in the shell wins over the file — which is
 * what you want when overriding for a single run.
 */
export function loadEnvFile(path = DEFAULT_ENV_FILE) {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);

  if (!existsSync(absolute)) {
    return { loaded: false, path: absolute };
  }

  try {
    process.loadEnvFile(absolute);
  } catch (error) {
    throw new ConfigError(`Could not read ${absolute}: ${error.message}`);
  }

  return { loaded: true, path: absolute };
}

/**
 * Classify an API key so a mistake is caught before a request is made.
 *
 * @returns {"secret" | "publishable" | "anon" | "service_role" | "jwt" | "unknown"}
 */
export function classifyKey(key) {
  const value = String(key ?? "").trim();

  if (value.startsWith("sb_secret_")) return "secret";
  if (value.startsWith("sb_publishable_")) return "publishable";

  if (value.startsWith("eyJ")) {
    const payload = value.split(".")[1];
    if (!payload) return "jwt";
    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (decoded?.role === "service_role") return "service_role";
      if (decoded?.role === "anon") return "anon";
      return "jwt";
    } catch {
      return "jwt";
    }
  }

  return "unknown";
}

/** Keys that identify the project but cannot administer it. */
export function isPublicKey(kind) {
  return kind === "publishable" || kind === "anon";
}

/**
 * Read and validate configuration. Throws ConfigError with a fixable message.
 *
 * @returns {{ url: string, secretKey: string, keyKind: string }}
 */
export function readConfig(env = process.env) {
  const url = String(env.SUPABASE_URL ?? "").trim();
  const secretKey =
    SECRET_ENV_NAMES.map((name) => String(env[name] ?? "").trim()).find(Boolean) ?? "";

  if (!url) {
    throw new ConfigError("SUPABASE_URL is not set.", {
      hint: "Copy .env.example to .env and fill it in.",
    });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`SUPABASE_URL is not a valid URL: ${url}`, {
      hint: "It should look like https://<project-ref>.supabase.co",
    });
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigError(`SUPABASE_URL must be http(s), not ${parsed.protocol}//`, {
      hint: "Use the Project URL, not the postgres connection string.",
    });
  }

  if (!secretKey) {
    throw new ConfigError("No secret key found.", {
      hint: `Set one of ${SECRET_ENV_NAMES.join(", ")} — see .env.example.`,
    });
  }

  const keyKind = classifyKey(secretKey);

  if (isPublicKey(keyKind)) {
    throw new ConfigError(
      `SUPABASE_SECRET_KEY holds the PUBLIC ${keyKind} key, which cannot create users.`,
      {
        hint:
          "Projects → Settings → API → secret key (sb_secret_...) or service_role. " +
          "The public key belongs in the clients, never here.",
      }
    );
  }

  return {
    url: url.replace(/\/+$/, ""),
    secretKey,
    keyKind,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Service configuration (the HTTP server)
// ─────────────────────────────────────────────────────────────────────────────

const read = (env, name) => String(env[name] ?? "").trim();

function readBool(env, name, fallback = false) {
  const raw = read(env, name).toLowerCase();
  if (raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false, got "${raw}".`);
}

function readInt(env, name, fallback) {
  const raw = read(env, name);
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ConfigError(`${name} must be a port number, got "${raw}".`);
  }
  return value;
}

/** A duration in milliseconds — socket timeouts, not ports. */
function readMillis(env, name, fallback) {
  const raw = read(env, name);
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1000) {
    throw new ConfigError(`${name} must be milliseconds (>= 1000), got "${raw}".`);
  }
  return value;
}

function readUrl(env, name, fallback) {
  const raw = read(env, name) || fallback;
  try {
    const parsed = new URL(raw);
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new ConfigError(`${name} is not a valid URL: ${raw}`);
  }
}

/**
 * Read everything the HTTP server needs: Supabase (secret key), Stripe, email
 * and the listener. Throws on the first thing that would not work, so a bad
 * deploy fails at boot rather than at the first customer's checkout.
 *
 * @returns {{
 *   supabase: { url: string, secretKey: string, keyKind: string },
 *   stripe: { secretKey: string, webhookSecret: string, currency: string,
 *             taxRateId: string|null, automaticTax: boolean, successUrl: string,
 *             cancelUrl: string },
 *   email: { transport: string, from: string, replyTo: string|null,
 *            resendApiKey: string|null, logDir: string|null },
 *   http: { host: string, port: number, corsOrigins: string[], siteUrl: string,
 *           adminToken: string|null, trustProxy: boolean }
 * }}
 */
export function readServiceConfig(env = process.env) {
  const supabase = readConfig(env);

  // ── Stripe ───────────────────────────────────────────────────────────────
  const stripeSecretKey = read(env, "STRIPE_SECRET_KEY");
  const stripeWebhookSecret = read(env, "STRIPE_WEBHOOK_SECRET");

  if (!stripeSecretKey) {
    throw new ConfigError("STRIPE_SECRET_KEY is not set.", {
      hint: "Stripe → Developers → API keys → secret key (sk_live_... / sk_test_...).",
    });
  }
  if (!/^(sk|rk)_(test|live)_/.test(stripeSecretKey)) {
    throw new ConfigError(
      "STRIPE_SECRET_KEY does not look like a Stripe secret key.",
      { hint: "It should start with sk_test_, sk_live_, rk_test_ or rk_live_." }
    );
  }
  if (!stripeWebhookSecret) {
    throw new ConfigError("STRIPE_WEBHOOK_SECRET is not set.", {
      hint:
        "Stripe → Developers → Webhooks → your endpoint → signing secret (whsec_...). " +
        "Without it the webhook cannot be verified, so it is not optional.",
    });
  }

  const siteUrl = readUrl(env, "PUBLIC_SITE_URL", "http://localhost:8080");
  const successUrl =
    read(env, "STRIPE_SUCCESS_URL") ||
    `${siteUrl}/booking-confirmed?reference={REFERENCE}&checkout=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl =
    read(env, "STRIPE_CANCEL_URL") ||
    `${siteUrl}/booking-confirmed?reference={REFERENCE}&checkout=cancelled`;

  // ── Email ────────────────────────────────────────────────────────────────
  // SMTP is the production transport. `console` and `file` stay for local work;
  // `resend` remains available for anyone already using it.
  const resendApiKey = read(env, "RESEND_API_KEY") || null;

  const smtpHost = read(env, "SMTP_HOST") || null;
  const smtpUser = read(env, "SMTP_USER") || null;
  const smtpPassword = read(env, "SMTP_PASSWORD") || null;
  const smtpPortRaw = read(env, "SMTP_PORT");
  const smtpSecureRaw = read(env, "SMTP_SECURE");

  if (smtpUser && !smtpPassword) {
    throw new ConfigError("SMTP_USER is set but SMTP_PASSWORD is not.", {
      hint: "Set both, or leave both blank for a relay that needs no authentication.",
    });
  }
  if (smtpPassword && !smtpUser) {
    throw new ConfigError("SMTP_PASSWORD is set but SMTP_USER is not.", {
      hint: "Set both, or leave both blank for a relay that needs no authentication.",
    });
  }

  const smtpPort = smtpPortRaw === "" ? null : readInt(env, "SMTP_PORT", 587);
  // 465 is implicit TLS; 587 and 25 start plain and upgrade with STARTTLS.
  const smtpSecure =
    smtpSecureRaw === "" ? smtpPort === 465 : readBool(env, "SMTP_SECURE", false);

  const smtp = smtpHost
    ? {
        host: smtpHost,
        port: smtpPort ?? (smtpSecure ? 465 : 587),
        secure: smtpSecure,
        requireTLS: readBool(env, "SMTP_REQUIRE_TLS", false),
        rejectUnauthorized: readBool(env, "SMTP_REJECT_UNAUTHORIZED", true),
        connectionTimeoutMs: readMillis(env, "SMTP_CONNECTION_TIMEOUT_MS", 20_000),
        user: smtpUser,
        password: smtpPassword,
      }
    : null;

  // An explicit EMAIL_TRANSPORT wins; otherwise prefer whatever is configured,
  // so setting SMTP_HOST is enough to switch delivery.
  const transport = (
    read(env, "EMAIL_TRANSPORT") ||
    (smtp ? "smtp" : resendApiKey ? "resend" : "console")
  ).toLowerCase();

  if (!["smtp", "resend", "console", "file"].includes(transport)) {
    throw new ConfigError(`EMAIL_TRANSPORT is "${transport}".`, {
      hint: "Supported: smtp, resend, console, file.",
    });
  }
  if (transport === "smtp" && !smtp) {
    throw new ConfigError("EMAIL_TRANSPORT=smtp but SMTP_HOST is not set.", {
      hint: "Set SMTP_HOST, with SMTP_PORT / SMTP_USER / SMTP_PASSWORD as needed.",
    });
  }
  if (transport === "resend" && !resendApiKey) {
    throw new ConfigError("EMAIL_TRANSPORT=resend but RESEND_API_KEY is not set.", {
      hint: "Set RESEND_API_KEY, or use EMAIL_TRANSPORT=smtp.",
    });
  }

  const email = {
    transport,
    from:
      read(env, "EMAIL_FROM") ||
      // Resend's sandbox sender works before a domain is verified. SMTP has no
      // such thing, so it gets an address on the company domain that must be
      // accepted by the server.
      (transport === "resend"
        ? "Wimak Total Care <onboarding@resend.dev>"
        : "Wimak Total Care <bookings@wimaktotalcare.com>"),
    replyTo: read(env, "EMAIL_REPLY_TO") || null,
    resendApiKey,
    smtp,
    logDir: read(env, "EMAIL_LOG_DIR") || null,
  };

  // ── HTTP ─────────────────────────────────────────────────────────────────
  const corsOrigins = (read(env, "CORS_ORIGINS") || siteUrl)
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  return {
    supabase,
    stripe: {
      secretKey: stripeSecretKey,
      webhookSecret: stripeWebhookSecret,
      currency: (read(env, "STRIPE_CURRENCY") || "usd").toLowerCase(),
      taxRateId: read(env, "STRIPE_TAX_RATE_ID") || null,
      automaticTax: readBool(env, "STRIPE_AUTOMATIC_TAX", false),
      successUrl,
      cancelUrl,
    },
    email,
    http: {
      // Loopback by default: this process holds the secret key and should sit
      // behind a reverse proxy rather than on a public interface.
      host: read(env, "HOST") || "127.0.0.1",
      port: readInt(env, "PORT", 8787),
      corsOrigins,
      siteUrl,
      adminToken: read(env, "ADMIN_API_TOKEN") || null,
      trustProxy: readBool(env, "TRUST_PROXY", false),
    },
  };
}
