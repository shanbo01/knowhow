import type { Databases, Models } from "appwrite";
import {
  DATABASE_ID,
  databases,
  ID,
  Permission,
  Query,
  RECORDS_COLLECTION_ID,
  Role,
} from "./appwrite";
import {
  isRecordKind,
  isRecordPayload,
  type RecordKind,
  type RecordPayloadByKind,
} from "./domain";

// Appwrite Text columns currently allow 16,383 characters. Keep a safety
// margin for multi-byte JSON and future schema metadata.
export const MAX_PAYLOAD_BYTES = 14_000;
export const MAX_SEARCH_CHARACTERS = 14_000;
const MAX_TITLE_CHARACTERS = 500;
const MAX_SORT_KEY_CHARACTERS = 200;
const PAGE_SIZE = 100;

interface RecordsDocument extends Models.Document {
  teamId: string;
  kind: string;
  clientId?: string | null;
  title: string;
  searchText?: string | null;
  payload: string;
  sortKey?: string | null;
  archived: boolean;
}

export interface KnowHowRecord<K extends RecordKind = RecordKind> {
  id: string;
  $id: string;
  createdAt: string;
  $createdAt: string;
  updatedAt: string;
  $updatedAt: string;
  permissions: string[];
  $permissions: string[];
  teamId: string;
  kind: K;
  clientId?: string;
  title: string;
  searchText?: string;
  payload: RecordPayloadByKind[K];
  sortKey?: string;
  archived: boolean;
}

export type StoredRecord<K extends RecordKind = RecordKind> = KnowHowRecord<K>;

export interface CreateRecordInput<K extends RecordKind> {
  kind: K;
  clientId?: string;
  title: string;
  searchText?: string;
  payload: RecordPayloadByKind[K];
  sortKey?: string;
  archived?: boolean;
}

export interface UpdateRecordInput<K extends RecordKind = RecordKind> {
  clientId?: string | null;
  title?: string;
  searchText?: string | null;
  payload?: RecordPayloadByKind[K];
  sortKey?: string | null;
  archived?: boolean;
}

export type CreateStoredRecordInput<K extends RecordKind> =
  CreateRecordInput<K> & {
    teamId: string;
  };

export interface ListRecordsOptions {
  includeArchived?: boolean;
  kinds?: readonly RecordKind[];
}

export type RecordsErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SETUP_REQUIRED"
  | "INVALID_DATA"
  | "PAYLOAD_TOO_LARGE"
  | "NETWORK"
  | "UNKNOWN";

export class RecordsRepositoryError extends Error {
  readonly code: RecordsErrorCode;
  readonly status?: number;
  readonly appwriteType?: string;
  readonly cause?: unknown;

  constructor(
    code: RecordsErrorCode,
    message: string,
    options: {
      status?: number;
      appwriteType?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "RecordsRepositoryError";
    this.code = code;
    this.status = options.status;
    this.appwriteType = options.appwriteType;
    this.cause = options.cause;
  }
}

interface AppwriteErrorLike {
  code?: number;
  message?: string;
  type?: string;
}

function isAppwriteErrorLike(error: unknown): error is AppwriteErrorLike {
  return (
    typeof error === "object" &&
    error !== null &&
    ("code" in error || "type" in error)
  );
}

export function normalizeRecordsError(error: unknown): RecordsRepositoryError {
  if (error instanceof RecordsRepositoryError) {
    return error;
  }

  if (isAppwriteErrorLike(error)) {
    const status = typeof error.code === "number" ? error.code : undefined;
    const appwriteType =
      typeof error.type === "string" ? error.type : undefined;
    const message =
      typeof error.message === "string" && error.message.trim()
        ? error.message
        : "Appwrite could not complete the records request.";

    if (
      appwriteType?.includes("database_not_found") ||
      appwriteType?.includes("collection_not_found") ||
      appwriteType?.includes("attribute_not_found")
    ) {
      return new RecordsRepositoryError(
        "SETUP_REQUIRED",
        "The KnowHow Appwrite database schema has not been provisioned.",
        { status, appwriteType, cause: error },
      );
    }
    if (status === 401) {
      return new RecordsRepositoryError(
        "UNAUTHENTICATED",
        "Sign in to access this workspace.",
        { status, appwriteType, cause: error },
      );
    }
    if (status === 403) {
      return new RecordsRepositoryError(
        "FORBIDDEN",
        "You do not have permission to change this workspace.",
        { status, appwriteType, cause: error },
      );
    }
    if (status === 404) {
      return new RecordsRepositoryError("NOT_FOUND", "Record not found.", {
        status,
        appwriteType,
        cause: error,
      });
    }
    if (status === 409) {
      return new RecordsRepositoryError(
        "CONFLICT",
        "That record changed or already exists. Refresh and try again.",
        { status, appwriteType, cause: error },
      );
    }
    if (status === 429) {
      return new RecordsRepositoryError(
        "RATE_LIMITED",
        "Too many requests. Wait briefly and try again.",
        { status, appwriteType, cause: error },
      );
    }
    return new RecordsRepositoryError("UNKNOWN", message, {
      status,
      appwriteType,
      cause: error,
    });
  }

  if (error instanceof TypeError) {
    return new RecordsRepositoryError(
      "NETWORK",
      "KnowHow could not reach Appwrite. Check your connection and try again.",
      { cause: error },
    );
  }

  return new RecordsRepositoryError(
    "UNKNOWN",
    "The records request failed unexpectedly.",
    { cause: error },
  );
}

function requireText(
  value: string,
  field: string,
  maxCharacters = MAX_SEARCH_CHARACTERS,
): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new RecordsRepositoryError(
      "INVALID_DATA",
      `${field} cannot be empty.`,
    );
  }
  if (normalized.length > maxCharacters) {
    throw new RecordsRepositoryError(
      "INVALID_DATA",
      `${field} cannot exceed ${maxCharacters.toLocaleString()} characters.`,
    );
  }
  return normalized;
}

