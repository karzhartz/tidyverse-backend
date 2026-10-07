// The Express application.
//
// Wiring only: middleware order, the routers, and error shaping. The webhook
// router is mounted before the JSON body parser because it needs the raw bytes.

import express from "express";
import { HttpError } from "./errors.mjs";
import { healthRoutes } from "./routes/health.mjs";
import { bookingRoutes } from "./routes/bookings.mjs";
import { webhookRoutes } from "./routes/webhooks.mjs";

function requestLogger(logger) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      // Health checks are noise at this volume; everything else is worth a line.
      if (req.path === "/health") return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      logger.info("request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(ms),
      });
    });
    next();
  };
}

function cors(origins, logger) {
  // "*" means any origin. It is safe here because this API never uses cookies
  // or credentials — access is decided by secret keys and the database, not by
  // an ambient browser session.
  const allowAll = origins.includes("*");
  const allowed = new Set(origins.filter((origin) => origin !== "*"));

  return (req, res, next) => {
    const origin = req.get("origin");

    if (origin && (allowAll || allowed.has(origin))) {
      res.set("Access-Control-Allow-Origin", allowAll ? "*" : origin);
      // "Vary: Origin" keeps caches from serving one origin's headers to
      // another. With "*" the response is the same for everyone, so it is moot.
      if (!allowAll) res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.set("Access-Control-Max-Age", "600");
    } else if (origin) {
      // The browser will block this. Say so on the server too, because "CORS
      // request did not succeed" in the console says nothing about which origin
      // was refused or which ones are configured.
      logger?.warn("blocked a cross-origin request", {
        origin,
        allowed: allowAll ? "*" : [...allowed],
        path: req.path,
      });
    }

    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}

function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars -- Express identifies it by arity.
  return (error, req, res, _next) => {
    if (error instanceof HttpError) {
      if (error.status >= 500) {
        logger.error("request failed", { path: req.path, message: error.message });
      }
      return res.status(error.status).json({
        ok: false,
        error: error.code,
        message: error.message,
        ...(error.status < 500 && error.hint ? { hint: error.hint } : {}),
        ...(error.details ? { details: error.details } : {}),
      });
    }

    if (error?.type === "entity.parse.failed") {
      return res.status(400).json({
        ok: false,
        error: "invalid_json",
        message: "The request body is not valid JSON.",
      });
    }
    if (error?.type === "entity.too.large") {
      return res.status(413).json({
        ok: false,
        error: "payload_too_large",
        message: "The request body is too large.",
      });
    }

    logger.error("unhandled error", { path: req.path, message: error?.message, stack: error?.stack });
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      message: "Something went wrong.",
    });
  };
}

export function createApp({
  config,
  client,
  stripe,
  mailer,
  logger,
  version = "0.0.0",
  startedAt = Date.now(),
}) {
  const app = express();
  app.disable("x-powered-by");
  if (config.http.trustProxy) app.set("trust proxy", 1);

  app.use(requestLogger(logger));

  // Raw body first — see routes/webhooks.mjs.
  app.use("/webhooks", webhookRoutes({ client, stripe, config, mailer, logger }));

  app.use(cors(config.http.corsOrigins, logger));
  app.use(express.json({ limit: "64kb" }));

  app.use("/api", bookingRoutes({ client, stripe, config, mailer, logger }));
  app.use(healthRoutes({ config, version, startedAt }));

  app.use((req, res) =>
    res.status(404).json({
      ok: false,
      error: "not_found",
      message: `No route for ${req.method} ${req.path}`,
    })
  );

  app.use(errorHandler(logger));

  return app;
}
