import test from "node:test";
import assert from "node:assert/strict";

import { ConfigError } from "../src/errors.mjs";
import { classifyKey, isPublicKey, readConfig } from "../src/config.mjs";

/** Build a JWT-shaped key with the given `role` claim, as older projects use. */
function jwt(role, extra = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role, ...extra })).toString("base64url");
  return `${header}.${payload}.signature`;
}

test("classifyKey recognises the new key formats", () => {
  assert.equal(classifyKey("sb_secret_abc123"), "secret");
  assert.equal(classifyKey("sb_publishable_abc123"), "publishable");
});

test("classifyKey reads the role out of a legacy JWT", () => {
  assert.equal(classifyKey(jwt("service_role")), "service_role");
  assert.equal(classifyKey(jwt("anon")), "anon");
  assert.equal(classifyKey(jwt("authenticated")), "jwt");
});

test("classifyKey does not throw on junk", () => {
  assert.equal(classifyKey(""), "unknown");
  assert.equal(classifyKey("not-a-key"), "unknown");
  assert.equal(classifyKey("eyJ.not-base64.signature"), "jwt");
});

test("isPublicKey flags only the client-side keys", () => {
  assert.ok(isPublicKey("publishable"));
  assert.ok(isPublicKey("anon"));
  assert.ok(!isPublicKey("secret"));
  assert.ok(!isPublicKey("service_role"));
});

test("readConfig accepts a secret key and trims the URL", () => {
  const config = readConfig({
    SUPABASE_URL: "https://example.supabase.co/",
    SUPABASE_SECRET_KEY: "sb_secret_abc123",
  });

  assert.equal(config.url, "https://example.supabase.co");
  assert.equal(config.secretKey, "sb_secret_abc123");
  assert.equal(config.keyKind, "secret");
});

test("readConfig accepts the legacy service_role variable", () => {
  const config = readConfig({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: jwt("service_role"),
  });
  assert.equal(config.keyKind, "service_role");
});

test("readConfig refuses the public key — the mistake worth catching", () => {
  assert.throws(
    () =>
      readConfig({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SECRET_KEY: "sb_publishable_abc123",
      }),
    (error) => error instanceof ConfigError && /PUBLIC publishable/.test(error.message)
  );

  assert.throws(
    () =>
      readConfig({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SECRET_KEY: jwt("anon"),
      }),
    (error) => error instanceof ConfigError && /PUBLIC anon/.test(error.message)
  );
});

test("readConfig complains about a missing URL", () => {
  assert.throws(
    () => readConfig({ SUPABASE_SECRET_KEY: "sb_secret_abc" }),
    (error) => error instanceof ConfigError && /SUPABASE_URL is not set/.test(error.message)
  );
});

test("readConfig complains about a missing key", () => {
  assert.throws(
    () => readConfig({ SUPABASE_URL: "https://example.supabase.co" }),
    (error) => error instanceof ConfigError && /No secret key/.test(error.message)
  );
});

test("readConfig rejects a URL that is not a URL", () => {
  assert.throws(
    () =>
      readConfig({
        SUPABASE_URL: "not a url",
        SUPABASE_SECRET_KEY: "sb_secret_abc",
      }),
    ConfigError
  );
});

test("readConfig rejects a postgres connection string", () => {
  assert.throws(
    () =>
      readConfig({
        SUPABASE_URL: "postgresql://postgres:secret@db.example.supabase.co:5432/postgres",
        SUPABASE_SECRET_KEY: "sb_secret_abc",
      }),
    (error) => error instanceof ConfigError && /postgres connection string/.test(error.hint ?? "")
  );
});
