import { BetaAccessService } from "../lib/server/beta-access-service";
import { createRequestServices } from "../lib/server/request-services";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function required(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const endpoint = required("APPWRITE_ENDPOINT", process.env.APPWRITE_ENDPOINT);
const projectId = required(
  "APPWRITE_PROJECT_ID",
  process.env.APPWRITE_PROJECT_ID,
);
const databaseId = required(
  "APPWRITE_DATABASE_ID",
  process.env.APPWRITE_DATABASE_ID,
);
const parsedEndpoint = new URL(endpoint);
const email = required("--email", argument("--email")).toLowerCase();
const label = argument("--label") ?? "Local private-beta rehearsal";
const maxUses = Number(argument("--max-uses") ?? "1");
const days = Number(argument("--days") ?? "2");

if (
  parsedEndpoint.protocol !== "http:" ||
  parsedEndpoint.hostname !== "localhost" ||
  parsedEndpoint.port ||
  parsedEndpoint.pathname !== "/v1" ||
  parsedEndpoint.search ||
  parsedEndpoint.hash ||
  projectId !== "knowhow-local" ||
  databaseId !== "knowhow_core" ||
  process.env.KNOWHOW_ENVIRONMENT !== "development" ||
  process.env.KNOWHOW_REGISTRATION_MODE !== "private_beta"
) {
  throw new Error(
    "Local beta bootstrap refused: use the exact disposable localhost project in development private-beta mode.",
  );
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error("--email must be a valid exact email address.");
}
if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 100) {
  throw new Error("--max-uses must be an integer from 1 to 100.");
}
if (!Number.isSafeInteger(days) || days < 1 || days > 30) {
  throw new Error("--days must be an integer from 1 to 30.");
}

const { store } = createRequestServices();
const result = await store.transaction((transaction) =>
  new BetaAccessService(transaction).createGrant({
    actorUserId: "local_rehearsal_bootstrap",
    label,
    exactEmail: email,
    expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    maxUses,
    requestId: `local_beta_${crypto.randomUUID()}`,
  }),
);

// The plaintext code is intentionally emitted once and never written to disk.
process.stdout.write(
  JSON.stringify({
    endpoint,
    projectId,
    email,
    grantId: result.grant.id,
    expiresAt: result.grant.expiresAt,
    code: result.code,
  }),
);
