import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  Account,
  AppwriteException,
  Client,
  Functions,
  Messaging,
  Query,
  Sites,
  Storage,
  TablesDB,
  Users,
} from "node-appwrite";
import { InputFile } from "node-appwrite/file";
import {
  assertBucketContract,
  assertControlledMutationBinding,
  assertDatabaseContract,
  assertFunctionContract,
  assertSiteContract,
  assertTableContract,
  controlledSiteOrigin,
  resolveSmokeTarget,
} from "./appwrite-contract-guards.mjs";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const { endpoint, target } = resolveSmokeTarget(required("APPWRITE_ENDPOINT"), {
  allowStaging: process.argv.includes("--allow-staging"),
  allowProduction: process.argv.includes("--allow-production"),
  environment: process.env.KNOWHOW_ENVIRONMENT,
});
const endpointUrl = new URL(endpoint);
const localEndpoint = target === "self-host";
const controlledTarget = !localEndpoint;

const projectId = required("APPWRITE_PROJECT_ID");
const apiKey = required("APPWRITE_API_KEY");
assert.ok(
  apiKey.length >= 20 && !apiKey.toLowerCase().includes("replace-with-"),
  "APPWRITE_API_KEY is invalid.",
);
assertControlledMutationBinding({
  target,
  projectId,
  expectedProjectId: process.env.KNOWHOW_SMOKE_EXPECTED_PROJECT_ID?.trim(),
  forbiddenProjectId: process.env.KNOWHOW_SMOKE_FORBIDDEN_PROJECT_ID?.trim(),
  confirmation: process.env.KNOWHOW_SMOKE_MUTATION_CONFIRM,
  syntheticOnly: process.env.KNOWHOW_SMOKE_SYNTHETIC_ONLY,
  finalProduction: process.env.KNOWHOW_SMOKE_FINAL_PRODUCTION,
});
const databaseId = process.env.APPWRITE_DATABASE_ID?.trim() || "knowhow_core";
const mediaBucketId =
  process.env.APPWRITE_PRIVATE_MEDIA_BUCKET_ID?.trim() ||
  "knowhow_private_media";
const exportBucketId =
  process.env.APPWRITE_EXPORTS_BUCKET_ID?.trim() || "knowhow_exports";
const runId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const rowId = `smoke_row_${runId}`;
const committedTransactionRowId = `smoke_tx_commit_${runId}`;
const rolledBackTransactionRowId = `smoke_tx_rollback_${runId}`;
const fileId = `smoke_file_${runId}`;
const userId = `smoke_user_${runId}`;
const email = `${userId}@example.test`;
const password = `Smoke-${runId}-Aa1!`;

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);
const tables = new TablesDB(client);
const storage = new Storage(client);
const users = new Users(client);
const messaging = new Messaging(client);
const functions = new Functions(client);
const sites = new Sites(client);

const expectedDatabases = JSON.parse(
  await readFile(new URL("../infrastructure/appwrite/databases.json", import.meta.url)),
);
const expectedTables = JSON.parse(
  await readFile(new URL("../infrastructure/appwrite/tables.json", import.meta.url)),
);
const expectedBuckets = JSON.parse(
  await readFile(new URL("../infrastructure/appwrite/buckets.json", import.meta.url)),
);
const expectedAppwriteConfig = JSON.parse(
  await readFile(new URL("../appwrite.config.json", import.meta.url)),
);
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const checks = [];
const pass = (name, detail) => checks.push({ name, status: "passed", detail });
const openTransactionIds = new Set();
const createdTransactionIds = new Set();
let sessionSecret;
const cleanupFailures = [];
const recordCleanupFailure = (label, error) => {
  if (error?.code !== 404)
    cleanupFailures.push(`${label}:${error?.code ?? "unknown"}`);
};
const verifyMissing = async (label, operation) => {
  try {
    await operation();
    cleanupFailures.push(`${label}:still-present`);
  } catch (error) {
    recordCleanupFailure(label, error);
  }
};

