#!/usr/bin/env node
// wimak-tools — server-side staff administration for Wimak Total Care.
//
// Creating an admin used to be two manual steps in the Supabase dashboard plus
// a hand-written SQL insert. This CLI does both halves, and can list, link,
// re-role, deactivate and re-password the accounts it creates.
//
// It talks to Supabase with the SECRET key, so it must only be run on a trusted
// machine. See README.md.

import { ConfigError, ToolError, UsageError } from "./errors.mjs";
import { DEFAULT_ENV_FILE, loadEnvFile, readConfig } from "./config.mjs";
import { createAdminClient, findUserByEmail, listAllUsers, listStaff } from "./supabase.mjs";
import {
  createStaffAccount,
  linkStaffAccount,
  pingAdminApi,
  setStaffActive,
  setStaffPassword,
  setStaffRole,
} from "./supabase.mjs";
import {
  bad,
  detail,
  heading,
  hint,
  info,
  line,
  ok,
  promptHidden,
  style,
  table,
  warn,
} from "./output.mjs";
import { parseArgs, parseBoolean } from "./args.mjs";
import {
  ROLE_DESCRIPTIONS,
  ROLES,
  generatePassword,
  isValidEmail,
  isValidName,
  normalizeEmail,
  normalizeName,
  parseRole,
  validatePassword,
} from "./validate.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Shared option handling
// ─────────────────────────────────────────────────────────────────────────────

function requireEmail(args) {
  const raw = args.get("email") ?? args.positional[1];
  if (!raw) {
    throw new UsageError("An email address is required.", {
      hint: "Pass --email <address>.",
    });
  }
  if (!isValidEmail(raw)) {
    throw new UsageError(`"${raw}" is not a valid email address.`);
  }
  return normalizeEmail(raw);
}

function requireName(args) {
  const name = normalizeName(args.get("name"));
  if (!isValidName(name)) {
    throw new UsageError("A full name is required (at least 2 characters).", {
      hint: 'Pass --name "Amara Okafor".',
    });
  }
  return name;
}

function requireRole(args, { fallback = null } = {}) {
  const raw = args.get("role") ?? fallback;
  if (raw === null || raw === undefined) {
    throw new UsageError(`A role is required.`, {
      hint: `Pass --role <${ROLES.join("|")}>.`,
    });
  }
  const role = parseRole(raw);
  if (!role) {
    throw new UsageError(`"${raw}" is not a role.`, {
      hint: `Choose one of: ${ROLES.join(", ")}.`,
    });
  }
  return role;
}

function roleLabel(role) {
  return `${role} — ${ROLE_DESCRIPTIONS[role] ?? "unknown"}`;
}

/**
 * Work out the password for a command: from the flag, generated, or asked for
 * interactively (twice). Never logs it.
 */
async function resolvePassword(args) {
  const supplied = args.get("password");

  if (supplied !== undefined) {
    const check = validatePassword(supplied);
    if (!check.ok) throw new UsageError(`The password ${check.reason}.`);
    if (supplied.length < 12) {
      warn("That password is shorter than 12 characters — consider a longer one.");
    }
    return { password: supplied, origin: "flag" };
  }

  if (args.flag("generate-password") || args.flag("generate")) {
    return { password: generatePassword(20), origin: "generated" };
  }

  const password = await promptHidden("Password: ");
  const check = validatePassword(password);
  if (!check.ok) throw new UsageError(`That password ${check.reason}.`);
  const repeated = await promptHidden("Repeat password: ");
  if (repeated !== password) throw new UsageError("The passwords did not match.");
  return { password, origin: "prompted" };
}

