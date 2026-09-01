import assert from "node:assert/strict";
import test from "node:test";
import { AppwriteException, type Models, type TablesDB } from "node-appwrite";
import { AppwriteRecordStore } from "./appwrite-record-store";
import { RecordConflictError } from "./record-store";

function createMockTablesDB(overrides: Partial<TablesDB> = {}): TablesDB {
  return {
    getRow: async () => ({ $id: "1", $createdAt: "", $updatedAt: "" }) as unknown as Models.Row,
    listRows: async () => ({ total: 0, rows: [] }) as unknown as Models.RowList,
    createRow: async () => ({ $id: "1", $createdAt: "", $updatedAt: "" }) as unknown as Models.Row,
    updateRow: async () => ({ $id: "1", $createdAt: "", $updatedAt: "" }) as unknown as Models.Row,
    upsertRow: async () => ({ $id: "1", $createdAt: "", $updatedAt: "" }) as unknown as Models.Row,
    deleteRow: async () => ({}),
    createTransaction: async () => ({ $id: "tx-123" }) as unknown as Models.Transaction,
    updateTransaction: async () => ({ $id: "tx-123" }) as unknown as Models.Transaction,
    deleteTransaction: async () => ({}),
    ...overrides,
  } as unknown as TablesDB;
}

test("AppwriteRecordStore.transaction executes work and commits transaction when successful", async () => {
  const calls: string[] = [];
  const mockTables = createMockTablesDB({
    createTransaction: async (args) => {
      const ttl = typeof args === "object" && args !== null && "ttl" in args ? args.ttl : undefined;
      calls.push(`createTransaction ttl=${ttl}`);
      return { $id: "tx-100" } as unknown as Models.Transaction;
    },
    updateTransaction: async (args) => {
      const tx = typeof args === "object" && args !== null && "transactionId" in args ? args.transactionId : undefined;
      const commit = typeof args === "object" && args !== null && "commit" in args ? args.commit : undefined;
      calls.push(`updateTransaction tx=${tx} commit=${commit}`);
      return { $id: String(tx) } as unknown as Models.Transaction;
    },
    deleteTransaction: async (args) => {
      const tx = typeof args === "object" && args !== null && "transactionId" in args ? args.transactionId : undefined;
      calls.push(`deleteTransaction tx=${tx}`);
      return {} as unknown as Record<string, never>;
    },
  });

  const store = new AppwriteRecordStore(mockTables, "db-test");
  const result = await store.transaction(async () => {
    calls.push("inside work");
    return "success-val";
  });

  assert.equal(result, "success-val");
  assert.deepEqual(calls, [
    "createTransaction ttl=60",
    "inside work",
    "updateTransaction tx=tx-100 commit=true",
    "deleteTransaction tx=tx-100",
  ]);
});

test("AppwriteRecordStore.transaction reuses store if already inside a transaction", async () => {
  const calls: string[] = [];
  const mockTables = createMockTablesDB({
    createTransaction: async () => {
      calls.push("createTransaction");
      return { $id: "tx-100" } as unknown as Models.Transaction;
    },
  });

  const outerStore = new AppwriteRecordStore(mockTables, "db-test");
  await outerStore.transaction(async (innerStore) => {
    calls.push("outer work");
    const innerResult = await innerStore.transaction(async (nestedStore) => {
      calls.push("nested work");
      assert.strictEqual(nestedStore, innerStore);
      return "nested-ok";
    });
    assert.equal(innerResult, "nested-ok");
    return "outer-ok";
  });

  assert.equal(calls.filter((c) => c === "createTransaction").length, 1);
  assert.ok(calls.includes("nested work"));
});

