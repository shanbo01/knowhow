import "server-only";

import { AppwriteException, Query, type Models, type TablesDB } from "node-appwrite";
import { APPWRITE_RESOURCES, type TableName } from "./appwrite-resources";
import type {
  ListRecordsOptions,
  RecordData,
  RecordStore,
  StoredRecord,
} from "./record-store";
import { RecordConflictError } from "./record-store";

const PAGE_SIZE = 100;
const DEFAULT_LIST_SIZE = 5_000;
const MAX_LIST_SIZE = 50_001;

function notFound(error: unknown) {
  return error instanceof AppwriteException && error.code === 404;
}

function conflict(error: unknown) {
  return error instanceof AppwriteException && error.code === 409;
}

export class AppwriteRecordStore implements RecordStore {
  constructor(
    private readonly tables: TablesDB,
    private readonly databaseId: string = APPWRITE_RESOURCES.database,
    private readonly transactionId?: string,
  ) {}

  async get<T extends RecordData>(table: TableName, id: string) {
    try {
      return (await this.tables.getRow({
        databaseId: this.databaseId,
        tableId: table,
        rowId: id,
        transactionId: this.transactionId,
      })) as unknown as StoredRecord<T>;
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async list<T extends RecordData>(table: TableName, options: ListRecordsOptions = {}) {
    const requestedLimit = Math.min(
      Math.max(options.limit ?? DEFAULT_LIST_SIZE, 1),
      MAX_LIST_SIZE,
    );
    const result: Array<StoredRecord<T>> = [];
    let cursor: string | undefined;

    while (result.length < requestedLimit) {
      const pageLimit = Math.min(PAGE_SIZE, requestedLimit - result.length);
      const queries = [
        ...(options.filters ?? []).map(({ field, value }) => Query.equal(field, [value])),
        options.order === "desc"
          ? Query.orderDesc(options.orderBy ?? "$createdAt")
          : Query.orderAsc(options.orderBy ?? "$createdAt"),
        Query.limit(pageLimit),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ];
      const page = await this.tables.listRows({
        databaseId: this.databaseId,
        tableId: table,
        queries,
        transactionId: this.transactionId,
        total: false,
      });
      const rows = page.rows as unknown as Array<Models.Row & T>;
      result.push(...(rows as Array<StoredRecord<T>>));
      if (rows.length < pageLimit) break;
      cursor = rows.at(-1)?.$id;
      if (!cursor) break;
    }
    return result;
  }

  async create<T extends RecordData>(table: TableName, id: string, data: T) {
    return (await this.tables.createRow({
      databaseId: this.databaseId,
      tableId: table,
      rowId: id,
      data,
      permissions: [],
      transactionId: this.transactionId,
    })) as unknown as StoredRecord<T>;
  }

  async update<T extends RecordData>(table: TableName, id: string, data: Partial<T>) {
    return (await this.tables.updateRow({
      databaseId: this.databaseId,
      tableId: table,
      rowId: id,
      data,
      permissions: [],
      transactionId: this.transactionId,
    })) as unknown as StoredRecord<T>;
  }

  async upsert<T extends RecordData>(table: TableName, id: string, data: T) {
    return (await this.tables.upsertRow({
      databaseId: this.databaseId,
      tableId: table,
      rowId: id,
      data,
      permissions: [],
      transactionId: this.transactionId,
    })) as unknown as StoredRecord<T>;
  }

  async delete(table: TableName, id: string) {
    await this.tables.deleteRow({
      databaseId: this.databaseId,
      tableId: table,
      rowId: id,
      transactionId: this.transactionId,
    });
  }

  async transaction<T>(work: (transaction: RecordStore) => Promise<T>): Promise<T> {
    if (this.transactionId) return work(this);
    const transaction = await this.tables.createTransaction({ ttl: 60 });
    const scoped = new AppwriteRecordStore(this.tables, this.databaseId, transaction.$id);
    try {
      const value = await work(scoped);
      await this.tables.updateTransaction({ transactionId: transaction.$id, commit: true });
      return value;
    } catch (error) {
      await this.tables
        .updateTransaction({ transactionId: transaction.$id, rollback: true })
        .catch(() => undefined);
      if (conflict(error)) {
        throw new RecordConflictError(undefined, { cause: error });
      }
      throw error;
    } finally {
      await this.tables
        .deleteTransaction({ transactionId: transaction.$id })
        .catch(() => undefined);
    }
  }
}
