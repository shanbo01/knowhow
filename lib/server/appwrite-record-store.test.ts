import assert from "node:assert/strict";
import test from "node:test";
import { AppwriteException, type Models, type TablesDB } from "node-appwrite";
import { AppwriteRecordStore } from "./appwrite-record-store";
import { TABLES } from "./appwrite-resources";
import { RecordConflictError } from "./record-store";

function mockTransaction(id = "tx-123"): Models.Transaction {
  return {
    $id: id,
    $createdAt: new Date().toISOString(),
    $updatedAt: new Date().toISOString(),
    status: "active",
    operations: 0,
    expiresAt: new Date().toISOString(),
  };
}

function mockRow(): Models.Row {
  return {
    $id: "row-123",
    $sequence: "1",
    $databaseId: "db-123",
    $tableId: "table-123",
    $createdAt: new Date().toISOString(),
    $updatedAt: new Date().toISOString(),
    $permissions: [],
  };
}

function createMockTables(overrides: Partial<TablesDB> = {}): TablesDB {
  return {
    createTransaction: async () => mockTransaction(),
    updateTransaction: async () => mockTransaction(),
    deleteTransaction: async () => true,
    getRow: async () => mockRow(),
    listRows: async () => ({ total: 0, rows: [] }),
    createRow: async () => mockRow(),
    updateRow: async () => mockRow(),
    upsertRow: async () => mockRow(),
    deleteRow: async () => true,
    ...overrides,
  } as unknown as TablesDB;
}

test("transaction converts Appwrite 409 conflict error into RecordConflictError and triggers rollback and delete", async () => {
  const updateCalls: Array<{ transactionId: string; commit?: boolean; rollback?: boolean }> = [];
  const deleteCalls: Array<{ transactionId: string }> = [];

  const tables = createMockTables({
    createTransaction: (async () => mockTransaction("tx-conflict")) as unknown as TablesDB["createTransaction"],
    updateTransaction: (async (params: { transactionId: string; commit?: boolean; rollback?: boolean }) => {
      updateCalls.push(params);
      return mockTransaction(params.transactionId);
    }) as unknown as TablesDB["updateTransaction"],
    deleteTransaction: (async (params: { transactionId: string }) => {
      deleteCalls.push(params);
      return true;
    }) as unknown as TablesDB["deleteTransaction"],
  });

  const store = new AppwriteRecordStore(tables);
  const originalError = new AppwriteException("Conflict error", 409);

  await assert.rejects(
    async () => {
      await store.transaction(async () => {
        throw originalError;
      });
    },
    (err: unknown) => {
      assert(err instanceof RecordConflictError, "should throw RecordConflictError");
      assert.strictEqual(err.cause, originalError, "cause should be original AppwriteException");
      return true;
    },
  );

  assert.deepEqual(updateCalls, [{ transactionId: "tx-conflict", rollback: true }]);
  assert.deepEqual(deleteCalls, [{ transactionId: "tx-conflict" }]);
});

test("transaction re-throws non-conflict error after rollback and cleanup", async () => {
  const updateCalls: Array<{ transactionId: string; commit?: boolean; rollback?: boolean }> = [];
  const deleteCalls: Array<{ transactionId: string }> = [];

  const tables = createMockTables({
    createTransaction: (async () => mockTransaction("tx-generic")) as unknown as TablesDB["createTransaction"],
    updateTransaction: (async (params: { transactionId: string; commit?: boolean; rollback?: boolean }) => {
      updateCalls.push(params);
      return mockTransaction(params.transactionId);
    }) as unknown as TablesDB["updateTransaction"],
    deleteTransaction: (async (params: { transactionId: string }) => {
      deleteCalls.push(params);
      return true;
    }) as unknown as TablesDB["deleteTransaction"],
  });

  const store = new AppwriteRecordStore(tables);
  const originalError = new Error("Database connection dropped");

  await assert.rejects(
    async () => {
      await store.transaction(async () => {
        throw originalError;
      });
    },
    (err: unknown) => {
      assert.strictEqual(err, originalError, "should re-throw exact original error");
      return true;
    },
  );

  assert.deepEqual(updateCalls, [{ transactionId: "tx-generic", rollback: true }]);
  assert.deepEqual(deleteCalls, [{ transactionId: "tx-generic" }]);
});

