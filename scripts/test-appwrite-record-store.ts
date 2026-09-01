import assert from "node:assert/strict";
import test from "node:test";
import { AppwriteException, type TablesDB } from "node-appwrite";
import { AppwriteRecordStore } from "../lib/server/appwrite-record-store";
import { RecordConflictError } from "../lib/server/record-store";

function createMockTables(overrides: Partial<Record<keyof TablesDB, unknown>> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];

  const mockTables = {
    createTransaction: async (args: unknown) => {
      calls.push({ method: "createTransaction", args: [args] });
      return { $id: "tx-123", ttl: 60 };
    },
    updateTransaction: async (args: unknown) => {
      calls.push({ method: "updateTransaction", args: [args] });
      return {};
    },
    deleteTransaction: async (args: unknown) => {
      calls.push({ method: "deleteTransaction", args: [args] });
      return {};
    },
    ...overrides,
  } as unknown as TablesDB;

  return { mockTables, calls };
}

test("AppwriteRecordStore.transaction commits successfully on happy path", async () => {
  const { mockTables, calls } = createMockTables();
  const store = new AppwriteRecordStore(mockTables, "db-1");

  const result = await store.transaction(async (scopedStore) => {
    assert.ok(scopedStore instanceof AppwriteRecordStore);
    return "success-value";
  });

  assert.equal(result, "success-value");
  assert.deepEqual(calls, [
    { method: "createTransaction", args: [{ ttl: 60 }] },
    {
      method: "updateTransaction",
      args: [{ transactionId: "tx-123", commit: true }],
    },
    { method: "deleteTransaction", args: [{ transactionId: "tx-123" }] },
  ]);
});

test("AppwriteRecordStore.transaction converts 409 conflict AppwriteException into RecordConflictError and rolls back", async () => {
  const { mockTables, calls } = createMockTables();
  const store = new AppwriteRecordStore(mockTables, "db-1");
  const conflictError = new AppwriteException("Conflict error", 409);

  await assert.rejects(
    async () => {
      await store.transaction(async () => {
        throw conflictError;
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof RecordConflictError);
      assert.equal(err.cause, conflictError);
      return true;
    },
  );

  assert.deepEqual(calls, [
    { method: "createTransaction", args: [{ ttl: 60 }] },
    {
      method: "updateTransaction",
      args: [{ transactionId: "tx-123", rollback: true }],
    },
    { method: "deleteTransaction", args: [{ transactionId: "tx-123" }] },
  ]);
});

test("AppwriteRecordStore.transaction rethrows generic errors and rolls back", async () => {
  const { mockTables, calls } = createMockTables();
  const store = new AppwriteRecordStore(mockTables, "db-1");
  const customError = new Error("Something went wrong");

  await assert.rejects(
    async () => {
      await store.transaction(async () => {
        throw customError;
      });
    },
    (err: unknown) => {
      assert.equal(err, customError);
      return true;
    },
  );

  assert.deepEqual(calls, [
    { method: "createTransaction", args: [{ ttl: 60 }] },
    {
      method: "updateTransaction",
      args: [{ transactionId: "tx-123", rollback: true }],
    },
    { method: "deleteTransaction", args: [{ transactionId: "tx-123" }] },
  ]);
});

test("AppwriteRecordStore.transaction rethrows non-409 AppwriteException without wrapping", async () => {
  const { mockTables, calls } = createMockTables();
  const store = new AppwriteRecordStore(mockTables, "db-1");
  const notFoundError = new AppwriteException("Not Found", 404);

  await assert.rejects(
    async () => {
      await store.transaction(async () => {
        throw notFoundError;
      });
    },
    (err: unknown) => {
      assert.equal(err, notFoundError);
      return true;
    },
  );

  assert.deepEqual(calls, [
    { method: "createTransaction", args: [{ ttl: 60 }] },
    {
      method: "updateTransaction",
      args: [{ transactionId: "tx-123", rollback: true }],
    },
    { method: "deleteTransaction", args: [{ transactionId: "tx-123" }] },
  ]);
});

test("AppwriteRecordStore.transaction safely ignores rollback and delete errors when work fails", async () => {
  const { mockTables, calls } = createMockTables({
    updateTransaction: async (args: unknown) => {
      calls.push({ method: "updateTransaction", args: [args] });
      throw new Error("Failed to update transaction");
    },
    deleteTransaction: async (args: unknown) => {
      calls.push({ method: "deleteTransaction", args: [args] });
      throw new Error("Failed to delete transaction");
    },
  });
  const store = new AppwriteRecordStore(mockTables, "db-1");
  const originalError = new Error("Original work error");

  await assert.rejects(
    async () => {
      await store.transaction(async () => {
        throw originalError;
      });
    },
    (err: unknown) => {
      assert.equal(err, originalError);
      return true;
    },
  );

  assert.deepEqual(calls, [
    { method: "createTransaction", args: [{ ttl: 60 }] },
    {
      method: "updateTransaction",
      args: [{ transactionId: "tx-123", rollback: true }],
    },
    { method: "deleteTransaction", args: [{ transactionId: "tx-123" }] },
  ]);
});

test("AppwriteRecordStore.transaction reuses store if already inside a transaction", async () => {
  const { mockTables, calls } = createMockTables();
  const store = new AppwriteRecordStore(mockTables, "db-1", "existing-tx-999");

  const result = await store.transaction(async (scopedStore) => {
    assert.equal(scopedStore, store);
    return "nested-result";
  });

  assert.equal(result, "nested-result");
  // No database transaction calls should be made since transactionId was already present.
  assert.deepEqual(calls, []);
});
