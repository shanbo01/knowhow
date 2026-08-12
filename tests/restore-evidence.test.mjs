import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  RestoreEvidenceError,
  assertIsolatedTarget,
  canonicalJson,
  collectDatabaseEvidence,
  collectTableEvidence,
  compareDatabaseEvidence,
  controlledEndpoint,
  privateEvidencePath,
  sealEvidence,
  sha256,
  summarizeRows,
  validateAuditState,
  validateCompletedArchive,
  validateDailyPolicy,
  validateRestoration,
  validateSchema,
  verifyEvidenceSeal,
} from "../scripts/appwrite-restore-evidence.mjs";

const HMAC_KEY = "test-only-backup-evidence-key-with-32-bytes";

function rejectsCode(code) {
  return (error) =>
    error instanceof RestoreEvidenceError && error.code === code;
}

test("restore evidence canonicalizes rows without binding the destination database ID", () => {
  assert.equal(
    canonicalJson({ z: [3, { b: true, a: null }], a: "first" }),
    '{"a":"first","z":[3,{"a":null,"b":true}]}',
  );
  const source = {
    $id: "row_a",
    $databaseId: "knowhow_core",
    $tableId: "workspaces",
    $createdAt: "2026-08-11T00:00:00.000Z",
    $updatedAt: "2026-08-11T00:01:00.000Z",
    payload_json: '{"name":"Synthetic"}',
    status: "active",
  };
  const restored = {
    status: "active",
    payload_json: '{"name":"Synthetic"}',
    $updatedAt: "2026-08-11T00:01:00.000Z",
    $createdAt: "2026-08-11T00:00:00.000Z",
    $tableId: "workspaces",
    $databaseId: "knowhow_restore_rehearsal",
    $id: "row_a",
  };
  assert.deepEqual(summarizeRows([source]), summarizeRows([restored]));
  assert.notEqual(
    summarizeRows([source]).rowsSha256,
    summarizeRows([{ ...restored, status: "suspended" }]).rowsSha256,
  );
});

test("restore evidence paginates every row with uncached stable-ID queries", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    $id: `row_${index}`,
    $databaseId: "source",
    $tableId: "guides",
    $updatedAt: `2026-08-11T00:00:0${index}.000Z`,
    payload_json: "{}",
  }));
  const calls = [];
  const tables = {
    async listRows(input) {
      calls.push(input);
      const parsed = input.queries.map((query) => JSON.parse(query));
      const cursor = parsed.find((query) => query.method === "cursorAfter")?.values[0];
      const limit = parsed.find((query) => query.method === "limit")?.values[0];
      const start = cursor ? rows.findIndex((row) => row.$id === cursor) + 1 : 0;
      return { rows: rows.slice(start, start + limit) };
    },
  };
  const evidence = await collectTableEvidence(tables, {
    databaseId: "source",
    tableId: "guides",
    pageSize: 2,
  });
  assert.equal(evidence.rowCount, 5);
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(
      (call) =>
        call.total === false &&
        call.ttl === 0 &&
        JSON.parse(call.queries[0]).method === "orderAsc" &&
        JSON.parse(call.queries[0]).attribute === "$id",
    ),
  );
});

test("restore evidence fails closed when pagination does not advance", async () => {
  const rows = [
    { $id: "row_a", payload_json: "{}" },
    { $id: "row_b", payload_json: "{}" },
  ];
  const tables = { listRows: async () => ({ rows }) };
  await assert.rejects(
    collectTableEvidence(tables, {
      databaseId: "source",
      tableId: "guides",
      pageSize: 2,
    }),
    rejectsCode("ROW_CURSOR_INVALID"),
  );
});

test("restore schema verification requires every private table definition", async () => {
  const expected = [
    {
      $id: "workspaces",
      $permissions: [],
      enabled: true,
      rowSecurity: false,
      columns: [
        {
          key: "payload_json",
          type: "text",
          required: true,
          array: false,
          default: null,
        },
      ],
      indexes: [{ key: "by_status", type: "key", columns: ["status"] }],
    },
  ];
  const remote = {
    ...expected[0],
    columns: [{ ...expected[0].columns[0], status: "available", error: "" }],
    indexes: [
      {
        ...expected[0].indexes[0],
        status: "available",
        error: "",
        orders: ["ASC"],
      },
    ],
  };
  const tables = {
    get: async () => ({ $id: "restore" }),
    listTables: async () => ({ total: 1, tables: [{ $id: "workspaces" }] }),
    getTable: async () => remote,
  };
  const result = await validateSchema(tables, "restore", expected);
  assert.equal(result.tableCount, 1);
  assert.match(result.schemaSha256, /^[a-f0-9]{64}$/);

  await assert.rejects(
    validateSchema(
      { ...tables, getTable: async () => ({ ...remote, $permissions: ["read(\"any\")"] }) },
      "restore",
      expected,
    ),
    rejectsCode("RESTORE_SCHEMA_DEFINITION_DRIFT"),
  );
});

