// Terminal output helpers. Plain and readable, with colour only on a TTY and
// never when NO_COLOR is set (https://no-color.org).

import { ToolError } from "./errors.mjs";

const COLOUR =
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const paint = (code) => (text) => (COLOUR ? `\u001b[${code}m${text}\u001b[0m` : String(text));

export const style = {
  bold: paint("1"),
  dim: paint("2"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  cyan: paint("36"),
};

export const line = (message = "") => console.log(message);
export const heading = (text) => console.log(`\n${style.bold(text)}`);
export const info = (message) => console.log(message);
export const ok = (message) => console.log(`${style.green("✓")} ${message}`);
export const warn = (message) => console.log(`${style.yellow("!")} ${message}`);
export const bad = (message) => console.error(`${style.red("✗")} ${message}`);
export const hint = (message) => console.log(`  ${style.dim(message)}`);

/** `label   value`, used for the small key/value blocks after a command runs. */
export function detail(label, value) {
  console.log(`  ${style.dim(String(label).padEnd(12))} ${value}`);
}

/** A left-aligned text table with a header row. */
export function table(headers, rows) {
  const cells = rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))));
  const widths = headers.map((header, i) =>
    Math.max(String(header).length, ...cells.map((row) => (row[i] ?? "").length))
  );

  const render = (row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i])))
      .join("  ")
      .trimEnd();

  console.log(`  ${style.dim(render(headers))}`);
  for (const row of cells) console.log(`  ${render(row)}`);
}

/** Read a password without echoing it. Only possible on a real terminal. */
export async function promptHidden(question) {
  const { stdin, stdout } = process;

  if (!stdin.isTTY) {
    throw new ToolError("No terminal available to prompt for a password.", {
      hint: "Pass --password <value>, or --generate-password to have one generated.",
    });
  }

  stdout.write(question);
  const wasRaw = stdin.isRaw === true;
  if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let buffer = "";

    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(buffer);
          return;
        }
        if (char === "\u0003") {
          // Ctrl-C
          cleanup();
          stdout.write("\n");
          reject(new ToolError("Cancelled."));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          buffer = buffer.slice(0, -1);
          continue;
        }
        if (char >= " ") buffer += char;
      }
    };

    stdin.on("data", onData);
  });
}
