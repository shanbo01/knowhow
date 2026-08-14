import { Client, Query, TablesDB, Users } from "node-appwrite";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const endpoint = required("APPWRITE_ENDPOINT");
const projectId = required("APPWRITE_PROJECT_ID");
const apiKey = required("APPWRITE_API_KEY");
const email = required("KNOWHOW_LOCAL_OWNER_EMAIL").toLowerCase();
const parsedEndpoint = new URL(endpoint);

if (
  !["localhost", "127.0.0.1", "::1"].includes(parsedEndpoint.hostname) ||
  !projectId.startsWith("knowhow-local") ||
  process.env.KNOWHOW_ENVIRONMENT !== "development"
) {
  throw new Error(
    "Local owner bootstrap refused: endpoint, project, and environment must identify the disposable local stack.",
  );
}

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);
const users = new Users(client);
const tables = new TablesDB(client);

const matches = await users.list({
  queries: [Query.equal("email", [email]), Query.limit(2)],
  total: false,
});

if (matches.users.length !== 1) {
  throw new Error(
    matches.users.length
      ? `More than one local account matched ${email}.`
      : `Create and verify the local account ${email} before assigning the owner role.`,
  );
}

const user = matches.users[0];
if (!user.emailVerification) {
  await users.updateEmailVerification({
    userId: user.$id,
    emailVerification: true,
  });
}

const rowId = `local_owner_${user.$id}`.slice(0, 36);
await tables.upsertRow({
  databaseId: required("APPWRITE_DATABASE_ID"),
  tableId: "platform_roles",
  rowId,
  data: {
    user_id: user.$id,
    kind: "owner",
    status: "active",
    created_by: "local_development_bootstrap",
    payload_json: JSON.stringify({
      role: "owner",
      source: "local_development_bootstrap",
    }),
  },
  permissions: [],
});

console.log(
  JSON.stringify({
    endpoint,
    projectId,
    userId: user.$id,
    email: user.email,
    verified: true,
    role: "owner",
  }),
);