test("transaction catches failures during rollback and delete without masking original error", async () => {
  const tables = createMockTables({
    createTransaction: (async () => mockTransaction("tx-failing-cleanup")) as unknown as TablesDB["createTransaction"],
    updateTransaction: (async (params: { transactionId: string; commit?: boolean; rollback?: boolean }) => {
      if (params.rollback) {
        throw new Error("Rollback network failure");
      }
      return mockTransaction(params.transactionId);
    }) as unknown as TablesDB["updateTransaction"],
    deleteTransaction: (async () => {
      throw new Error("Delete network failure");
    }) as unknown as TablesDB["deleteTransaction"],
  });

  const store = new AppwriteRecordStore(tables);
  const originalError = new AppwriteException("Resource conflict", 409);

  await assert.rejects(
    async () => {
      await store.transaction(async () => {
        throw originalError;
      });
    },
    (err: unknown) => {
      assert(err instanceof RecordConflictError);
      assert.strictEqual(err.cause, originalError);
      return true;
    },
  );
});

test("transaction commits and cleans up on success", async () => {
  const updateCalls: Array<{ transactionId: string; commit?: boolean; rollback?: boolean }> = [];
  const deleteCalls: Array<{ transactionId: string }> = [];

  const tables = createMockTables({
    createTransaction: (async () => mockTransaction("tx-success")) as unknown as TablesDB["createTransaction"],
    updateTransaction: (async (params: { transactionId: string; commit?: boolean; rollback?: boolean }) => {
      updateCalls.push(params);
      return mockTransaction(params.transactionId);
    }) as unknown as TablesDB["updateTransaction"],
    deleteTransaction: (async (params: { transactionId: string }) => {
      deleteCalls.push(params);
      return true;
    }) as unknown as TablesDB["deleteTransaction"],
  });

  const store = new AppwriteRecordStore(tables);
  const result = await store.transaction(async (txStore) => {
    assert(txStore instanceof AppwriteRecordStore);
    return "work-completed";
  });

  assert.strictEqual(result, "work-completed");
  assert.deepEqual(updateCalls, [{ transactionId: "tx-success", commit: true }]);
  assert.deepEqual(deleteCalls, [{ transactionId: "tx-success" }]);
});

test("nested transaction reuses existing store without creating new transaction", async () => {
  let createTxCalled = false;
  const tables = createMockTables({
    createTransaction: (async () => {
      createTxCalled = true;
      return mockTransaction("tx-should-not-be-created");
    }) as unknown as TablesDB["createTransaction"],
  });

  const store = new AppwriteRecordStore(tables, "db-id", "existing-tx-123");
  const result = await store.transaction(async (txStore) => {
    assert.strictEqual(txStore, store);
    return "nested-result";
  });

  assert.strictEqual(result, "nested-result");
  assert.strictEqual(createTxCalled, false);
});

test("get returns null on Appwrite 404 error and re-throws other errors", async () => {
  const tables404 = createMockTables({
    getRow: (async () => {
      throw new AppwriteException("Document not found", 404);
    }) as unknown as TablesDB["getRow"],
  });

  const store404 = new AppwriteRecordStore(tables404);
  const record = await store404.get(TABLES.workspaces, "non-existent");
  assert.strictEqual(record, null);

  const error500 = new AppwriteException("Internal Server Error", 500);
  const tables500 = createMockTables({
    getRow: (async () => {
      throw error500;
    }) as unknown as TablesDB["getRow"],
  });

  const store500 = new AppwriteRecordStore(tables500);
  await assert.rejects(
    async () => store500.get(TABLES.workspaces, "item-id"),
    (err: unknown) => err === error500,
  );
});
