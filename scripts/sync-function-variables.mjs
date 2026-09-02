/**
 * Pushes each Appwrite Function's environment variables from the current
 * environment.
 *
 * The functions are declared in appwrite.config.json and pushed with the
 * Appwrite CLI, but their variables cannot travel with them: most are secrets,
 * and a committed config is the wrong place for a signing key. This reads them
 * from the environment the deployment already has and syncs them over the API.
 *
 *   node --env-file=.env.production scripts/sync-function-variables.mjs
 *
 * Values are never printed. Only key names, and whether each was created,
 * updated, or already current.
 */
import { readFile } from "node:fs/promises";

/**
 * What each function reads at run time, checked against its source.
 * APPWRITE_FUNCTION_* variables are injected by Appwrite and are absent here on
 * purpose — so is any API key, because both functions prefer the dynamic key
 * Appwrite supplies from the scopes declared in appwrite.config.json.
 */
const FUNCTION_VARIABLES = {
  "knowhow-operations": {
    required: [
      "APPWRITE_DATABASE_ID",
      "APPWRITE_PRIVATE_MEDIA_BUCKET_ID",
      "APPWRITE_EXPORTS_BUCKET_ID",
      "KNOWHOW_ENVIRONMENT",
      "KNOWHOW_WEB_ORIGIN",
      "KNOWHOW_TOKEN_KEYS_JSON",
      "KNOWHOW_TOKEN_ACTIVE_KID",
      "KNOWHOW_DELETION_RECEIPT_PEPPER",
    ],
    optional: [
      "KNOWHOW_PLATFORM_OWNER_EMAILS",
      "RESEND_API_KEY",
      "RESEND_FROM",
      "KNOWHOW_APPWRITE_ENDPOINT",
      "KNOWHOW_SMTP_HOST",
      "KNOWHOW_SMTP_PORT",
      "KNOWHOW_SMTP_USERNAME",
      "KNOWHOW_SMTP_PASSWORD",
      "KNOWHOW_SMTP_FROM",
    ],
  },
  "knowhow-export": {
    required: [
      "KNOWHOW_ENVIRONMENT",
      "KNOWHOW_SITE_ORIGIN",
      "KNOWHOW_EXPORT_WORKER_SECRET",
    ],
    optional: ["KNOWHOW_APPWRITE_ENDPOINT"],
  },
};

const SECRET = /(secret|key|pepper|password|token)/i;

function fail(message) {
  console.error(`Refused: ${message}`);
  process.exit(1);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required.`);
  return value;
}

const endpoint = required("APPWRITE_ENDPOINT").replace(/\/$/, "");
const projectId = required("APPWRITE_PROJECT_ID");
const apiKey = required("APPWRITE_API_KEY");
const apply = process.argv.includes("--apply");

async function api(path, options = {}) {
  const response = await fetch(`${endpoint}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-appwrite-project": projectId,
      "x-appwrite-key": apiKey,
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    fail(
      `${options.method ?? "GET"} ${path} returned ${response.status}: ${
        body.message ?? "no message"
      }`,
    );
  }
  return body;
}

const config = JSON.parse(await readFile("appwrite.config.json", "utf8"));
const declared = new Set((config.functions ?? []).map((fn) => fn.$id));
for (const id of Object.keys(FUNCTION_VARIABLES)) {
  if (!declared.has(id)) {
    fail(`${id} is not declared in appwrite.config.json.`);
  }
}

// Collect every missing value before touching anything, so a half-configured
// environment fails as one readable list rather than one variable at a time.
const missing = [];
for (const [functionId, spec] of Object.entries(FUNCTION_VARIABLES)) {
  for (const key of spec.required) {
    if (!process.env[key]?.trim()) missing.push(`${functionId}: ${key}`);
  }
}
if (missing.length) {
  fail(`the environment is missing required values:\n  ${missing.join("\n  ")}`);
}

let changed = 0;
for (const [functionId, spec] of Object.entries(FUNCTION_VARIABLES)) {
  const wanted = new Map();
  for (const key of [...spec.required, ...spec.optional]) {
    const value = process.env[key]?.trim();
    if (value) wanted.set(key, value);
    else console.log(`  ${functionId}  ${key}  skipped (not set)`);
  }

  const existing = await api(`/functions/${functionId}/variables`);
  const byKey = new Map(
    (existing.variables ?? []).map((variable) => [variable.key, variable]),
  );

  for (const [key, value] of wanted) {
    const current = byKey.get(key);
    // Appwrite redacts secret variable values on read, so an unchanged secret
    // is indistinguishable from a changed one. Write it every time rather than
    // silently leaving a rotated secret behind.
    const secret = SECRET.test(key);
    if (current && !secret && current.value === value) {
      console.log(`  ${functionId}  ${key}  current`);
      continue;
    }
    if (!apply) {
      console.log(`  ${functionId}  ${key}  ${current ? "would update" : "would create"}`);
      changed += 1;
      continue;
    }
    if (current) {
      await api(`/functions/${functionId}/variables/${current.$id}`, {
        method: "PUT",
        body: JSON.stringify({ key, value }),
      });
      console.log(`  ${functionId}  ${key}  updated`);
    } else {
      // Appwrite 1.9 requires an explicit id on create, the same way project
      // keys do; "unique()" asks the server to allocate one.
      await api(`/functions/${functionId}/variables`, {
        method: "POST",
        body: JSON.stringify({ variableId: "unique()", key, value }),
      });
      console.log(`  ${functionId}  ${key}  created`);
    }
    changed += 1;
  }

  for (const key of byKey.keys()) {
    if (!wanted.has(key)) {
      console.log(`  ${functionId}  ${key}  present but no longer declared`);
    }
  }
}

console.log(
  apply
    ? `\n${changed} variable${changed === 1 ? "" : "s"} written.`
    : `\n${changed} variable${changed === 1 ? "" : "s"} would change. Re-run with --apply.`,
);
