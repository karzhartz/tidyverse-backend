// Where emails actually go.
//
// Four transports, chosen by EMAIL_TRANSPORT:
//
//   smtp     the production path — talks to a mail server over SMTP
//   resend   the Resend HTTP API, kept for anyone already using it
//   file     writes each message to EMAIL_LOG_DIR, for inspecting rendering
//   console  logs the message; the default when nothing is configured, so a
//            developer can run the whole flow without sending anything
//
// Every transport exposes the same shape: `send(envelope)` and, when it can
// check its own configuration, `verify()`. A send either resolves with a
// provider id or throws. Callers decide whether a failure is fatal (it never
// should be for the customer's booking).

import nodemailer from "nodemailer";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolError } from "./errors.mjs";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// ─────────────────────────────────────────────────────────────────────────────
// SMTP
// ─────────────────────────────────────────────────────────────────────────────

function smtpTransport(config) {
  const smtp = config.smtp;
  if (!smtp) throw new ToolError("SMTP is not configured.");

  const client = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    // `secure: true` is implicit TLS (port 465). On 587/25 the connection opens
    // in the clear and `requireTLS` decides whether to insist on STARTTLS.
    secure: smtp.secure,
    requireTLS: smtp.requireTLS,
    connectionTimeout: smtp.connectionTimeoutMs,
    greetingTimeout: smtp.connectionTimeoutMs,
    socketTimeout: smtp.connectionTimeoutMs,
    tls: { rejectUnauthorized: smtp.rejectUnauthorized },
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
    // The EHLO name. A real hostname reads better in a mail server's logs.
    name: "wimak-service",
  });

  return {
    async send(envelope) {
      let info;
      try {
        info = await client.sendMail({
          from: envelope.from,
          to: envelope.to,
          subject: envelope.subject,
          text: envelope.text,
          html: envelope.html,
          ...(envelope.reply_to ? { replyTo: envelope.reply_to } : {}),
        });
      } catch (error) {
        const code = error?.code ? ` (${error.code})` : "";
        throw new ToolError(
          `SMTP delivery to ${envelope.to} failed${code}: ${error.message}`
        );
      }

      // A per-recipient rejection is a failure even though the server accepted
      // the transaction — treat it as one so the caller can retry.
      const rejected = (info.rejected ?? []).filter(Boolean);
      if (rejected.length > 0) {
        throw new ToolError(`SMTP rejected the recipient(s): ${rejected.join(", ")}`);
      }

      return {
        id: info.messageId,
        accepted: info.accepted ?? [],
        response: info.response ?? null,
      };
    },

    async verify() {
      try {
        return await client.verify();
      } catch (error) {
        const code = error?.code ? ` (${error.code})` : "";
        throw new ToolError(`SMTP verification failed${code}: ${error.message}`);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resend
// ─────────────────────────────────────────────────────────────────────────────

function resendTransport(config) {
  return {
    async send(envelope) {
      const response = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: envelope.from,
          to: [envelope.to],
          subject: envelope.subject,
          html: envelope.html,
          text: envelope.text,
          ...(envelope.reply_to ? { reply_to: envelope.reply_to } : {}),
        }),
      });

      const body = await response.text();
      if (!response.ok) {
        throw new ToolError(
          `Resend rejected the email (${response.status}): ${body.slice(0, 300)}`
        );
      }

      try {
        return JSON.parse(body);
      } catch {
        return { id: null };
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// File and console (local development)
// ─────────────────────────────────────────────────────────────────────────────

function fileTransport(config) {
  return {
    async send(envelope) {
      const dir = config.logDir;
      if (!dir) throw new ToolError("EMAIL_LOG_DIR is not set for the file transport.");

      await mkdir(dir, { recursive: true });
      const safe = String(envelope.subject).replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safe}.json`;
      const path = join(dir, name);
      await writeFile(path, JSON.stringify(envelope, null, 2), "utf8");
      return { id: path };
    },
  };
}

function consoleTransport() {
  return {
    async send(envelope) {
      const preview = String(envelope.text ?? "").split("\n").slice(0, 12).join("\n    ");
      process.stdout.write(
        `\n──── email (console transport) ────\n` +
          `  to:      ${envelope.to}\n` +
          `  subject: ${envelope.subject}\n` +
          `  ${preview}\n` +
          `───────────────────────────────────\n\n`
      );
      return { id: `console:${Date.now()}` };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export function createMailer(config, logger) {
  const kind = config.transport;
  const transport =
    kind === "smtp"
      ? smtpTransport(config)
      : kind === "resend"
        ? resendTransport(config)
        : kind === "file"
          ? fileTransport(config)
          : consoleTransport();

  return {
    transport: kind,

    async send(message) {
      if (!message?.to) throw new ToolError("An email needs a recipient.");

      const envelope = {
        from: message.from ?? config.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        reply_to: message.replyTo ?? config.replyTo ?? null,
      };

      const started = Date.now();
      const result = await transport.send(envelope);

      logger?.info("email sent", {
        transport: kind,
        to: envelope.to,
        subject: envelope.subject,
        id: result?.id ?? null,
        ms: Date.now() - started,
      });

      return result;
    },

    /**
     * Check the transport can talk to its provider, without sending anything.
     * Only SMTP can answer this honestly; the others return true.
     */
    async verify() {
      if (typeof transport.verify !== "function") return true;
      return transport.verify();
    },
  };
}
