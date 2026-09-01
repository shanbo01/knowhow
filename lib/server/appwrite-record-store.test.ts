import assert from "node:assert/strict";
import test from "node:test";
import { AppwriteException, type TablesDB } from "node-appwrite";
import { AppwriteRecordStore } from "./appwrite-record-store";
import { RecordConflictError } from "./record-store";
import type { TableName } from "./appwrite-resources";

function createMockTablesDB(overrides: Partial<TablesDB> = {}): TablesDB {
  return {
    getRow: async () => {
      throw new Error("getRow not implemented");
    },
    listRows: async () => {
      throw new Error("listRows not implemented");
    },
    createRow: async () => {
      throw new Error("createRow not implemented");
    },
    updateRow: async () => {
      throw new Error("updateRow not implemented");
    },
    upsertRow: async () => {
      throw new Error("upsertRow not implemented");
    },
    deleteRow: async () => {
      throw new Error("deleteRow not implemented");
    },
    createTransaction: async () => {
      throw new Error("createTransaction not implemented");
    },
    updateTransaction: async () => {
      throw new Error("updateTransaction not implemented");
    },
    deleteTransaction: async () => {
      throw new Error("deleteTransaction not implemented");
    },
    ...overrides,
  } as unknown as TablesDB;
}

test("get returns record on success", async () => {
  const mockRow = { $id: "rec-1", name: "Test Record" };
  const getRowCalls: unknown[] = [];

  const tables = createMockTablesDB({
    getRow: (async (params: unknown) => {
      getRowCalls.push(params);
      return mockRow as never;
    }) as never,
  });

  const store = new AppwriteRecordStore(tables, "test-db");
  const result = await store.get("guides" as TableName, "rec-1");

  assert.deepEqual(result, mockRow);
  assert.equal(getRowCalls.length, 1);
  assert.deepEqual(getRowCalls[0], {
    databaseId: "test-db",
    tableId: "guides",
    rowId: "rec-1",
    transactionId: undefined,
  });
});

test("get returns null when document is not found (404 AppwriteException)", async () => {
  const tables = createMockTablesDB({
    getRow: async () => {
      throw new AppwriteException("Document not found", 404, "document_not_found");
    },
  });

  const store = new AppwriteRecordStore(tables, "test-db");
  const result = await store.get("guides" as TableName, "missing-id");

  assert.equal(result, null);
});

test("get rethrows non-404 AppwriteException", async () => {
  const tables = createMockTablesDB({
    getRow: async () => {
      throw new AppwriteException("Internal Server Error", 500, "general_server_error");
    },
  });

  const store = new AppwriteRecordStore(tables, "test-db");

  await assert.rejects(
    async () => store.get("guides" as TableName, "error-id"),
    (err: unknown) => {
      return err instanceof AppwriteException && err.code === 500;
    },
  );
});

test("get rethrows generic Error", async () => {
  const tables = createMockTablesDB({
    getRow: async () => {
      throw new Error("Network failure");
    },
  });

  const store = new AppwriteRecordStore(tables, "test-db");

  await assert.rejects(
    async () => store.get("guides" as TableName, "error-id"),
    { name: "Error", message: "Network failure" },
  );
});

test("list retrieves records with default parameters", async () => {
  const mockRows = [{ $id: "row-1" }, { $id: "row-2" }];
  const listRowsCalls: Array<{ databaseId: string; tableId: string }> = [];

  const tables = createMockTablesDB({
    listRows: (async (params: { databaseId: string; tableId: string }) => {
      listRowsCalls.push(params);
      return { total: 2, rows: mockRows } as never;
    }) as never,
  });

  const store = new AppwriteRecordStore(tables, "test-db");
  const results = await store.list("guides" as TableName);

  assert.deepEqual(results, mockRows);
  assert.equal(listRowsCalls.length, 1);
  assert.equal(listRowsCalls[0].databaseId, "test-db");
  assert.equal(listRowsCalls[0].tableId, "guides");
});

test("list paginates through multiple pages until requested limit or end of rows", async () => {
  const listRowsCalls: unknown[] = [];
  const page1Rows = Array.from({ length: 100 }, (_, i) => ({ $id: `row-${i}` }));
  const page2Rows = Array.from({ length: 50 }, (_, i) => ({ $id: `row-${100 + i}` }));

  const tables = createMockTablesDB({
    listRows: (async (params: unknown) => {
      listRowsCalls.push(params);
      if (listRowsCalls.length === 1) {
        return { total: 150, rows: page1Rows } as never;
      }
      return { total: 150, rows: page2Rows } as never;
    }) as never,
  });

  const store = new AppwriteRecordStore(tables, "test-db");
  const results = await store.list("guides" as TableName, { limit: 150 });

  assert.equal(results.length, 150);
  assert.equal(listRowsCalls.length, 2);
});

