// Structured logs. One line per event, easy to grep when a webhook misbehaves.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function write(stream, level, message, fields) {
  const entry = {
    at: new Date().toISOString(),
    level,
    message,
    ...(fields && Object.keys(fields).length ? fields : {}),
  };

  let line;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = `${entry.at} ${level} ${message}`;
  }
  stream.write(`${line}\n`);
}

export function createLogger(level = "info", streams = {}) {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  const out = streams.out ?? process.stdout;
  const err = streams.err ?? process.stderr;

  const log = (name) => (message, fields) => {
    if (LEVELS[name] < threshold) return;
    write(name === "error" || name === "warn" ? err : out, name, message, fields);
  };

  return {
    level: String(level).toLowerCase(),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  };
}
