// Supabase access. One place that knows how to talk to Auth's admin API and to
// PostgREST, so the commands stay about intent.

import { createClient } from "@supabase/supabase-js";
import { ToolError } from "./errors.mjs";
import { normalizeEmail } from "./validate.mjs";

/** A client using the secret key: server-side only, bypasses row level security. */
export function createAdminClient({ url, secretKey }) {
  return createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "x-client-info": "wimak-tools" },
    },
  });
}

/** Turn a supabase-js error into something a person can act on. */
function fail(action, error) {
  const message = error?.message ?? String(error);
  const hint = error?.hint ?? undefined;
  return new ToolError(`${action}: ${message}`, { hint });
}

const USERS_PER_PAGE = 200;
const MAX_PAGES = 100;

/** Every auth account, following Supabase's pagination. */
export async function listAllUsers(client) {
  const users = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({
      page,
      perPage: USERS_PER_PAGE,
    });
    if (error) throw fail("Could not list auth users", error);

    const batch = data?.users ?? [];
    users.push(...batch);
    if (batch.length < USERS_PER_PAGE) return users;
  }

  throw new ToolError(
    `Refusing to page through more than ${MAX_PAGES * USERS_PER_PAGE} auth users.`
  );
}

/** Case-insensitive lookup of an auth account by email. */
export async function findUserByEmail(client, email) {
  const target = normalizeEmail(email);
  const users = await listAllUsers(client);
  return users.find((user) => normalizeEmail(user.email) === target) ?? null;
}

/** The `staff` row for an email, or null. */
export async function findStaffByEmail(client, email) {
  const { data, error } = await client
    .from("staff")
    .select("id, auth_user_id, name, email, role, phone, active, created_at")
    .eq("email", normalizeEmail(email))
    .maybeSingle();

  if (error) throw fail(`Could not read the staff row for ${email}`, error);
  return data ?? null;
}

export async function listStaff(client) {
  const { data, error } = await client
    .from("staff")
    .select("id, auth_user_id, name, email, role, phone, active, created_at")
    .order("created_at", { ascending: true });

  if (error) throw fail("Could not read staff", error);
  return data ?? [];
}

/**
 * Create the auth login if needed, then link it to a `staff` row.
 *
 * The two half-steps the project docs describe as manual — add the user in the
 * dashboard, paste the UUID into an insert — happen here, in one command, and
 * the result is idempotent: running it twice reuses the account and re-links
 * the row instead of failing on a duplicate email.
 */
export async function createStaffAccount(client, { name, email, role, password, phone }) {
  const address = normalizeEmail(email);

  // ── 1. Auth account ──────────────────────────────────────────────────────
  let user = await findUserByEmail(client, address);
  const authCreated = user === null;
  let passwordSet = false;

  if (authCreated) {
    if (!password) {
      throw new ToolError(`Refusing to create a login for ${address} without a password.`);
    }
    const { data, error } = await client.auth.admin.createUser({
      email: address,
      password,
      // The dashboard expects to sign straight in; there is no inbox to click.
      email_confirm: true,
      user_metadata: { name },
    });
    if (error) throw fail(`Supabase refused to create the login for ${address}`, error);
    user = data.user;
    passwordSet = true;
  } else if (password) {
    const { error } = await client.auth.admin.updateUserById(user.id, { password });
    if (error) throw fail(`Could not set a new password for ${address}`, error);
    passwordSet = true;
  }

  // ── 2. staff row ─────────────────────────────────────────────────────────
  const existing = await findStaffByEmail(client, address);
  const reassigned = Boolean(existing?.auth_user_id && existing.auth_user_id !== user.id);

  const payload = {
    auth_user_id: user.id,
    name,
    email: address,
    role,
    active: true,
    ...(phone ? { phone } : {}),
  };

  const { data: row, error } = await client
    .from("staff")
    .upsert(payload, { onConflict: "email" })
    .select("id, auth_user_id, name, email, role, phone, active, created_at")
    .single();

  if (error) throw fail(`Could not write the staff row for ${address}`, error);

  return { user, row, authCreated, existing, reassigned, passwordSet };
}

/** Point an existing auth account at a `staff` row, creating the row if absent. */
export async function linkStaffAccount(client, { email, role, name, phone }) {
  const address = normalizeEmail(email);

  const user = await findUserByEmail(client, address);
  if (!user) {
    throw new ToolError(`No auth account exists for ${address}.`, {
      hint: "Run the create command first — there is no login to link.",
    });
  }

  const existing = await findStaffByEmail(client, address);

  const payload = {
    auth_user_id: user.id,
    email: address,
    role: role ?? existing?.role ?? "manager",
    name: name ?? existing?.name ?? user.user_metadata?.name ?? address.split("@")[0],
    active: existing?.active ?? true,
    ...(phone ? { phone } : {}),
  };

  const { data: row, error } = await client
    .from("staff")
    .upsert(payload, { onConflict: "email" })
    .select("id, auth_user_id, name, email, role, phone, active, created_at")
    .single();

  if (error) throw fail(`Could not link the staff row for ${address}`, error);

  return { user, row, created: existing === null, previousAuthUserId: existing?.auth_user_id ?? null };
}

export async function setStaffRole(client, email, role) {
  const existing = await findStaffByEmail(client, email);
  if (!existing) {
    throw new ToolError(`No staff row exists for ${normalizeEmail(email)}.`, {
      hint: "Create or link the account first.",
    });
  }

  const { data, error } = await client
    .from("staff")
    .update({ role })
    .eq("id", existing.id)
    .select("id, email, role, active")
    .single();

  if (error) throw fail(`Could not change the role for ${email}`, error);
  return { previousRole: existing.role, row: data };
}

export async function setStaffActive(client, email, active) {
  const existing = await findStaffByEmail(client, email);
  if (!existing) {
    throw new ToolError(`No staff row exists for ${normalizeEmail(email)}.`, {
      hint: "Create or link the account first.",
    });
  }

  const { data, error } = await client
    .from("staff")
    .update({ active })
    .eq("id", existing.id)
    .select("id, email, role, active")
    .single();

  if (error) throw fail(`Could not update ${email}`, error);
  return { previousActive: existing.active, row: data };
}

export async function setStaffPassword(client, email, password) {
  const address = normalizeEmail(email);

  const user = await findUserByEmail(client, address);
  if (!user) {
    throw new ToolError(`No auth account exists for ${address}.`, {
      hint: "Run the create command first.",
    });
  }

  const { error } = await client.auth.admin.updateUserById(user.id, { password });
  if (error) throw fail(`Could not reset the password for ${address}`, error);

  return { user };
}

/** A cheap round-trip that proves the URL and secret key both work. */
export async function pingAdminApi(client) {
  const { data, error } = await client.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error) throw fail("The Auth admin API rejected the credentials", error);
  return { total: data?.total ?? (data?.users ?? []).length };
}