try {
  const versionResponse = await fetch(`${endpoint}/health/version`);
  assert.equal(versionResponse.ok, true, "Appwrite health/version did not respond successfully");
  const version = await versionResponse.json();
  pass("appwrite_endpoint", version.version ?? "reachable");

  const database = await tables.get({ databaseId });
  const expectedDatabase = expectedDatabases.find(
    (candidate) => candidate.$id === databaseId,
  );
  assert.ok(expectedDatabase, "Configured database is absent from the checked-in contract");
  assertDatabaseContract(expectedDatabase, database);
  const remoteDatabases = await tables.list({
    queries: [Query.limit(100)],
    total: false,
  });
  assert.deepEqual(
    remoteDatabases.databases.map((candidate) => candidate.$id).sort(),
    expectedDatabases.map((candidate) => candidate.$id).sort(),
    "Deployed database IDs drift from the checked-in schema",
  );
  const remoteTables = await tables.listTables({
    databaseId,
    queries: [Query.limit(100)],
    total: false,
  });
  const remoteIds = new Set(remoteTables.tables.map((table) => table.$id));
  assert.deepEqual(
    [...remoteIds].sort(),
    expectedTables.map((table) => table.$id).sort(),
    "Deployed table IDs drift from the checked-in schema",
  );
  for (const expected of expectedTables) {
    const remote = await tables.getTable({
      databaseId,
      tableId: expected.$id,
    });
    assertTableContract(expected, remote);
  }
  pass(
    "tables_schema",
    `${expectedDatabases.length} database and ${expectedTables.length} exact private-table contracts match`,
  );

  for (const expected of expectedBuckets) {
    const remote = await storage.getBucket({ bucketId: expected.$id });
    assertBucketContract(expected, remote);
  }
  const remoteBuckets = await storage.listBuckets({
    queries: [Query.limit(100)],
    total: false,
  });
  assert.deepEqual(
    remoteBuckets.buckets.map((bucket) => bucket.$id).sort(),
    expectedBuckets.map((bucket) => bucket.$id).sort(),
    "Deployed bucket IDs drift from the checked-in resources",
  );
  assert.deepEqual(
    [mediaBucketId, exportBucketId].sort(),
    expectedBuckets.map((bucket) => bucket.$id).sort(),
    "Runtime bucket IDs drift from the checked-in resources",
  );
  pass("private_storage_schema", `${expectedBuckets.length} private buckets match`);

  if (controlledTarget) {
    const remoteFunctions = await functions.list({
      queries: [Query.limit(100)],
      total: false,
    });
    assert.deepEqual(
      remoteFunctions.functions.map((fn) => fn.$id).sort(),
      expectedAppwriteConfig.functions.map((fn) => fn.$id).sort(),
      "Deployed Function IDs drift from appwrite.config.json",
    );
    for (const expected of expectedAppwriteConfig.functions) {
      assertFunctionContract(
        expected,
        await functions.get({ functionId: expected.$id }),
      );
    }
    const remoteSites = await sites.list({
      queries: [Query.limit(100)],
      total: false,
    });
    assert.deepEqual(
      remoteSites.sites.map((site) => site.$id).sort(),
      expectedAppwriteConfig.sites.map((site) => site.$id).sort(),
      "Deployed Site IDs drift from appwrite.config.json",
    );
    for (const expected of expectedAppwriteConfig.sites) {
      assertSiteContract(expected, await sites.get({ siteId: expected.$id }));
    }
    pass(
      "function_site_deployments",
      `${expectedAppwriteConfig.functions.length} Functions and ${expectedAppwriteConfig.sites.length} Site are exact, live, and on their latest ready deployments`,
    );
  }

  const anonymous = await fetch(
    `${endpoint}/tablesdb/${encodeURIComponent(databaseId)}/tables/idempotency_keys/rows`,
    { headers: { "x-appwrite-project": projectId } },
  );
  assert.ok(
    anonymous.status === 401 || anonymous.status === 403,
    `Anonymous TablesDB access returned ${anonymous.status}`,
  );
  pass("anonymous_denial", `TablesDB returned ${anonymous.status}`);

  await tables.createRow({
    databaseId,
    tableId: "idempotency_keys",
    rowId,
    data: {
      workspace_id: `smoke_${runId}`,
      idempotency_key: `smoke:${runId}`,
      status: "active",
      payload_json: JSON.stringify({ smoke: true }),
    },
    permissions: [],
  });
  const row = await tables.getRow({
    databaseId,
    tableId: "idempotency_keys",
    rowId,
  });
  assert.equal(row.status, "active");
  await tables.updateRow({
    databaseId,
    tableId: "idempotency_keys",
    rowId,
    data: { status: "completed" },
  });
  assert.equal(
    (
      await tables.getRow({
        databaseId,
        tableId: "idempotency_keys",
        rowId,
      })
    ).status,
    "completed",
  );
  pass("tables_crud", "create/get/update succeeded");

  const beginTransaction = async () => {
    const transaction = await tables.createTransaction({ ttl: 60 });
    openTransactionIds.add(transaction.$id);
    createdTransactionIds.add(transaction.$id);
    return transaction.$id;
  };
  const finishTransaction = async (transactionId, action) => {
    await tables.updateTransaction({ transactionId, [action]: true });
    openTransactionIds.delete(transactionId);
  };
  const rowIsMissing = (error) =>
    error instanceof AppwriteException && error.code === 404;

  const commitTransactionId = await beginTransaction();
  await tables.createRow({
    databaseId,
    tableId: "idempotency_keys",
    rowId: committedTransactionRowId,
    data: {
      workspace_id: `smoke_${runId}`,
      idempotency_key: `smoke:transaction:commit:${runId}`,
      status: "staged",
      payload_json: JSON.stringify({ smoke: true, transaction: "commit" }),
    },
    permissions: [],
    transactionId: commitTransactionId,
  });
  await assert.rejects(
    () =>
      tables.getRow({
        databaseId,
        tableId: "idempotency_keys",
        rowId: committedTransactionRowId,
      }),
    rowIsMissing,
  );
  assert.equal(
    (
      await tables.getRow({
        databaseId,
        tableId: "idempotency_keys",
        rowId: committedTransactionRowId,
        transactionId: commitTransactionId,
      })
    ).status,
    "staged",
  );
  await tables.updateRow({
    databaseId,
    tableId: "idempotency_keys",
    rowId: committedTransactionRowId,
    data: { status: "committed" },
    transactionId: commitTransactionId,
  });
  await finishTransaction(commitTransactionId, "commit");
  assert.equal(
    (
      await tables.getRow({
        databaseId,
        tableId: "idempotency_keys",
        rowId: committedTransactionRowId,
      })
    ).status,
    "committed",
  );

  const rollbackTransactionId = await beginTransaction();
  await tables.createRow({
    databaseId,
    tableId: "idempotency_keys",
    rowId: rolledBackTransactionRowId,
    data: {
      workspace_id: `smoke_${runId}`,
      idempotency_key: `smoke:transaction:rollback:${runId}`,
      status: "staged",
      payload_json: JSON.stringify({ smoke: true, transaction: "rollback" }),
    },
    permissions: [],
    transactionId: rollbackTransactionId,
  });
  assert.equal(
    (
      await tables.getRow({
        databaseId,
        tableId: "idempotency_keys",
        rowId: rolledBackTransactionRowId,
        transactionId: rollbackTransactionId,
      })
    ).status,
    "staged",
  );
  await finishTransaction(rollbackTransactionId, "rollback");
  await assert.rejects(
    () =>
      tables.getRow({
        databaseId,
        tableId: "idempotency_keys",
        rowId: rolledBackTransactionRowId,
      }),
    rowIsMissing,
  );

  const conflictTransactionId = await beginTransaction();
  await tables.updateRow({
    databaseId,
    tableId: "idempotency_keys",
    rowId,
    data: { status: "staged-conflict" },
    transactionId: conflictTransactionId,
  });
  await tables.updateRow({
    databaseId,
    tableId: "idempotency_keys",
    rowId,
    data: { status: "outside-conflict" },
  });
  await assert.rejects(
    () => tables.updateTransaction({ transactionId: conflictTransactionId, commit: true }),
    (error) => error instanceof AppwriteException && error.code === 409,
  );
  await tables
    .updateTransaction({ transactionId: conflictTransactionId, rollback: true })
    .catch(() => undefined);
  openTransactionIds.delete(conflictTransactionId);
  assert.equal(
    (
      await tables.getRow({
        databaseId,
        tableId: "idempotency_keys",
        rowId,
      })
    ).status,
    "outside-conflict",
  );
  pass(
    "tables_transactions",
    "read-your-writes, atomic commit/rollback, and conflict rejection succeeded",
  );

  await storage.createFile({
    bucketId: mediaBucketId,
    fileId,
    file: InputFile.fromBuffer(onePixelPng, "smoke.png"),
    permissions: [],
  });
  const downloaded = Buffer.from(
    await storage.getFileDownload({ bucketId: mediaBucketId, fileId }),
  );
  assert.deepEqual(downloaded, onePixelPng);
  pass("storage_crud", "private PNG upload/download integrity succeeded");

  await users.create({ userId, email, password, name: "KnowHow smoke user" });
  const adminAccount = new Account(client);
  const session = await adminAccount.createEmailPasswordSession({ email, password });
  sessionSecret = session.secret;
  assert.ok(sessionSecret, "Server-side session did not return a secret");
  const sessionClient = new Client()
    .setEndpoint(endpoint)
    .setProject(projectId)
    .setSession(sessionSecret);
  const sessionAccount = new Account(sessionClient);
  const account = await sessionAccount.get();
  assert.equal(account.$id, userId);
  await sessionAccount.deleteSession({ sessionId: "current" });
  sessionSecret = undefined;
  pass("server_session_auth", "email/password session and cookie-secret identity succeeded");

  const providers = await messaging.listProviders({ total: false });
  if (controlledTarget) {
    assert.equal(
      process.env.KNOWHOW_SMOKE_REQUIRE_EMAIL_PROVIDER,
      "1",
      "Controlled smoke must require a Messaging provider.",
    );
    assert.equal(
      process.env.KNOWHOW_SMOKE_REQUIRE_READY,
      "1",
      "Controlled smoke must require live Site readiness.",
    );
  }
  if (process.env.KNOWHOW_SMOKE_REQUIRE_EMAIL_PROVIDER === "1") {
    assert.ok(providers.providers.length > 0, "No Appwrite Messaging provider is configured");
  }
  pass(
    "messaging_adapter",
    `${providers.providers.length} provider(s) visible${providers.providers.length ? "" : "; delivery intentionally not required for local smoke"}`,
  );

  const rawSiteOrigin = process.env.KNOWHOW_SMOKE_SITE_ORIGIN?.trim();
  if (controlledTarget)
    assert.ok(rawSiteOrigin, "KNOWHOW_SMOKE_SITE_ORIGIN is required for controlled smoke.");
  const siteOrigin = rawSiteOrigin
    ? controlledSiteOrigin(rawSiteOrigin, target)
    : undefined;
  if (siteOrigin) {
    for (const path of ["/api/health", "/api/auth/health"]) {
      const response = await fetch(`${siteOrigin}${path}`);
      assert.equal(response.status, 200, `${path} returned ${response.status}`);
    }
    if (process.env.KNOWHOW_SMOKE_REQUIRE_READY === "1" || controlledTarget) {
      const readyResponse = await fetch(`${siteOrigin}/api/health?ready=1`);
      assert.equal(readyResponse.status, 200, `readiness returned ${readyResponse.status}`);
      const readiness = await readyResponse.json();
      assert.equal(readiness.status, "ready", "Site readiness body did not report ready");
      if (controlledTarget) {
        const expectedRelease = required("KNOWHOW_SMOKE_EXPECTED_RELEASE");
        assert.deepEqual(
          readiness.deployment,
          {
            environment:
              target === "frankfurt-staging" ? "staging" : "production",
            release: expectedRelease,
            projectFingerprint: createHash("sha256")
              .update(`project\0${projectId}`)
              .digest("hex"),
          },
          "The live Site is not bound to the expected environment, release, and Appwrite project",
        );
      }
    }
    for (const check of [
      { path: "/api/knowhow" },
      { path: "/api/knowhow/media?workspaceId=smoke&mediaId=smoke" },
      { path: "/api/knowhow/export?jobId=smoke" },
      { path: "/api/knowhow/audit?workspaceId=smoke" },
      { path: "/api/extension/context" },
    ]) {
      const response = await fetch(`${siteOrigin}${check.path}`);
      assert.ok(
        [401, 403].includes(response.status),
        `Anonymous ${check.path} access returned ${response.status}`,
      );
    }
    pass(
      "next_api_contract",
      "health/readiness/auth identity and anonymous product/media/export/audit/extension denial succeeded",
    );
  } else {
    pass("next_api_contract", "not run; set KNOWHOW_SMOKE_SITE_ORIGIN while Next.js is running");
  }
} finally {
  for (const transactionId of openTransactionIds) {
    await tables
      .updateTransaction({ transactionId, rollback: true })
      .catch((error) => recordCleanupFailure(`rollback:${transactionId}`, error));
  }
  for (const transactionId of createdTransactionIds) {
    await tables
      .deleteTransaction({ transactionId })
      .catch((error) => recordCleanupFailure(`transaction:${transactionId}`, error));
  }
  for (const transactionRowId of [
    committedTransactionRowId,
    rolledBackTransactionRowId,
  ]) {
    await tables
      .deleteRow({
        databaseId,
        tableId: "idempotency_keys",
        rowId: transactionRowId,
      })
      .catch((error) => recordCleanupFailure(`row:${transactionRowId}`, error));
  }
  await storage
    .deleteFile({ bucketId: mediaBucketId, fileId })
    .catch((error) => recordCleanupFailure(`file:${fileId}`, error));
  await tables
    .deleteRow({ databaseId, tableId: "idempotency_keys", rowId })
    .catch((error) => recordCleanupFailure(`row:${rowId}`, error));
  await users
    .delete({ userId })
    .catch((error) => recordCleanupFailure(`user:${userId}`, error));
  for (const transactionId of createdTransactionIds) {
    await verifyMissing(`transaction:${transactionId}`, () =>
      tables.getTransaction({ transactionId }),
    );
  }
  for (const transactionRowId of [
    committedTransactionRowId,
    rolledBackTransactionRowId,
  ]) {
    await verifyMissing(`row:${transactionRowId}`, () =>
      tables.getRow({
        databaseId,
        tableId: "idempotency_keys",
        rowId: transactionRowId,
      }),
    );
  }
  await verifyMissing(`file:${fileId}`, () =>
    storage.getFile({ bucketId: mediaBucketId, fileId }),
  );
  await verifyMissing(`row:${rowId}`, () =>
    tables.getRow({ databaseId, tableId: "idempotency_keys", rowId }),
  );
  await verifyMissing(`user:${userId}`, () => users.get({ userId }));
}

assert.deepEqual(
  cleanupFailures,
  [],
  `Smoke cleanup was incomplete: ${cleanupFailures.join(", ")}`,
);

process.stdout.write(
  `${JSON.stringify(
    {
      status: "passed",
      target,
      endpoint: endpointUrl.origin,
      projectId,
      checks,
      cleanup: "transient rows, file, user, session, and transactions removed",
    },
    null,
    2,
  )}\n`,
);