test("full database evidence covers the manifest without retaining row content", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../infrastructure/appwrite/tables.json", import.meta.url),
      "utf8",
    ),
  );
  const tables = {
    get: async () => ({ $id: "knowhow_restore_a" }),
    listTables: async () => ({
      total: manifest.length,
      tables: manifest.map((table) => ({ $id: table.$id })),
    }),
    getTable: async ({ tableId }) =>
      manifest.find((table) => table.$id === tableId),
    listRows: async ({ tableId }) => ({
      rows:
        tableId === "workspaces"
          ? [
              {
                $id: "workspace_a",
                $databaseId: "knowhow_restore_a",
                $tableId: "workspaces",
                $createdAt: "2026-08-11T00:00:00.000+00:00",
                $updatedAt: "2026-08-11T00:00:00.000+00:00",
                $permissions: [],
                payload_json: JSON.stringify({
                  auditSequence: 0,
                  auditHash: "",
                  title: "must-not-appear-in-evidence",
                }),
              },
            ]
          : [],
    }),
  };
  const evidence = await collectDatabaseEvidence(
    tables,
    "knowhow_restore_a",
    manifest,
  );
  assert.equal(evidence.tableCount, 40);
  assert.equal(evidence.totalRows, 1);
  assert.equal(evidence.tables.length, 40);
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /must-not-appear-in-evidence|payload_json|workspace_a/,
  );
});

test("restore evidence recomputes each sealed audit event and workspace head", () => {
  const event = {
    sequence: 1,
    action: "workspace.created",
    actorUserId: "synthetic-owner",
    actorName: "Synthetic Owner",
    actorEmail: "owner@example.test",
    targetType: "workspace",
    targetId: "workspace_a",
    targetLabel: "",
    summary: "Synthetic workspace created",
    occurredAt: "2026-08-11T00:00:00.000Z",
    metadata: { region: "fra" },
    previousHash: "0".repeat(64),
  };
  const eventHash = sha256(`${event.previousHash}.${canonicalJson(event)}`);
  const audit = {
    $id: "audit_a",
    workspace_id: "workspace_a",
    sequence: 1,
    payload_json: JSON.stringify({ ...event, eventHash }),
  };
  const workspace = {
    $id: "workspace_a",
    payload_json: JSON.stringify({ auditSequence: 1, auditHash: eventHash }),
  };
  assert.deepEqual(validateAuditState([audit], [workspace]), [
    {
      workspaceFingerprint: sha256("knowhow-workspace:workspace_a"),
      sequence: 1,
      eventHash,
    },
  ]);
  const tampered = {
    ...audit,
    payload_json: JSON.stringify({ ...event, summary: "Changed", eventHash }),
  };
  assert.throws(
    () => validateAuditState([tampered], [workspace]),
    rejectsCode("AUDIT_HASH_INVALID"),
  );
});

test("backup metadata must prove an enabled daily policy and fresh completed archive", () => {
  const policy = {
    $id: "daily_policy",
    enabled: true,
    services: ["databases"],
    resourceId: "knowhow_core",
    schedule: "0 2 * * *",
    retention: 7,
  };
  assert.deepEqual(validateDailyPolicy(policy, "knowhow_core"), {
    id: "daily_policy",
    schedule: "0 2 * * *",
    retentionDays: 7,
    enabled: true,
  });
  assert.throws(
    () => validateDailyPolicy({ ...policy, enabled: false }, "knowhow_core"),
    rejectsCode("BACKUP_POLICY_DISABLED"),
  );
  assert.throws(
    () => validateDailyPolicy({ ...policy, resourceId: undefined }, "knowhow_core"),
    rejectsCode("BACKUP_POLICY_TARGET_INVALID"),
  );
  assert.throws(
    () => validateDailyPolicy({ ...policy, schedule: "90 27 * * *" }, "knowhow_core"),
    rejectsCode("BACKUP_POLICY_NOT_DAILY"),
  );

  const archive = {
    $id: "archive_a",
    policyId: "daily_policy",
    status: "completed",
    services: ["databases"],
    resourceId: "knowhow_core",
    $createdAt: "2026-08-11T08:00:00.000+00:00",
    startedAt: "2026-08-11T08:00:01.000+00:00",
    $updatedAt: "2026-08-11T08:05:00.000+00:00",
    size: 4096,
  };
  assert.equal(
    validateCompletedArchive(archive, "knowhow_core", {
      expectedPolicyId: "daily_policy",
      maximumAgeHours: 30,
      now: new Date("2026-08-11T09:00:00.000Z"),
    }).sizeBytes,
    4096,
  );
  assert.throws(
    () =>
      validateCompletedArchive(archive, "knowhow_core", {
        maximumAgeHours: 1,
        now: new Date("2026-08-12T09:00:00.000Z"),
      }),
    rejectsCode("BACKUP_ARCHIVE_STALE"),
  );
});