function optionalText(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function boundedOptionalText(
  value: string | null | undefined,
  field: string,
  maxCharacters: number,
): string | undefined {
  const normalized = optionalText(value);
  if (normalized && normalized.length > maxCharacters) {
    throw new RecordsRepositoryError(
      "INVALID_DATA",
      `${field} cannot exceed ${maxCharacters.toLocaleString()} characters.`,
    );
  }
  return normalized;
}

function normalizedSearchText(
  value: string | null | undefined,
): string | undefined {
  const normalized = optionalText(value)?.replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, MAX_SEARCH_CHARACTERS).join("");
}

function serializePayload<K extends RecordKind>(
  kind: K,
  payload: RecordPayloadByKind[K],
): string {
  if (!isRecordPayload(kind, payload)) {
    throw new RecordsRepositoryError(
      "INVALID_DATA",
      `The ${kind} payload is invalid.`,
    );
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch (error) {
    throw new RecordsRepositoryError(
      "INVALID_DATA",
      "The record payload is not valid JSON.",
      { cause: error },
    );
  }

  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new RecordsRepositoryError(
      "PAYLOAD_TOO_LARGE",
      `The record payload is ${bytes.toLocaleString()} bytes; the maximum is ${MAX_PAYLOAD_BYTES.toLocaleString()} bytes.`,
    );
  }
  return serialized;
}

