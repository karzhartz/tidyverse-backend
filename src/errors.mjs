// Error types the CLI knows how to present nicely.

/** A failure we understand, so the CLI prints the message instead of a stack. */
export class ToolError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = "ToolError";
    this.hint = hint;
  }
}

/** Bad or missing configuration — almost always the .env file. */
export class ConfigError extends ToolError {
  constructor(message, { hint } = {}) {
    super(message, { hint });
    this.name = "ConfigError";
  }
}

/** A command was called with missing or malformed arguments. */
export class UsageError extends ToolError {
  constructor(message, { hint, usage } = {}) {
    super(message, { hint });
    this.name = "UsageError";
    this.usage = usage;
  }
}

/** A request failed in a way the HTTP layer should report with a status code. */
export class HttpError extends ToolError {
  constructor(status, message, { hint, code, details } = {}) {
    super(message, { hint });
    this.name = "HttpError";
    this.status = status;
    this.code = code ?? "error";
    this.details = details;
  }
}
