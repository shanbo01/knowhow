export type IsoDateString = string;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RecordKind =
  | "client"
  | "runbook"
  | "asset"
  | "vendor"
  | "secret"
  | "run"
  | "audit";

export interface Contact {
  name?: string;
  email?: string;
  phone?: string;
}

export interface Actor {
  userId: string;
  name?: string;
  email?: string;
}

export interface EncryptedSecretEnvelope {
  version: 1;
  algorithm: "AES-GCM";
  keyDerivation: "PBKDF2-SHA-256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface ClientPayload {
  status: "onboarding" | "active" | "paused" | "offboarded";
  primaryContact?: Contact;
  address?: string;
  notes?: string;
  tags?: string[];
}

export interface RunbookStep {
  id: string;
  title: string;
  instructions: string;
  expectedResult?: string;
  warning?: string;
  requiresConfirmation?: boolean;
}

export interface RunbookPayload {
  status: "draft" | "published";
  summary: string;
  category?: string;
  estimatedMinutes?: number;
  version?: number;
  verifiedAt?: IsoDateString;
  reviewDueAt?: IsoDateString;
  steps: RunbookStep[];
  tags?: string[];
}

export interface AssetPayload {
  type: string;
  status: "active" | "spare" | "repair" | "retired";
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  hostname?: string;
  ipAddress?: string;
  assignedTo?: string;
  location?: string;
  warrantyExpiresAt?: IsoDateString;
  notes?: string;
}

export interface VendorPayload {
  status: "active" | "inactive";
  category?: string;
  contact?: Contact;
  supportUrl?: string;
  accountNumber?: string;
  renewalDate?: IsoDateString;
  noticeDays?: number;
  notes?: string;
}

export interface SecretPayload {
  type: "password" | "api-key" | "token" | "license" | "other";
  username?: string;
  url?: string;
  notes?: string;
  value: EncryptedSecretEnvelope;
  lastRotatedAt?: IsoDateString;
  expiresAt?: IsoDateString;
}

export interface RunStepResult {
  stepId: string;
  status: "pending" | "completed" | "skipped" | "failed";
  completedAt?: IsoDateString;
  notes?: string;
}

export interface RunPayload {
  runbookId: string;
  runbookTitle: string;
  runbookVersion?: number;
  status: "in-progress" | "completed" | "cancelled" | "failed";
  startedAt: IsoDateString;
  completedAt?: IsoDateString;
  actor: Actor;
  stepResults: RunStepResult[];
  notes?: string;
}

export interface AuditTarget {
  recordId: string;
  kind: RecordKind;
  title?: string;
}

export interface AuditPayload {
  action: string;
  occurredAt: IsoDateString;
  actor: Actor;
  target: AuditTarget;
  summary: string;
  data?: Record<string, JsonValue>;
}

export interface RecordPayloadByKind {
  client: ClientPayload;
  runbook: RunbookPayload;
  asset: AssetPayload;
  vendor: VendorPayload;
  secret: SecretPayload;
  run: RunPayload;
  audit: AuditPayload;
}

export type RecordPayload<K extends RecordKind = RecordKind> =
  RecordPayloadByKind[K];

const RECORD_KINDS = new Set<RecordKind>([
  "client",
  "runbook",
  "asset",
  "vendor",
  "secret",
  "run",
  "audit",
]);

