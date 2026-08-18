import type { TableName } from "./appwrite-resources";

export type RecordValue = string | number | boolean | null | string[] | number[];
export type RecordData = Record<string, RecordValue>;

export type StoredRecord<T extends RecordData = RecordData> = T & {
  $id: string;
  $createdAt: string;
  $updatedAt: string;
};

export type RecordFilter = {
  field: string;
  value: Exclude<RecordValue, null | string[] | number[]>;
};

export type ListRecordsOptions = {
  filters?: readonly RecordFilter[];
  limit?: number;
  orderBy?: string;
  order?: "asc" | "desc";
  cursor?: string;
};

export class RecordConflictError extends Error {
  constructor(
    message = "The record changed during this operation.",
    options: { cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "RecordConflictError";
  }
}

export interface RecordStore {
  get<T extends RecordData>(table: TableName, id: string): Promise<StoredRecord<T> | null>;
  list<T extends RecordData>(
    table: TableName,
    options?: ListRecordsOptions,
  ): Promise<Array<StoredRecord<T>>>;
  create<T extends RecordData>(
    table: TableName,
    id: string,
    data: T,
  ): Promise<StoredRecord<T>>;
  update<T extends RecordData>(
    table: TableName,
    id: string,
    data: Partial<T>,
  ): Promise<StoredRecord<T>>;
  upsert<T extends RecordData>(
    table: TableName,
    id: string,
    data: T,
  ): Promise<StoredRecord<T>>;
  delete(table: TableName, id: string): Promise<void>;
  transaction<T>(work: (transaction: RecordStore) => Promise<T>): Promise<T>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function matches(record: RecordData, filters: readonly RecordFilter[] = []) {
  return filters.every(({ field, value }) => record[field] === value);
}

export class InMemoryRecordStore implements RecordStore {
  private tables = new Map<TableName, Map<string, StoredRecord>>();
  private queue: Promise<unknown> = Promise.resolve();

  private table(name: TableName) {
    let table = this.tables.get(name);
    if (!table) {
      table = new Map();
      this.tables.set(name, table);
    }
    return table;
  }

  async get<T extends RecordData>(table: TableName, id: string) {
    const record = this.table(table).get(id);
    return record ? (clone(record) as StoredRecord<T>) : null;
  }

  async list<T extends RecordData>(table: TableName, options: ListRecordsOptions = {}) {
    const orderBy = options.orderBy ?? "$createdAt";
    const direction = options.order === "desc" ? -1 : 1;
    const records = [...this.table(table).values()]
      .filter((record) => matches(record, options.filters))
      .sort((left, right) =>
        String(left[orderBy]).localeCompare(String(right[orderBy])) * direction,
      );
    const start = options.cursor
      ? records.findIndex((record) => record.$id === options.cursor) + 1
      : 0;
    const from = start > 0 ? start : options.cursor ? records.length : 0;
    return clone(records.slice(from, from + (options.limit ?? 5_000))) as Array<
      StoredRecord<T>
    >;
  }

  async create<T extends RecordData>(table: TableName, id: string, data: T) {
    const records = this.table(table);
    if (records.has(id)) throw new Error(`Record ${table}/${id} already exists.`);
    const now = new Date().toISOString();
    const record = { ...clone(data), $id: id, $createdAt: now, $updatedAt: now };
    records.set(id, record);
    return clone(record) as StoredRecord<T>;
  }

  async update<T extends RecordData>(table: TableName, id: string, data: Partial<T>) {
    const records = this.table(table);
    const current = records.get(id);
    if (!current) throw new Error(`Record ${table}/${id} does not exist.`);
    const record = {
      ...current,
      ...clone(data),
      $updatedAt: new Date().toISOString(),
    } as StoredRecord;
    records.set(id, record);
    return clone(record) as StoredRecord<T>;
  }

  async upsert<T extends RecordData>(
    table: TableName,
    id: string,
    data: T,
  ): Promise<StoredRecord<T>> {
    return this.table(table).has(id)
      ? this.update<T>(table, id, data)
      : this.create<T>(table, id, data);
  }

  async delete(table: TableName, id: string) {
    this.table(table).delete(id);
  }

  async transaction<T>(work: (transaction: RecordStore) => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const snapshot = clone(this.tables);
    try {
      return await work(this);
    } catch (error) {
      this.tables = snapshot;
      throw error;
    } finally {
      release();
    }
  }
}
