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
