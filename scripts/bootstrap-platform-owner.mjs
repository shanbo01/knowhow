/**
 * Grants the first KnowHow Administration owner.
 *
 * Platform roles are only writable through the administration API, which itself
 * requires an existing owner — so a fresh deployment has no way in. This script
 * is that way in, and nothing more: it refuses to run once any active owner
 * exists, which is what makes it safe to ship and safe to run twice.
 *
 *   node scripts/bootstrap-platform-owner.mjs --email=person@example.com --confirm
 *
 * Every later role change belongs in Administration, where it is attributed to
 * the person who made it.
 */
import { Client, Query, TablesDB, Users } from "node-appwrite";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const CONTROLLED = new Set(["staging", "production"]);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required.`);
  return value;
}

function argument(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : "";
}

function fail(message) {
  console.error(`Refused: ${message}`);
  process.exit(1);
}

const environment =
  process.env.KNOWHOW_ENVIRONMENT?.trim().toLowerCase() || "development";
const controlled = CONTROLLED.has(environment);
const endpoint = required("APPWRITE_ENDPOINT");
const projectId = required("APPWRITE_PROJECT_ID");
const apiKey = required("APPWRITE_API_KEY");
const databaseId = process.env.APPWRITE_DATABASE_ID?.trim() || "knowhow_core";

const email = (
  argument("email") ||
  process.env.KNOWHOW_BOOTSTRAP_OWNER_EMAIL ||
  process.env.KNOWHOW_LOCAL_OWNER_EMAIL ||
  ""
)
  .trim()
  .toLowerCase();
if (!email) {
  fail("pass the account to promote as --email=person@example.com.");
}

let parsedEndpoint;
try {
  parsedEndpoint = new URL(endpoint);
} catch {
  fail("APPWRITE_ENDPOINT is not a valid URL.");
}

// The endpoint has to match the environment it claims to be. A development
// bootstrap pointed at a real deployment, or the reverse, is the mistake worth
// preventing here.
if (controlled) {
  if (
    parsedEndpoint.protocol !== "https:" ||
    LOCAL_HOSTS.has(parsedEndpoint.hostname)
  ) {
    fail(
      `KNOWHOW_ENVIRONMENT=${environment} requires an HTTPS Appwrite endpoint on a non-local host.`,
    );
  }
  if (!process.argv.includes("--confirm")) {
    fail(
      `this grants permanent owner access to ${email} on ${parsedEndpoint.host}. Re-run with --confirm.`,
    );
  }
} else if (
  !LOCAL_HOSTS.has(parsedEndpoint.hostname) ||
  !projectId.startsWith("knowhow-local")
) {
  fail(
    "a development bootstrap must target the local Appwrite stack. Set KNOWHOW_ENVIRONMENT for a real deployment.",
  );
}

/** Mirrors deterministicResourceId in lib/server/ids.ts so Administration
 * updates this exact row instead of creating a second one. */
async function deterministicResourceId(prefix, value) {
  const cleanPrefix = prefix.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${cleanPrefix}_${hash.slice(0, 35 - cleanPrefix.length)}`;
}

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);
const users = new Users(client);
const tables = new TablesDB(client);

/** Appwrite failures arrive as SDK or undici errors whose stack traces say
 * nothing useful to whoever is running a deployment. Report the cause. */
async function appwrite(description, operation) {
  try {
    return await operation();
  } catch (error) {
    const detail =
      error?.response?.message || error?.cause?.message || error?.message;
    fail(`could not ${description} at ${parsedEndpoint.origin}: ${detail}`);
  }
}

// The guard that makes this safe to leave in the repository: once anyone holds
// owner access, this script stops being a way to grant it.
const existingOwners = await appwrite("read existing platform roles", () =>
  tables.listRows({
    databaseId,
    tableId: "platform_roles",
    queries: [
      Query.equal("kind", ["owner"]),
      Query.equal("status", ["active"]),
      Query.limit(1),
    ],
    total: false,
  }),
);
if (existingOwners.rows.length) {
  fail(
    "an active Administration owner already exists. Grant further access from Administration, which records who granted it.",
  );
}

const matches = await appwrite(`look up the account ${email}`, () =>
  users.list({
    queries: [Query.equal("email", [email]), Query.limit(2)],
    total: false,
  }),
);
if (matches.users.length !== 1) {
  fail(
    matches.users.length
      ? `more than one account matched ${email}.`
      : `no account matched ${email}. Create the account and verify its email address first.`,
  );
}

const user = matches.users[0];
if (!user.emailVerification) {
  if (controlled) {
    fail(
      `${email} has not verified their email address. Administration access requires a verified account.`,
    );
  }
  // The local stack has no deliverable mail, so verification is granted here
  // rather than blocking a disposable development account.
  await appwrite("verify the development account", () =>
    users.updateEmailVerification({
      userId: user.$id,
      emailVerification: true,
    }),
  );
}

const now = new Date().toISOString();
const rowId = await deterministicResourceId("platrole", `${user.$id}:owner`);
await appwrite("write the owner role", () =>
  tables.upsertRow({
    databaseId,
    tableId: "platform_roles",
    rowId,
    data: {
      user_id: user.$id,
      email: user.email,
      kind: "owner",
      status: "active",
      idempotency_key: rowId,
      created_by: "platform_bootstrap",
      updated_by: "platform_bootstrap",
      payload_json: JSON.stringify({
        email: user.email,
        name: user.name || user.email,
        changes: [{ status: "active", at: now, by: "platform_bootstrap" }],
      }),
    },
    permissions: [],
  }),
);

console.log(
  JSON.stringify(
    {
      environment,
      endpoint: parsedEndpoint.origin,
      projectId,
      userId: user.$id,
      email: user.email,
      role: "owner",
      grantedAt: now,
    },
    null,
    2,
  ),
);