const CLIENT_STATUSES = new Set<ClientPayload["status"]>([
  "onboarding",
  "active",
  "paused",
  "offboarded",
]);
const RUNBOOK_STATUSES = new Set<RunbookPayload["status"]>([
  "draft",
  "published",
]);
const ASSET_STATUSES = new Set<AssetPayload["status"]>([
  "active",
  "spare",
  "repair",
  "retired",
]);
const VENDOR_STATUSES = new Set<VendorPayload["status"]>([
  "active",
  "inactive",
]);
const SECRET_TYPES = new Set<SecretPayload["type"]>([
  "password",
  "api-key",
  "token",
  "license",
  "other",
]);
const RUN_STATUSES = new Set<RunPayload["status"]>([
  "in-progress",
  "completed",
  "cancelled",
  "failed",
]);
const STEP_STATUSES = new Set<RunStepResult["status"]>([
  "pending",
  "completed",
  "skipped",
  "failed",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isContact(value: unknown): value is Contact {
  return (
    isObject(value) &&
    isOptionalString(value.name) &&
    isOptionalString(value.email) &&
    isOptionalString(value.phone)
  );
}

function isActor(value: unknown): value is Actor {
  return (
    isObject(value) &&
    isString(value.userId) &&
    isOptionalString(value.name) &&
    isOptionalString(value.email)
  );
}

export function isRecordKind(value: unknown): value is RecordKind {
  return isString(value) && RECORD_KINDS.has(value as RecordKind);
}

export function isEncryptedSecretEnvelope(
  value: unknown,
): value is EncryptedSecretEnvelope {
  return (
    isObject(value) &&
    value.version === 1 &&
    value.algorithm === "AES-GCM" &&
    value.keyDerivation === "PBKDF2-SHA-256" &&
    typeof value.iterations === "number" &&
    Number.isSafeInteger(value.iterations) &&
    value.iterations > 0 &&
    isString(value.salt) &&
    isString(value.iv) &&
    isString(value.ciphertext)
  );
}

function isClientPayload(value: unknown): value is ClientPayload {
  return (
    isObject(value) &&
    isString(value.status) &&
    CLIENT_STATUSES.has(value.status as ClientPayload["status"]) &&
    (value.primaryContact === undefined || isContact(value.primaryContact)) &&
    isOptionalString(value.address) &&
    isOptionalString(value.notes) &&
    isOptionalStringArray(value.tags)
  );
}

function isRunbookStep(value: unknown): value is RunbookStep {
  return (
    isObject(value) &&
    isString(value.id) &&
    isString(value.title) &&
    isString(value.instructions) &&
    isOptionalString(value.expectedResult) &&
    isOptionalString(value.warning) &&
    (value.requiresConfirmation === undefined ||
      typeof value.requiresConfirmation === "boolean")
  );
}

function isRunbookPayload(value: unknown): value is RunbookPayload {
  return (
    isObject(value) &&
    isString(value.status) &&
    RUNBOOK_STATUSES.has(value.status as RunbookPayload["status"]) &&
    isString(value.summary) &&
    isOptionalString(value.category) &&
    (value.estimatedMinutes === undefined ||
      (typeof value.estimatedMinutes === "number" &&
        Number.isFinite(value.estimatedMinutes) &&
        value.estimatedMinutes >= 0)) &&
    (value.version === undefined ||
      (typeof value.version === "number" &&
        Number.isSafeInteger(value.version) &&
        value.version > 0)) &&
    isOptionalString(value.verifiedAt) &&
    isOptionalString(value.reviewDueAt) &&
    Array.isArray(value.steps) &&
    value.steps.every(isRunbookStep) &&
    isOptionalStringArray(value.tags)
  );
}

function isAssetPayload(value: unknown): value is AssetPayload {
  return (
    isObject(value) &&
    isString(value.type) &&
    isString(value.status) &&
    ASSET_STATUSES.has(value.status as AssetPayload["status"]) &&
    [
      value.manufacturer,
      value.model,
      value.serialNumber,
      value.hostname,
      value.ipAddress,
      value.assignedTo,
      value.location,
      value.warrantyExpiresAt,
      value.notes,
    ].every(isOptionalString)
  );
}

function isVendorPayload(value: unknown): value is VendorPayload {
  return (
    isObject(value) &&
    isString(value.status) &&
    VENDOR_STATUSES.has(value.status as VendorPayload["status"]) &&
    isOptionalString(value.category) &&
    (value.contact === undefined || isContact(value.contact)) &&
    isOptionalString(value.supportUrl) &&
    isOptionalString(value.accountNumber) &&
    isOptionalString(value.renewalDate) &&
    (value.noticeDays === undefined ||
      (typeof value.noticeDays === "number" &&
        Number.isSafeInteger(value.noticeDays) &&
        value.noticeDays >= 0)) &&
    isOptionalString(value.notes)
  );
}

function isSecretPayload(value: unknown): value is SecretPayload {
  return (
    isObject(value) &&
    isString(value.type) &&
    SECRET_TYPES.has(value.type as SecretPayload["type"]) &&
    isOptionalString(value.username) &&
    isOptionalString(value.url) &&
    isOptionalString(value.notes) &&
    isEncryptedSecretEnvelope(value.value) &&
    isOptionalString(value.lastRotatedAt) &&
    isOptionalString(value.expiresAt)
  );
}

function isRunStepResult(value: unknown): value is RunStepResult {
  return (
    isObject(value) &&
    isString(value.stepId) &&
    isString(value.status) &&
    STEP_STATUSES.has(value.status as RunStepResult["status"]) &&
    isOptionalString(value.completedAt) &&
    isOptionalString(value.notes)
  );
}

function isRunPayload(value: unknown): value is RunPayload {
  return (
    isObject(value) &&
    isString(value.runbookId) &&
    isString(value.runbookTitle) &&
    (value.runbookVersion === undefined ||
      (typeof value.runbookVersion === "number" &&
        Number.isSafeInteger(value.runbookVersion) &&
        value.runbookVersion > 0)) &&
    isString(value.status) &&
    RUN_STATUSES.has(value.status as RunPayload["status"]) &&
    isString(value.startedAt) &&
    isOptionalString(value.completedAt) &&
    isActor(value.actor) &&
    Array.isArray(value.stepResults) &&
    value.stepResults.every(isRunStepResult) &&
    isOptionalString(value.notes)
  );
}

function isAuditTarget(value: unknown): value is AuditTarget {
  return (
    isObject(value) &&
    isString(value.recordId) &&
    isRecordKind(value.kind) &&
    isOptionalString(value.title)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return (
    isObject(value) && Object.values(value).every((item) => isJsonValue(item))
  );
}

function isAuditPayload(value: unknown): value is AuditPayload {
  return (
    isObject(value) &&
    isString(value.action) &&
    isString(value.occurredAt) &&
    isActor(value.actor) &&
    isAuditTarget(value.target) &&
    isString(value.summary) &&
    (value.data === undefined ||
      (isObject(value.data) &&
        Object.values(value.data).every((item) => isJsonValue(item))))
  );
}

export function isRecordPayload<K extends RecordKind>(
  kind: K,
  value: unknown,
): value is RecordPayloadByKind[K] {
  switch (kind) {
    case "client":
      return isClientPayload(value);
    case "runbook":
      return isRunbookPayload(value);
    case "asset":
      return isAssetPayload(value);
    case "vendor":
      return isVendorPayload(value);
    case "secret":
      return isSecretPayload(value);
    case "run":
      return isRunPayload(value);
    case "audit":
      return isAuditPayload(value);
  }
}
