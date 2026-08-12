import assert from "node:assert/strict";
import test from "node:test";
import { AppwriteException, type TablesDB } from "node-appwrite";
import { AppwriteRecordStore } from "../lib/server/appwrite-record-store";
import { appendAudit } from "../lib/server/audit-service";
import { TABLES } from "../lib/server/appwrite-resources";
import { decodePayload } from "../lib/server/domain-records";
import { HttpError } from "../lib/server/http-security";
import { consumeFixedWindows } from "../lib/server/rate-limit-service";
import {
  InMemoryRecordStore,
  RecordConflictError,
} from "../lib/server/record-store";
import { identity, seedWorkspace } from "./helpers/appwrite-fixtures";

test("Appwrite transaction conflicts are typed, rolled back, and cleaned up", async () => {
  const calls: string[] = [];
  const tables = {
    createTransaction: async () => ({ $id: "transaction_conflict" }),
    updateTransaction: async ({ commit, rollback }: { commit?: boolean; rollback?: boolean }) => {
      calls.push(commit ? "commit" : rollback ? "rollback" : "update");
      if (commit) {
        throw new AppwriteException("Transaction conflict", 409, "transaction_conflict");
      }
    },
    deleteTransaction: async () => {
      calls.push("delete");
    },
  } as unknown as TablesDB;
  const store = new AppwriteRecordStore(tables, "knowhow_core");

  await assert.rejects(
    store.transaction(async () => "uncommitted"),
    (error: unknown) => error instanceof RecordConflictError,
  );
  assert.deepEqual(calls, ["commit", "rollback", "delete"]);
});

test("record-store transactions serialize concurrent counters and roll back failures", async () => {
  const store = new InMemoryRecordStore();
  await store.create(TABLES.idempotencyKeys, "counter", {
    payload_json: "{}",
    sequence: 0,
  });
  await Promise.all(
    Array.from({ length: 40 }, () =>
      store.transaction(async (transaction) => {
        const current = await transaction.get(TABLES.idempotencyKeys, "counter");
        await Promise.resolve();
        await transaction.update(TABLES.idempotencyKeys, "counter", {
          sequence: Number(current?.sequence ?? 0) + 1,
        });
      }),
    ),
  );
  assert.equal((await store.get(TABLES.idempotencyKeys, "counter"))?.sequence, 40);

  await assert.rejects(
    store.transaction(async (transaction) => {
      await transaction.update(TABLES.idempotencyKeys, "counter", { sequence: 999 });
      await transaction.create(TABLES.idempotencyKeys, "temporary", {
        payload_json: "{}",
      });
      throw new Error("abort");
    }),
    /abort/,
  );
  assert.equal((await store.get(TABLES.idempotencyKeys, "counter"))?.sequence, 40);
  assert.equal(await store.get(TABLES.idempotencyKeys, "temporary"), null);
});

test("durable fixed windows enforce the limit atomically under concurrency", async () => {
  process.env.KNOWHOW_RATE_LIMIT_PEPPER =
    "test-rate-limit-pepper-with-more-than-thirty-two-bytes";
  const store = new InMemoryRecordStore();
  const policy = {
    scope: "test.concurrent",
    subject: "member@example.com",
    limit: 5,
    windowSeconds: 60,
  };
  const now = new Date("2026-08-11T10:00:15.000Z");
  const attempts = await Promise.allSettled(
    Array.from({ length: 20 }, () => consumeFixedWindows(store, [policy], now)),
  );
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 5);
  const rejected = attempts.filter(
    (item): item is PromiseRejectedResult => item.status === "rejected",
  );
  assert.equal(rejected.length, 15);
  assert.ok(
    rejected.every(
      ({ reason }) =>
        reason instanceof HttpError && reason.code === "RATE_LIMITED",
    ),
  );
  const rows = await store.list(TABLES.idempotencyKeys);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sequence, 5);

  await consumeFixedWindows(store, [policy], new Date("2026-08-11T10:01:01.000Z"));
  assert.equal((await store.list(TABLES.idempotencyKeys)).length, 2);
});

test("audit events form a sealed hash chain and reject sensitive metadata", async () => {
  const store = new InMemoryRecordStore();
  const { workspaceId } = await seedWorkspace(store);
  const actor = identity("auditor", "auditor@example.com", "Audit User");
  await store.transaction((transaction) =>
    appendAudit(transaction, actor, workspaceId, {
      action: "workspace.created",
      targetType: "workspace",
      targetId: workspaceId,
      summary: "Workspace created",
      metadata: { region: "fra" },
    }),
  );
  await store.transaction((transaction) =>
    appendAudit(transaction, actor, workspaceId, {
      action: "workspace.updated",
      targetType: "workspace",
      targetId: workspaceId,
      summary: "Workspace updated",
    }),
  );
  const rows = await store.list(TABLES.auditSegments, {
    orderBy: "sequence",
    order: "asc",
  });
  assert.equal(rows.length, 2);
  const first = decodePayload<{ eventHash: string; previousHash: string }>(rows[0], {
    eventHash: "",
    previousHash: "",
  });
  const second = decodePayload<{ eventHash: string; previousHash: string }>(rows[1], {
    eventHash: "",
    previousHash: "",
  });
  assert.equal(first.previousHash, "0".repeat(64));
  assert.equal(second.previousHash, first.eventHash);
  assert.notEqual(second.eventHash, first.eventHash);

  await assert.rejects(
    store.transaction((transaction) =>
      appendAudit(transaction, actor, workspaceId, {
        action: "unsafe",
        targetType: "test",
        summary: "Unsafe metadata",
        metadata: { accessToken: "must-not-enter-audit" },
      }),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "AUDIT_METADATA_SENSITIVE",
  );
  assert.equal((await store.list(TABLES.auditSegments)).length, 2);
});