test("AppwriteRecordStore.transaction rolls back and throws RecordConflictError on 409 conflict", async () => {
  const calls: string[] = [];
  const mockTables = createMockTablesDB({
    createTransaction: async () => ({ $id: "tx-409" }) as unknown as Models.Transaction,
    updateTransaction: async (args) => {
      const tx = typeof args === "object" && args !== null && "transactionId" in args ? args.transactionId : undefined;
      const rollback = typeof args === "object" && args !== null && "rollback" in args ? args.rollback : undefined;
      calls.push(`updateTransaction rollback=${rollback}`);
      return { $id: String(tx) } as unknown as Models.Transaction;
    },
    deleteTransaction: async (args) => {
      const tx = typeof args === "object" && args !== null && "transactionId" in args ? args.transactionId : undefined;
      calls.push(`deleteTransaction tx=${tx}`);
      return {} as unknown as Record<string, never>;
    },
  });

  const store = new AppwriteRecordStore(mockTables, "db-test");
  const conflictError = new AppwriteException("Conflict error", 409);

  await assert.rejects(
    async () => {
      await store.transaction(async () => {
        throw conflictError;
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof RecordConflictError);
      assert.strictEqual((err as RecordConflictError).cause, conflictError);
      return true;
    },
  );

  assert.deepEqual(calls, [
    "updateTransaction rollback=true",
    "deleteTransaction tx=tx-409",
  ]);
});

test("AppwriteRecordStore.transaction rolls back and rethrows generic error", async () => {
  const calls: string[] = [];
  const mockTables = createMockTablesDB({
    createTransaction: async () => ({ $id: "tx-err" }) as unknown as Models.Transaction,
    updateTransaction: async (args) => {
      const tx = typeof args === "object" && args !== null && "transactionId" in args ? args.transactionId : undefined;
      const rollback = typeof args === "object" && args !== null && "rollback" in args ? args.rollback : undefined;
      calls.push(`updateTransaction rollback=${rollback}`);
      return { $id: String(tx) } as unknown as Models.Transaction;
    },
    deleteTransaction: async (args) => {
      const tx = typeof args === "object" && args !== null && "transactionId" in args ? args.transactionId : undefined;
      calls.push(`deleteTransaction tx=${tx}`);
      return {} as unknown as Record<string, never>;
    },
  });

  const store = new AppwriteRecordStore(mockTables, "db-test");
  const customError = new Error("Something went wrong");

  await assert.rejects(
    async () => {
      await store.transaction(async () => {
        throw customError;
      });
    },
    (err: unknown) => {
      assert.strictEqual(err, customError);
      return true;
    },
  );

  assert.deepEqual(calls, [
    "updateTransaction rollback=true",
    "deleteTransaction tx=tx-err",
  ]);
});

test("AppwriteRecordStore.transaction handles rollback/delete transaction failures gracefully during error cleanup", async () => {
  const mockTables = createMockTablesDB({
    createTransaction: async () => ({ $id: "tx-fail-cleanup" }) as unknown as Models.Transaction,
    updateTransaction: async () => {
      throw new Error("Failed to rollback transaction");
    },
    deleteTransaction: async () => {
      throw new Error("Failed to delete transaction");
    },
  });

  const store = new AppwriteRecordStore(mockTables, "db-test");
  const originalError = new Error("Original work error");

  await assert.rejects(
    async () => {
      await store.transaction(async () => {
        throw originalError;
      });
    },
    (err: unknown) => {
      assert.strictEqual(err, originalError);
      return true;
    },
  );
});

test("AppwriteRecordStore CRUD operations pass transactionId and parameters correctly", async () => {
  type RowArgs = { databaseId?: string; tableId?: string; rowId?: string; data?: unknown; transactionId?: string };
  let lastGetRowArgs: RowArgs | undefined;
  let lastListRowsArgs: RowArgs | undefined;
  let lastCreateRowArgs: RowArgs | undefined;
  let lastUpdateRowArgs: RowArgs | undefined;
  let lastUpsertRowArgs: RowArgs | undefined;
  let lastDeleteRowArgs: RowArgs | undefined;

  const mockTables = createMockTablesDB({
    getRow: async (args) => {
      lastGetRowArgs = args as RowArgs;
      return { $id: (args as RowArgs).rowId ?? "", name: "item1" } as unknown as Models.Row;
    },
    listRows: async (args) => {
      lastListRowsArgs = args as RowArgs;
      return { total: 1, rows: [{ $id: "r1", name: "item1" }] } as unknown as Models.RowList;
    },
    createRow: async (args) => {
      lastCreateRowArgs = args as RowArgs;
      const data = (args as RowArgs).data as Record<string, unknown> | undefined;
      return { $id: (args as RowArgs).rowId ?? "", ...data } as unknown as Models.Row;
    },
    updateRow: async (args) => {
      lastUpdateRowArgs = args as RowArgs;
      const data = (args as RowArgs).data as Record<string, unknown> | undefined;
      return { $id: (args as RowArgs).rowId ?? "", ...data } as unknown as Models.Row;
    },
    upsertRow: async (args) => {
      lastUpsertRowArgs = args as RowArgs;
      const data = (args as RowArgs).data as Record<string, unknown> | undefined;
      return { $id: (args as RowArgs).rowId ?? "", ...data } as unknown as Models.Row;
    },
    deleteRow: async (args) => {
      lastDeleteRowArgs = args as RowArgs;
      return {} as unknown as Record<string, never>;
    },
  });

  const store = new AppwriteRecordStore(mockTables, "db-test", "tx-test");

  // get
  const record = await store.get("workspaces", "id-1");
  assert.equal(record?.$id, "id-1");
  assert.equal(lastGetRowArgs?.databaseId, "db-test");
  assert.equal(lastGetRowArgs?.tableId, "workspaces");
  assert.equal(lastGetRowArgs?.rowId, "id-1");
  assert.equal(lastGetRowArgs?.transactionId, "tx-test");

  // get 404
  const mockTables404 = createMockTablesDB({
    getRow: async () => {
      throw new AppwriteException("Not found", 404);
    },
  });
  const store404 = new AppwriteRecordStore(mockTables404, "db-test");
  const nullRecord = await store404.get("workspaces", "missing-id");
  assert.strictEqual(nullRecord, null);

  // list
  const items = await store.list("workspaces", { limit: 10, order: "desc" });
  assert.equal(items.length, 1);
  assert.equal(lastListRowsArgs?.databaseId, "db-test");
  assert.equal(lastListRowsArgs?.transactionId, "tx-test");

  // create
  await store.create("workspaces", "id-2", { name: "test-ws" });
  assert.equal(lastCreateRowArgs?.rowId, "id-2");
  assert.deepEqual(lastCreateRowArgs?.data, { name: "test-ws" });
  assert.equal(lastCreateRowArgs?.transactionId, "tx-test");

  // update
  await store.update("workspaces", "id-2", { name: "updated" });
  assert.equal(lastUpdateRowArgs?.rowId, "id-2");
  assert.deepEqual(lastUpdateRowArgs?.data, { name: "updated" });
  assert.equal(lastUpdateRowArgs?.transactionId, "tx-test");

  // upsert
  await store.upsert("workspaces", "id-2", { name: "upserted" });
  assert.equal(lastUpsertRowArgs?.rowId, "id-2");
  assert.deepEqual(lastUpsertRowArgs?.data, { name: "upserted" });
  assert.equal(lastUpsertRowArgs?.transactionId, "tx-test");

  // delete
  await store.delete("workspaces", "id-2");
  assert.equal(lastDeleteRowArgs?.rowId, "id-2");
  assert.equal(lastDeleteRowArgs?.transactionId, "tx-test");
});