test("restore metadata binds the completed archive to the isolated database", () => {
  const source = { backup: { archive: { id: "archive_a" } } };
  const restoration = {
    $id: "restoration_a",
    archiveId: "archive_a",
    status: "completed",
    services: ["databases"],
    startedAt: "2026-08-11T09:00:00.000Z",
    $updatedAt: "2026-08-11T09:10:00.000Z",
    options: JSON.stringify({ destinationResourceId: "knowhow_restore_a" }),
  };
  assert.equal(
    validateRestoration(restoration, source, "knowhow_restore_a").id,
    "restoration_a",
  );
  assert.throws(
    () => validateRestoration(restoration, source, "knowhow_core"),
    rejectsCode("RESTORATION_DESTINATION_MISMATCH"),
  );
});

test("source and restored database fingerprints fail on any table drift", () => {
  const database = {
    tableCount: 1,
    totalRows: 2,
    schemaSha256: "a".repeat(64),
    tables: [
      {
        tableId: "workspaces",
        rowCount: 2,
        rowsSha256: "b".repeat(64),
        newestUpdatedAt: "2026-08-11T00:00:00.000Z",
      },
    ],
    auditHeads: [],
    overallSha256: "c".repeat(64),
  };
  assert.equal(compareDatabaseEvidence(database, structuredClone(database)).totalRows, 2);
  const drifted = structuredClone(database);
  drifted.tables[0].rowCount = 1;
  assert.throws(
    () => compareDatabaseEvidence(database, drifted),
    rejectsCode("RESTORE_TABLE_DIGEST_MISMATCH"),
  );
});

test("backup evidence is HMAC sealed and rejects tampering", () => {
  const payload = {
    evidenceVersion: 1,
    kind: "knowhow-backup-source-evidence",
    database: { totalRows: 4 },
  };
  const sealed = sealEvidence(payload, HMAC_KEY, "test-v1");
  assert.deepEqual(verifyEvidenceSeal(sealed, HMAC_KEY, "test-v1"), payload);
  assert.throws(
    () => verifyEvidenceSeal(sealed, HMAC_KEY, "test-v2"),
    rejectsCode("EVIDENCE_HMAC_KEY_ID_MISMATCH"),
  );
  assert.throws(
    () => verifyEvidenceSeal({ ...sealed, database: { totalRows: 5 } }, HMAC_KEY),
    rejectsCode("EVIDENCE_SEAL_MISMATCH"),
  );
});

test("restore verifier accepts only Frankfurt and never the active source database", () => {
  assert.equal(
    controlledEndpoint("https://fra.cloud.appwrite.io/v1"),
    "https://fra.cloud.appwrite.io/v1",
  );
  assert.throws(
    () => controlledEndpoint("https://cloud.appwrite.io/v1"),
    rejectsCode("APPWRITE_ENDPOINT_NOT_FRANKFURT"),
  );
  assert.throws(
    () => controlledEndpoint("https://fra.cloud.appwrite.io:8443/v1"),
    rejectsCode("APPWRITE_ENDPOINT_NOT_FRANKFURT"),
  );
  assert.throws(
    () => controlledEndpoint("https://fra.cloud.appwrite.io:443/v1"),
    rejectsCode("APPWRITE_ENDPOINT_NOT_FRANKFURT"),
  );
  const source = {
    projectFingerprint: sha256("knowhow-appwrite-project:project_a"),
    databaseId: "knowhow_core",
  };
  assert.throws(
    () => assertIsolatedTarget(source, "project_a", "knowhow_core"),
    rejectsCode("RESTORE_TARGET_NOT_ISOLATED"),
  );
  assert.doesNotThrow(() =>
    assertIsolatedTarget(source, "project_a", "knowhow_restore_a"),
  );
});

test("evidence files inside the workspace must stay beneath ignored temporary storage", () => {
  const workspace = resolve("restore-evidence-workspace");
  assert.equal(
    privateEvidencePath(resolve(workspace, ".tmp", "restore", "source.json"), workspace),
    resolve(workspace, ".tmp", "restore", "source.json"),
  );
  assert.throws(
    () => privateEvidencePath(resolve(workspace, "source.json"), workspace),
    rejectsCode("EVIDENCE_PATH_NOT_PRIVATE"),
  );
  assert.doesNotThrow(() =>
    privateEvidencePath(resolve(workspace, "..", "private-evidence", "source.json"), workspace),
  );
});
