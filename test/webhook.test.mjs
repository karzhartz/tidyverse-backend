import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.mjs";
import { createStripeClient } from "../src/stripe.mjs";

// Exercises the real Express app over a real socket: raw-body handling,
// signature verification and status codes. The database is a stub that throws,
// so a test that unexpectedly reaches it fails loudly rather than quietly
// passing.

const WEBHOOK_SECRET = "whsec_test_secret";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function config(overrides = {}) {
  return {
    supabase: { url: "https://example.supabase.co" },
    stripe: {
      secretKey: "sk_test_x",
      webhookSecret: WEBHOOK_SECRET,
      currency: "usd",
      taxRateId: null,
      automaticTax: false,
      successUrl: "https://site.test/{REFERENCE}",
      cancelUrl: "https://site.test/{REFERENCE}",
    },
    email: { transport: "console", from: "a@b.co", replyTo: null, resendApiKey: null, logDir: null },
    http: {
      host: "127.0.0.1",
      port: 0,
      corsOrigins: ["http://localhost:8080"],
      siteUrl: "http://localhost:8080",
      adminToken: null,
      trustProxy: false,
      ...(overrides.http ?? {}),
    },
  };
}

async function withServer(run, overrides = {}) {
  const stripe = createStripeClient({ secretKey: "sk_test_x" });
  const client = {
    rpc: async () => {
      throw new Error("the database must not be reached in this test");
    },
  };
  const mailer = { send: async () => ({ id: "stub" }) };

  const app = createApp({
    config: config(overrides),
    client,
    stripe,
    mailer,
    logger: silentLogger,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  try {
    await run({ port, stripe });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const sign = (stripe, payload) =>
  stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

test("GET /health reports the mode without leaking keys", async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.stripeMode, "test");
    assert.equal(body.emailTransport, "console");
    assert.equal(JSON.stringify(body).includes("sk_test_x"), false);
  });
});

test("the webhook rejects an unsigned request", async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_1", type: "ping" }),
    });

    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_signature");
  });
});

test("the webhook rejects a signature made with the wrong secret", async () => {
  await withServer(async ({ port, stripe }) => {
    const payload = JSON.stringify({ id: "evt_1", type: "ping", data: { object: {} } });
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_the_wrong_secret",
    });

    const res = await fetch(`http://127.0.0.1:${port}/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": header },
      body: payload,
    });

    assert.equal(res.status, 400);
  });
});

test("a correctly signed event we do not act on is acknowledged, not applied", async () => {
  await withServer(async ({ port, stripe }) => {
    const payload = JSON.stringify({
      id: "evt_ping",
      object: "event",
      type: "ping",
      data: { object: {} },
    });

    const res = await fetch(`http://127.0.0.1:${port}/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": sign(stripe, payload) },
      body: payload,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ignored, true);
    assert.equal(body.type, "ping");
  });
});

test("a signed event that needs the database answers 500 so Stripe retries", async () => {
  await withServer(async ({ port, stripe }) => {
    const payload = JSON.stringify({
      id: "evt_expired",
      object: "event",
      type: "checkout.session.expired",
      data: { object: { id: "cs_test_1", client_reference_id: "WTC-ABC123" } },
    });

    const res = await fetch(`http://127.0.0.1:${port}/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": sign(stripe, payload) },
      body: payload,
    });

    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, "apply_failed");
  });
});

test("creating a booking validates the body before touching the database", async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer: {}, serviceId: "" }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "validation_error");
  });
});

test("a non-JSON body is a clean 400", async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_json");
  });
});

test("CORS answers a preflight only for an allowed origin", async () => {
  await withServer(async ({ port }) => {
    const allowed = await fetch(`http://127.0.0.1:${port}/api/bookings`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:8080" },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:8080");

    const denied = await fetch(`http://127.0.0.1:${port}/api/bookings`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.test" },
    });
    assert.equal(denied.status, 204);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  });
});

test("an unknown route is a JSON 404", async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "not_found");
  });
});

// ── CORS ─────────────────────────────────────────────────────────────────────
// A literal "*" in CORS_ORIGINS used to match no origin at all, so the browser
// saw no Access-Control-Allow-Origin and refused the request. These pin the
// behaviour that made "CORS request did not succeed" go away.

test("CORS_ORIGINS=* allows any origin on a preflight", async () => {
  await withServer(
    async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/bookings`, {
        method: "OPTIONS",
        headers: {
          origin: "https://anywhere.test",
          "access-control-request-method": "GET",
          "access-control-request-headers": "content-type",
        },
      });

      assert.equal(res.status, 204);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      assert.match(res.headers.get("access-control-allow-methods"), /GET/);
      assert.match(res.headers.get("access-control-allow-headers"), /Content-Type/i);
    },
    { http: { corsOrigins: ["*"] } }
  );
});

test("CORS_ORIGINS=* stamps the header on error responses too", async () => {
  await withServer(
    async ({ port }) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/bookings/WTC-ABC123?email=a@b.co`,
        { headers: { origin: "https://anywhere.test" } }
      );

      // The stub database throws, so this is a 5xx — but the browser must still
      // be able to read the body, which needs the header.
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
    },
    { http: { corsOrigins: ["*"] } }
  );
});

test("an allow-list still refuses an origin that is not on it", async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/bookings`, {
      method: "OPTIONS",
      headers: { origin: "https://anywhere.test" },
    });

    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});