test("create, update, upsert, and delete operations forward arguments correctly", async () => {
  const calls: Record<string, Array<Record<string, unknown>>> = {
    createRow: [],
    updateRow: [],
    upsertRow: [],
    deleteRow: [],
  };

  const tables = createMockTablesDB({
    createRow: (async (params: { rowId: string; data: unknown; [key: string]: unknown }) => {
      calls.createRow.push(params);
      return { $id: params.rowId, ...(params.data as object) } as never;
    }) as never,
    updateRow: (async (params: { rowId: string; data: unknown; [key: string]: unknown }) => {
      calls.updateRow.push(params);
      return { $id: params.rowId, ...(params.data as object) } as never;
    }) as never,
    upsertRow: (async (params: { rowId: string; data: unknown; [key: string]: unknown }) => {
      calls.upsertRow.push(params);
      return { $id: params.rowId, ...(params.data as object) } as never;
    }) as never,
    deleteRow: (async (params: { rowId: string; [key: string]: unknown }) => {
      calls.deleteRow.push(params);
      return undefined as never;
    }) as never,
  });

  const store = new AppwriteRecordStore(tables, "test-db", "tx-123");

  await store.create("guides" as TableName, "id-1", { title: "Guide 1" });
  await store.update("guides" as TableName, "id-1", { title: "Guide 1 Updated" });
  await store.upsert("guides" as TableName, "id-1", { title: "Guide 1 Upserted" });
  await store.delete("guides" as TableName, "id-1");

  assert.equal(calls.createRow[0].transactionId, "tx-123");
  assert.equal(calls.createRow[0].databaseId, "test-db");
  assert.deepEqual(calls.createRow[0].data, { title: "Guide 1" });

  assert.equal(calls.updateRow[0].transactionId, "tx-123");
  assert.deepEqual(calls.updateRow[0].data, { title: "Guide 1 Updated" });

  assert.equal(calls.upsertRow[0].transactionId, "tx-123");
  assert.deepEqual(calls.upsertRow[0].data, { title: "Guide 1 Upserted" });

  assert.equal(calls.deleteRow[0].transactionId, "tx-123");
  assert.equal(calls.deleteRow[0].rowId, "id-1");
});

test("transaction commits successfully", async () => {
  const transactionEvents: string[] = [];

  const tables = createMockTablesDB({
    createTransaction: (async (params?: { ttl?: number }) => {
      transactionEvents.push(`create:${params?.ttl}`);
      return { $id: "tx-456" } as never;
    }) as never,
    updateTransaction: (async (params: { transactionId: string; commit?: boolean }) => {
      transactionEvents.push(
        `update:${params.transactionId}:${params.commit ? "commit" : "rollback"}`,
      );
      return {} as never;
    }) as never,
    deleteTransaction: (async (params: { transactionId: string }) => {
      transactionEvents.push(`delete:${params.transactionId}`);
      return {} as never;
    }) as never,
  });

  const store = new AppwriteRecordStore(tables, "test-db");
  const result = await store.transaction(async () => {
    transactionEvents.push("work");
    return "success-result";
  });

  assert.equal(result, "success-result");
  assert.deepEqual(transactionEvents, [
    "create:60",
    "work",
    "update:tx-456:commit",
    "delete:tx-456",
  ]);
});

test("transaction reuses current transaction if nested", async () => {
  let createTxCount = 0;
  const tables = createMockTablesDB({
    createTransaction: async () => {
      createTxCount++;
      return { $id: "tx-789" } as never;
    },
  });

  const existingStore = new AppwriteRecordStore(tables, "test-db", "tx-existing");
  const result = await existingStore.transaction(async (txStore) => {
    assert.equal(txStore, existingStore);
    return "nested-result";
  });

  assert.equal(result, "nested-result");
  assert.equal(createTxCount, 0);
});

test("transaction handles rollback and maps 409 conflict to RecordConflictError", async () => {
  const transactionEvents: string[] = [];

  const tables = createMockTablesDB({
    createTransaction: async () => {
      transactionEvents.push("create");
      return { $id: "tx-409" } as never;
    },
    updateTransaction: (async (params: { commit?: boolean }) => {
      transactionEvents.push(`update:${params.commit ? "commit" : "rollback"}`);
      return {} as never;
    }) as never,
    deleteTransaction: async () => {
      transactionEvents.push("delete");
      return {} as never;
    },
  });

  const store = new AppwriteRecordStore(tables, "test-db");

  await assert.rejects(
    async () => {
      await store.transaction(async () => {
        throw new AppwriteException("Conflict", 409, "document_already_exists");
      });
    },
    (err: unknown) => {
      return (
        err instanceof RecordConflictError &&
        err.cause instanceof AppwriteException &&
        err.cause.code === 409
      );
    },
  );

  assert.deepEqual(transactionEvents, ["create", "update:rollback", "delete"]);
});

test("transaction handles rollback and rethrows non-409 error", async () => {
  const transactionEvents: string[] = [];

  const tables = createMockTablesDB({
    createTransaction: async () => {
      transactionEvents.push("create");
      return { $id: "tx-500" } as never;
    },
    updateTransaction: (async (params: { commit?: boolean }) => {
      transactionEvents.push(`update:${params.commit ? "commit" : "rollback"}`);
      return {} as never;
    }) as never,
    deleteTransaction: async () => {
      transactionEvents.push("delete");
      return {} as never;
    },
  });

  const store = new AppwriteRecordStore(tables, "test-db");
  const customError = new Error("Database timeout");

  await assert.rejects(
    async () => {
      await store.transaction(async () => {
        throw customError;
      });
    },
    customError,
  );

  assert.deepEqual(transactionEvents, ["create", "update:rollback", "delete"]);
});

test("transaction swallows error when rollback or delete fails", async () => {
  const tables = createMockTablesDB({
    createTransaction: async () => {
      return { $id: "tx-cleanup-fail" } as never;
    },
    updateTransaction: async () => {
      throw new Error("Rollback failed");
    },
    deleteTransaction: async () => {
      throw new Error("Delete transaction failed");
    },
  });

  const store = new AppwriteRecordStore(tables, "test-db");
  const originalError = new Error("Original work failure");

  await assert.rejects(
    async () => {
      await store.transaction(async () => {
        throw originalError;
      });
    },
    originalError,
  );
});