function parseDocument(document: RecordsDocument): KnowHowRecord {
  if (
    !isRecordKind(document.kind) ||
    typeof document.teamId !== "string" ||
    typeof document.title !== "string" ||
    typeof document.payload !== "string" ||
    typeof document.archived !== "boolean"
  ) {
    throw new RecordsRepositoryError(
      "INVALID_DATA",
      `Record ${document.$id} has an invalid database shape.`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(document.payload);
  } catch (error) {
    throw new RecordsRepositoryError(
      "INVALID_DATA",
      `Record ${document.$id} contains invalid JSON.`,
      { cause: error },
    );
  }
  if (!isRecordPayload(document.kind, payload)) {
    throw new RecordsRepositoryError(
      "INVALID_DATA",
      `Record ${document.$id} contains an invalid ${document.kind} payload.`,
    );
  }

  return {
    id: document.$id,
    $id: document.$id,
    createdAt: document.$createdAt,
    $createdAt: document.$createdAt,
    updatedAt: document.$updatedAt,
    $updatedAt: document.$updatedAt,
    permissions: document.$permissions,
    $permissions: document.$permissions,
    teamId: document.teamId,
    kind: document.kind,
    clientId: optionalText(document.clientId),
    title: document.title,
    searchText: optionalText(document.searchText),
    payload,
    sortKey: optionalText(document.sortKey),
    archived: document.archived,
  };
}

function permissionsFor(teamId: string, kind: RecordKind): string[] {
  const team = Role.team(teamId);
  if (kind === "audit") {
    return [Permission.read(team)];
  }
  if (kind === "secret") {
    const vault = Role.team(teamId, "vault");
    return [
      Permission.read(vault),
      Permission.update(vault),
      Permission.delete(vault),
    ];
  }
  const editor = Role.team(teamId, "editor");
  return [
    Permission.read(team),
    Permission.update(editor),
    Permission.delete(editor),
  ];
}

export class RecordsRepository {
  constructor(
    private readonly service: Databases = databases,
    private readonly databaseId = DATABASE_ID,
    private readonly collectionId = RECORDS_COLLECTION_ID,
  ) {}

  async list(
    teamId: string,
    options: ListRecordsOptions = {},
  ): Promise<KnowHowRecord[]> {
    const requiredTeamId = requireText(teamId, "Team ID");
    const records: KnowHowRecord[] = [];
    let cursor: string | undefined;

    try {
      while (true) {
        const queries = [
          Query.equal("teamId", requiredTeamId),
          Query.orderAsc("$id"),
          Query.limit(PAGE_SIZE),
        ];
        if (cursor) {
          queries.push(Query.cursorAfter(cursor));
        }

        const page = await this.service.listDocuments<RecordsDocument>({
          databaseId: this.databaseId,
          collectionId: this.collectionId,
          queries,
          total: false,
          ttl: 0,
        });
        for (const document of page.documents) {
          records.push(parseDocument(document));
        }

        if (page.documents.length < PAGE_SIZE) {
          break;
        }
        const nextCursor = page.documents.at(-1)?.$id;
        if (!nextCursor || nextCursor === cursor) {
          throw new RecordsRepositoryError(
            "INVALID_DATA",
            "Appwrite returned an invalid pagination cursor.",
          );
        }
        cursor = nextCursor;
      }

      const allowedKinds = options.kinds
        ? new Set(options.kinds)
        : undefined;
      return records.filter(
        (record) =>
          (options.includeArchived || !record.archived) &&
          (!allowedKinds || allowedKinds.has(record.kind)),
      );
    } catch (error) {
      throw normalizeRecordsError(error);
    }
  }

  async listAccessible(
    options: ListRecordsOptions = {},
  ): Promise<KnowHowRecord[]> {
    const records: KnowHowRecord[] = [];
    let cursor: string | undefined;

    try {
      while (true) {
        const queries = [Query.orderAsc("$id"), Query.limit(PAGE_SIZE)];
        if (cursor) {
          queries.push(Query.cursorAfter(cursor));
        }

        const page = await this.service.listDocuments<RecordsDocument>({
          databaseId: this.databaseId,
          collectionId: this.collectionId,
          queries,
          total: false,
          ttl: 0,
        });
        for (const document of page.documents) {
          records.push(parseDocument(document));
        }

        if (page.documents.length < PAGE_SIZE) {
          break;
        }
        const nextCursor = page.documents.at(-1)?.$id;
        if (!nextCursor || nextCursor === cursor) {
          throw new RecordsRepositoryError(
            "INVALID_DATA",
            "Appwrite returned an invalid pagination cursor.",
          );
        }
        cursor = nextCursor;
      }

      const allowedKinds = options.kinds
        ? new Set(options.kinds)
        : undefined;
      return records.filter(
        (record) =>
          (options.includeArchived || !record.archived) &&
          (!allowedKinds || allowedKinds.has(record.kind)),
      );
    } catch (error) {
      throw normalizeRecordsError(error);
    }
  }

  async getAccessible(recordId: string): Promise<KnowHowRecord> {
    try {
      const document = await this.service.getDocument<RecordsDocument>({
        databaseId: this.databaseId,
        collectionId: this.collectionId,
        documentId: requireText(recordId, "Record ID"),
      });
      return parseDocument(document);
    } catch (error) {
      throw normalizeRecordsError(error);
    }
  }

  async get(teamId: string, recordId: string): Promise<KnowHowRecord> {
    const requiredTeamId = requireText(teamId, "Team ID");
    try {
      const document = await this.service.getDocument<RecordsDocument>({
        databaseId: this.databaseId,
        collectionId: this.collectionId,
        documentId: requireText(recordId, "Record ID"),
      });
      const record = parseDocument(document);
      if (record.teamId !== requiredTeamId) {
        throw new RecordsRepositoryError("NOT_FOUND", "Record not found.");
      }
      return record;
    } catch (error) {
      throw normalizeRecordsError(error);
    }
  }

  async create<K extends RecordKind>(
    teamId: string,
    input: CreateRecordInput<K>,
  ): Promise<KnowHowRecord<K>> {
    const requiredTeamId = requireText(teamId, "Team ID");
    const title = requireText(input.title, "Title", MAX_TITLE_CHARACTERS);
    const payload = serializePayload(input.kind, input.payload);

    try {
      const document = await this.service.createDocument<RecordsDocument>({
        databaseId: this.databaseId,
        collectionId: this.collectionId,
        documentId: ID.unique(),
        data: {
          teamId: requiredTeamId,
          kind: input.kind,
          clientId: boundedOptionalText(input.clientId, "Client ID", 64),
          title,
          searchText: normalizedSearchText(input.searchText),
          payload,
          sortKey: boundedOptionalText(
            input.sortKey,
            "Reference code",
            MAX_SORT_KEY_CHARACTERS,
          ),
          archived: input.archived ?? false,
        },
        permissions: permissionsFor(requiredTeamId, input.kind),
      });
      return parseDocument(document) as KnowHowRecord<K>;
    } catch (error) {
      throw normalizeRecordsError(error);
    }
  }

  async update<K extends RecordKind>(
    teamId: string,
    recordId: string,
    input: UpdateRecordInput<K>,
  ): Promise<KnowHowRecord<K>> {
    const current = await this.get(teamId, recordId);
    if (current.kind === "audit") {
      throw new RecordsRepositoryError(
        "FORBIDDEN",
        "Audit records are immutable.",
      );
    }

    const data: Record<string, unknown> = {};
    if (input.title !== undefined) {
      data.title = requireText(input.title, "Title", MAX_TITLE_CHARACTERS);
    }
    if (input.clientId !== undefined) {
      data.clientId =
        input.clientId === null
          ? null
          : boundedOptionalText(input.clientId, "Client ID", 64);
    }
    if (input.searchText !== undefined) {
      data.searchText =
        input.searchText === null ? null : normalizedSearchText(input.searchText);
    }
    if (input.sortKey !== undefined) {
      data.sortKey =
        input.sortKey === null
          ? null
          : boundedOptionalText(
              input.sortKey,
              "Reference code",
              MAX_SORT_KEY_CHARACTERS,
            );
    }
    if (input.payload !== undefined) {
      data.payload = serializePayload(
        current.kind,
        input.payload as RecordPayloadByKind[typeof current.kind],
      );
    }
    if (input.archived !== undefined) {
      data.archived = input.archived;
    }
    if (Object.keys(data).length === 0) {
      return current as KnowHowRecord<K>;
    }

    try {
      const document = await this.service.updateDocument<RecordsDocument>({
        databaseId: this.databaseId,
        collectionId: this.collectionId,
        documentId: current.id,
        data,
        permissions: permissionsFor(current.teamId, current.kind),
      });
      return parseDocument(document) as KnowHowRecord<K>;
    } catch (error) {
      throw normalizeRecordsError(error);
    }
  }

  async archive(
    teamId: string,
    recordId: string,
    archived = true,
  ): Promise<KnowHowRecord> {
    const current = await this.get(teamId, recordId);
    if (current.kind === "audit") {
      throw new RecordsRepositoryError(
        "FORBIDDEN",
        "Audit records are immutable.",
      );
    }

    try {
      const document = await this.service.updateDocument<RecordsDocument>({
        databaseId: this.databaseId,
        collectionId: this.collectionId,
        documentId: current.id,
        data: { archived },
        permissions: permissionsFor(current.teamId, current.kind),
      });
      return parseDocument(document);
    } catch (error) {
      throw normalizeRecordsError(error);
    }
  }

  async delete(teamId: string, recordId: string): Promise<void> {
    const current = await this.get(teamId, recordId);
    if (current.kind === "audit") {
      throw new RecordsRepositoryError(
        "FORBIDDEN",
        "Audit records are immutable.",
      );
    }

    try {
      await this.service.deleteDocument({
        databaseId: this.databaseId,
        collectionId: this.collectionId,
        documentId: current.id,
      });
    } catch (error) {
      throw normalizeRecordsError(error);
    }
  }
}

export const recordsRepository = new RecordsRepository();

export async function listRecords(
  teamId: string,
  options: ListRecordsOptions = {},
): Promise<StoredRecord[]> {
  return recordsRepository.list(teamId, options);
}

export async function createRecord<K extends RecordKind>(
  input: CreateStoredRecordInput<K>,
): Promise<StoredRecord<K>> {
  const { teamId, ...record } = input;
  return recordsRepository.create(teamId, record);
}

export async function updateRecord<K extends RecordKind = RecordKind>(
  recordId: string,
  input: UpdateRecordInput<K>,
): Promise<StoredRecord<K>> {
  const current = await recordsRepository.getAccessible(recordId);
  return recordsRepository.update(
    current.teamId,
    current.id,
    input,
  );
}

export async function deleteRecord(recordId: string): Promise<void> {
  const current = await recordsRepository.getAccessible(recordId);
  await recordsRepository.delete(current.teamId, current.id);
}

export async function createAuditRecord(
  input: Omit<CreateStoredRecordInput<"audit">, "kind" | "archived">,
): Promise<StoredRecord<"audit">> {
  return createRecord({
    ...input,
    kind: "audit",
    archived: false,
  });
}

export function humanizeAppwriteError(error: unknown): string {
  return normalizeRecordsError(error).message;
}
