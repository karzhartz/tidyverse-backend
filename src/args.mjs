// A tiny argument parser — enough for a hand-written CLI, no dependency.
//
//   --role admin            -> value
//   --role=admin            -> value
//   --generate-password     -> boolean flag
//   -h                      -> boolean flag
//   positional              -> collected in order
//
// A `--` terminates option parsing, so a password that begins with `-` can be
// passed as `--password -- -dashes` if it ever comes to that.

export function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        values.set(token.slice(2, eq), token.slice(eq + 1));
        continue;
      }
      const key = token.slice(2);
      const next = argv[i + 1];
      // A value is only consumed when the next token is not another option.
      if (next === undefined || next.startsWith("-")) {
        flags.add(key);
      } else {
        values.set(key, next);
        i += 1;
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      for (const ch of token.slice(1)) flags.add(ch);
      continue;
    }

    positional.push(token);
  }

  return {
    has: (key) => values.has(key) || flags.has(key),
    get: (key) => values.get(key),
    flag: (key) => flags.has(key),
    positional,
  };
}

/**
 * Interpret a textual boolean (`--active false`) without guessing.
 * Returns null when the text is not a recognised boolean.
 */
export function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "yes", "y", "1", "on", "active"].includes(text)) return true;
  if (["false", "no", "n", "0", "off", "inactive"].includes(text)) return false;
  return null;
}