/** Print a generated password exactly once, where it can be copied. */
function announcePassword(password, origin) {
  if (origin === "generated") {
    line();
    warn("Generated password — copy it now. It is not stored and cannot be shown again.");
    line(`  ${style.bold(password)}`);
  } else if (origin === "prompted") {
    line();
    hint("Password set from the prompt.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

async function commandCheck({ config, client, envPath }) {
  heading("Configuration");
  detail("url", config.url);
  detail("secret key", `${config.secretKey.slice(0, 11)}… (${config.keyKind})`);
  detail("file", envPath);

  const { total } = await pingAdminApi(client);
  ok(`Auth admin API reachable — ${total} account${total === 1 ? "" : "s"}.`);

  const staff = await listStaff(client);
  ok(`PostgREST reachable — ${staff.length} staff row${staff.length === 1 ? "" : "s"}.`);

  const users = await listAllUsers(client);
  const byId = new Map(users.map((user) => [user.id, user]));

  const unlinked = staff.filter((row) => !row.auth_user_id);
  const dangling = staff.filter((row) => row.auth_user_id && !byId.has(row.auth_user_id));
  const inactive = staff.filter((row) => !row.active);
  const orphans = users.filter(
    (user) => !staff.some((row) => normalizeEmail(row.email) === normalizeEmail(user.email))
  );

  heading("Link health");

  if (unlinked.length === 0 && dangling.length === 0 && orphans.length === 0) {
    ok("Every staff row has a login and every login has a staff row.");
    return;
  }

  if (unlinked.length) {
    warn(`${unlinked.length} staff row(s) with no auth login — these people cannot sign in:`);
    for (const row of unlinked) hint(`${row.email} (${row.role})`);
    hint(`Fix: npm run create -- --name "${unlinked[0].name}" --email ${unlinked[0].email} --role ${unlinked[0].role} --generate-password`);
  }
  if (dangling.length) {
    warn(`${dangling.length} staff row(s) pointing at a deleted auth account:`);
    for (const row of dangling) hint(`${row.email} → ${row.auth_user_id}`);
  }
  if (orphans.length) {
    warn(`${orphans.length} auth account(s) with no staff row — they can sign in but see nothing:`);
    for (const user of orphans) hint(`${normalizeEmail(user.email)}`);
    hint(`Fix: npm run link -- --email ${normalizeEmail(orphans[0].email)} --role manager`);
  }
  if (inactive.length) {
    info(`  (${inactive.length} staff row(s) are deactivated: ${inactive.map((row) => row.email).join(", ")})`);
  }
}

async function commandCreate({ args, client }) {
  const email = requireEmail(args);
  const name = requireName(args);
  const role = requireRole(args);
  const phone = args.get("phone") ? String(args.get("phone")).trim() : null;

  // A password is only resolved when one is needed: for a brand-new login, or
  // when the caller explicitly asks to set one. Re-running `create` for an
  // existing account must not silently reset a password that already works.
  const existingUser = await findUserByEmail(client, email);
  const passwordRequested =
    args.get("password") !== undefined ||
    args.flag("generate-password") ||
    args.flag("generate");

  let password = null;
  let origin = "unchanged";
  if (!existingUser || passwordRequested) {
    ({ password, origin } = await resolvePassword(args));
  }

  const result = await createStaffAccount(client, { name, email, role, password, phone });

  if (args.flag("json")) {
    info(
      JSON.stringify(
        {
          ...result.row,
          password: origin === "generated" ? password : undefined,
          authCreated: result.authCreated,
          passwordChanged: result.passwordSet,
        },
        null,
        2
      )
    );
    return;
  }

  heading(result.authCreated ? "Admin account created" : "Existing login reused");

  if (result.authCreated) {
    ok(`Auth login created for ${email} (email confirmed).`);
  } else {
    ok(`An auth login for ${email} already existed — reused it.`);
  }

  if (result.reassigned) {
    warn(
      `The staff row was linked to a different auth account (${result.existing.auth_user_id}); ` +
        `it now points at ${result.user.id}.`
    );
  }

  ok(`staff row ${result.existing ? "updated and linked" : "created"}.`);

  line();
  detail("name", result.row.name);
  detail("email", result.row.email);
  detail("role", roleLabel(result.row.role));
  detail("staff id", result.row.id);
  detail("auth id", result.user.id);
  detail("active", String(result.row.active));

  if (origin === "unchanged") {
    line();
    hint("Password left unchanged — pass --password or --generate-password to set one.");
    return;
  }

  announcePassword(password, origin);
}

async function commandList({ args, client }) {
  const staff = await listStaff(client);
  const users = await listAllUsers(client);
  const byId = new Map(users.map((user) => [user.id, user]));

  const unlinkedAccounts = users.filter(
    (user) => !staff.some((row) => normalizeEmail(row.email) === normalizeEmail(user.email))
  );

  const linkState = (row) => {
    if (!row.auth_user_id) return "NO LOGIN";
    return byId.has(row.auth_user_id) ? "linked" : "DANGLING";
  };

  if (args.flag("json")) {
    info(
      JSON.stringify(
        {
          staff: staff.map((row) => ({ ...row, link: linkState(row) })),
          authAccountsWithoutStaff: unlinkedAccounts.map((user) => ({
            id: user.id,
            email: user.email,
            created_at: user.created_at,
            last_sign_in_at: user.last_sign_in_at ?? null,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  heading(`${staff.length} staff record${staff.length === 1 ? "" : "s"}`);

  if (staff.length === 0) {
    hint("Nothing yet. Create the first admin with:");
    hint('  npm run create-admin -- --name "Amara Okafor" --email amara@wimaktotalcare.com --generate-password');
  } else {
    table(
      ["EMAIL", "NAME", "ROLE", "ACTIVE", "LOGIN"],
      staff.map((row) => [
        row.email,
        row.name,
        row.role,
        row.active ? "yes" : "no",
        linkState(row),
      ])
    );
  }

  heading(`${unlinkedAccounts.length} auth account${unlinkedAccounts.length === 1 ? "" : "s"} with no staff record`);

  if (unlinkedAccounts.length === 0) {
    hint("None.");
  } else {
    table(
      ["EMAIL", "CREATED", "LAST SIGN-IN"],
      unlinkedAccounts.map((user) => [
        normalizeEmail(user.email),
        (user.created_at ?? "").slice(0, 10),
        user.last_sign_in_at ? user.last_sign_in_at.slice(0, 10) : "never",
      ])
    );
    hint(`Link one: npm run link -- --email ${normalizeEmail(unlinkedAccounts[0].email)} --role manager`);
  }
}

async function commandLink({ args, client }) {
  const email = requireEmail(args);
  const role = args.has("role") ? requireRole(args) : null;
  const name = args.get("name") ? normalizeName(args.get("name")) : null;

  if (name !== null && !isValidName(name)) {
    throw new UsageError("--name must be at least 2 characters.");
  }

  const result = await linkStaffAccount(client, { email, role, name, phone: args.get("phone") });

  heading(result.created ? "Staff row created for an existing login" : "Staff row re-linked");

  ok(`${email} → ${result.row.role}`);
  line();
  detail("name", result.row.name);
  detail("staff id", result.row.id);
  detail("auth id", result.user.id);
  detail("active", String(result.row.active));

  if (result.previousAuthUserId && result.previousAuthUserId !== result.user.id) {
    warn(`The row previously pointed at auth account ${result.previousAuthUserId}.`);
  }
}

async function commandSetRole({ args, client }) {
  const email = requireEmail(args);
  const role = requireRole(args);

  const { previousRole, row } = await setStaffRole(client, email, role);

  if (previousRole === row.role) {
    ok(`${email} is already ${row.role} — nothing to change.`);
    return;
  }

  heading("Role changed");
  detail("email", row.email);
  detail("was", roleLabel(previousRole));
  detail("now", roleLabel(row.role));
}

async function commandSetActive({ args, client }) {
  const email = requireEmail(args);

  let active;
  if (args.has("active")) {
    active = args.flag("active") ? true : parseBoolean(args.get("active"));
    if (active === null) {
      throw new UsageError(`--active must be true or false, not "${args.get("active")}".`);
    }
  } else if (args.flag("disable") || args.flag("deactivate")) {
    active = false;
  } else if (args.flag("enable") || args.flag("activate")) {
    active = true;
  } else {
    throw new UsageError("Say whether to activate or deactivate.", {
      hint: "Pass --active true or --active false.",
    });
  }

  const { previousActive, row } = await setStaffActive(client, email, active);

  if (previousActive === row.active) {
    ok(`${email} is already ${row.active ? "active" : "deactivated"} — nothing to change.`);
    return;
  }

  heading(row.active ? "Account activated" : "Account deactivated");
  detail("email", row.email);
  detail("role", row.role);
  detail("active", String(row.active));

  if (!row.active) {
    hint("They keep their login but every table read is refused, so the dashboard shows nothing.");
  }
}

async function commandResetPassword({ args, client }) {
  const email = requireEmail(args);
  const { password, origin } = await resolvePassword(args);

  await setStaffPassword(client, email, password);

  heading("Password changed");
  detail("email", email);

  announcePassword(password, origin);
}

// ─────────────────────────────────────────────────────────────────────────────
// Help
// ─────────────────────────────────────────────────────────────────────────────

const COMMANDS = {
  check: {
    summary: "Verify the URL and secret key work, and report any broken links",
    usage: "check",
    run: commandCheck,
  },
  create: {
    summary: "Create an auth login and link a staff row (one step)",
    usage: 'create --name "Full Name" --email <address> --role <role> [--password <value> | --generate-password] [--phone <value>] [--json]',
    run: commandCreate,
  },
  list: {
    summary: "List staff rows and any auth accounts that are not linked",
    usage: "list [--json]",
    run: commandList,
  },
  link: {
    summary: "Link an existing auth account to a staff row (creates the row if needed)",
    usage: "link --email <address> [--role <role>] [--name <value>] [--phone <value>]",
    run: commandLink,
  },
  "set-role": {
    summary: "Change a staff member's role",
    usage: "set-role --email <address> --role <role>",
    run: commandSetRole,
  },
  "set-active": {
    summary: "Activate or deactivate a staff member",
    usage: "set-active --email <address> --active <true|false>",
    run: commandSetActive,
  },
  "reset-password": {
    summary: "Set a new password for an existing login",
    usage: "reset-password --email <address> [--password <value> | --generate-password]",
    run: commandResetPassword,
  },
};

function printHelp(subject) {
  if (subject && COMMANDS[subject]) {
    const command = COMMANDS[subject];
    line(style.bold(subject));
    line(`  ${command.summary}`);
    line();
    line(`  Usage: npm run ${subject} -- ${command.usage.replace(/^[a-z-]+ /, "")}`);
    return;
  }

  line(style.bold("wimak-tools — Wimak Total Care staff administration"));
  line();
  line("Usage:  npm run <command> -- [options]");
  line("        node src/cli.mjs <command> [options]");
  line();
  line(style.bold("Commands"));
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  for (const [name, command] of Object.entries(COMMANDS)) {
    line(`  ${style.cyan(name.padEnd(width))}  ${command.summary}`);
  }
  line();
  line(style.bold("Common options"));
  line(`  ${style.cyan("--env <path>".padEnd(width))}  Env file to read (default: .env)`);
  line(`  ${style.cyan("-h, --help".padEnd(width))}  Show this help`);
  line();
  line(`Roles: ${ROLES.map((role) => `${role} (${ROLE_DESCRIPTIONS[role]})`).join(", ")}`);
  line();
  line(style.bold("First run"));
  line("  cp .env.example .env     # then fill in SUPABASE_URL and SUPABASE_SECRET_KEY");
  line("  npm run check");
  line('  npm run create-admin -- --name "Amara Okafor" --email amara@wimaktotalcare.com --generate-password');
  line();
  hint("Run `node src/cli.mjs help <command>` for one command's options.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  const args = parseArgs(argv);

  if (args.flag("help") || args.flag("h")) {
    printHelp(args.positional[0]);
    return 0;
  }

  const name = args.positional[0];

  if (!name || name === "help") {
    printHelp(args.positional[1]);
    return 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    bad(`Unknown command "${name}".`);
    hint("Run `node src/cli.mjs help` for the list of commands.");
    return 2;
  }

  const envFile = args.get("env") ?? DEFAULT_ENV_FILE;
  const loaded = loadEnvFile(envFile);

  if (!loaded.loaded) {
    throw new ConfigError(`No env file at ${loaded.path}.`, {
      hint: "Copy .env.example to .env and fill it in, or pass --env <path>.",
    });
  }

  const config = readConfig();
  const client = createAdminClient(config);

  await command.run({ args, config, client, envPath: loaded.path });
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof UsageError) {
      bad(error.message);
      if (error.hint) hint(error.hint);
      process.exitCode = 2;
      return;
    }
    if (error instanceof ToolError) {
      bad(error.message);
      if (error.hint) hint(error.hint);
      process.exitCode = 1;
      return;
    }
    bad("Unexpected failure:");
    console.error(error);
    process.exitCode = 1;
  });
