import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, parseBoolean } from "../src/args.mjs";

test("--key value becomes a value", () => {
  const args = parseArgs(["create", "--role", "admin", "--email", "a@b.co"]);
  assert.deepEqual(args.positional, ["create"]);
  assert.equal(args.get("role"), "admin");
  assert.equal(args.get("email"), "a@b.co");
  assert.ok(args.has("role"));
});

test("--key=value works too", () => {
  const args = parseArgs(["--role=manager"]);
  assert.equal(args.get("role"), "manager");
});

test("a lone --key becomes a boolean flag", () => {
  const args = parseArgs(["create", "--generate-password"]);
  assert.equal(args.flag("generate-password"), true);
  assert.equal(args.get("generate-password"), undefined);
});

test("a flag followed by another option does not swallow it", () => {
  const args = parseArgs(["--generate-password", "--email", "a@b.co"]);
  assert.ok(args.flag("generate-password"));
  assert.equal(args.get("email"), "a@b.co");
});

test("short flags cluster and are boolean", () => {
  const args = parseArgs(["-h"]);
  assert.ok(args.flag("h"));
});

test("-- ends option parsing", () => {
  const args = parseArgs(["create", "--", "--not-an-option", "-x"]);
  assert.deepEqual(args.positional, ["create", "--not-an-option", "-x"]);
});

test("positional arguments collect in order", () => {
  const args = parseArgs(["help", "create"]);
  assert.deepEqual(args.positional, ["help", "create"]);
});

test("empty argv is harmless", () => {
  const args = parseArgs([]);
  assert.deepEqual(args.positional, []);
  assert.equal(args.get("anything"), undefined);
  assert.equal(args.flag("anything"), false);
});

test("parseBoolean understands the obvious spellings", () => {
  assert.equal(parseBoolean("true"), true);
  assert.equal(parseBoolean("YES"), true);
  assert.equal(parseBoolean("1"), true);
  assert.equal(parseBoolean("false"), false);
  assert.equal(parseBoolean("no"), false);
  assert.equal(parseBoolean("0"), false);
  assert.equal(parseBoolean(true), true);
  assert.equal(parseBoolean(false), false);
  assert.equal(parseBoolean("maybe"), null);
  assert.equal(parseBoolean(undefined), null);
});
