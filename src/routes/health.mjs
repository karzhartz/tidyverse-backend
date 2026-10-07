// Liveness and a little configuration introspection.
//
// Deliberately leaks nothing secret: no keys, no project ref, just enough to
// confirm which mode the process booted in.

import { Router } from "express";

export function healthRoutes({ config, version, startedAt }) {
  const router = Router();

  router.get("/health", (_req, res) => {
    const key = config.stripe.secretKey;
    res.json({
      ok: true,
      service: "wimak-service",
      version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
      stripeMode: /_(live)_/.test(key) ? "live" : "test",
      emailTransport: config.email.transport,
      siteUrl: config.http.siteUrl,
    });
  });

  return router;
}
