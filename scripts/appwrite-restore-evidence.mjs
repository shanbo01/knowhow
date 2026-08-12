import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppwriteException,
  Backups,
  Client,
  Query,
  TablesDB,
} from "node-appwrite";
import { exactControlledAppwriteEndpoint } from "./controlled-appwrite-endpoint.mjs";

const EVIDENCE_VERSION = 1;
const PAGE_SIZE = 100;
const MAX_TABLE_ROWS = 250_000;
const GENESIS_AUDIT_HASH = "0".repeat(64);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BACKUP_SERVICES = new Set(["databases", "tablesdb"]);
const COLUMN_FIELDS = [
  "key",
  "type",
  "required",
  "array",
  "size",
  "min",
  "max",
  "default",
];

export class RestoreEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RestoreEvidenceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RestoreEvidenceError(code, message);
}

function requireCondition(condition, code, message) {
  if (!condition) fail(code, message);
}

export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    requireCondition(Number.isFinite(value), "EVIDENCE_VALUE_INVALID", "Evidence contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(([key, item]) => {
        requireCondition(
          item !== undefined,
          "EVIDENCE_VALUE_INVALID",
          "Evidence contains an undefined value.",
        );
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(",")}}`;
  }
  fail("EVIDENCE_VALUE_INVALID", "Evidence contains an unsupported value.");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function projectFingerprint(projectId) {
  return sha256(`knowhow-appwrite-project:${projectId}`);
}

function normalizedRow(row) {
  const output = {};
  for (const [key, value] of Object.entries(row)) {
    if (key !== "$databaseId") output[key] = value;
  }
  return output;
}

function framedHashUpdate(hash, value) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  hash.update(`${bytes.byteLength}:`);
  hash.update(bytes);
  hash.update("\n");
}

function validIso(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function requiredIso(value, label) {
  requireCondition(validIso(value), "TIMESTAMP_INVALID", `${label} must be an ISO 8601 UTC timestamp.`);
  return value;
}

export function summarizeRows(rows) {
  const sorted = [...rows].sort((left, right) =>
    String(left.$id) < String(right.$id)
      ? -1
      : String(left.$id) > String(right.$id)
        ? 1
        : 0,
  );
  const hash = createHash("sha256");
  let previousId = null;
  let newestUpdatedAt = null;
  for (const row of sorted) {
    requireCondition(
      typeof row?.$id === "string" && row.$id.length > 0,
      "ROW_ID_INVALID",
      "A database row is missing its Appwrite ID.",
    );
    requireCondition(row.$id !== previousId, "ROW_ID_DUPLICATE", "A table returned a duplicate row ID.");
    previousId = row.$id;
    framedHashUpdate(hash, normalizedRow(row));
    if (
      validIso(row.$updatedAt) &&
      (!newestUpdatedAt || Date.parse(row.$updatedAt) > Date.parse(newestUpdatedAt))
    ) {
      newestUpdatedAt = row.$updatedAt;
    }
  }
  return {
    rowCount: sorted.length,
    rowsSha256: hash.digest("hex"),
    newestUpdatedAt,
  };
}

export async function collectTableEvidence(
  tables,
  {
    databaseId,
    tableId,
    pageSize = PAGE_SIZE,
    maxRows = MAX_TABLE_ROWS,
    retainRows = false,
  },
) {
  requireCondition(Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100, "PAGE_SIZE_INVALID", "The row page size must be between 1 and 100.");
  const rowsForSummary = [];
  const retained = [];
  let cursor;

  while (true) {
    const page = await tables.listRows({
      databaseId,
      tableId,
      queries: [
        Query.orderAsc("$id"),
        Query.limit(pageSize),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ],
      total: false,
      ttl: 0,
    });
    requireCondition(Array.isArray(page?.rows), "ROWS_RESPONSE_INVALID", `${tableId} returned an invalid row page.`);
    requireCondition(page.rows.length <= pageSize, "ROWS_RESPONSE_INVALID", `${tableId} exceeded the requested row page size.`);
    rowsForSummary.push(...page.rows);
    if (retainRows) retained.push(...page.rows);
    requireCondition(rowsForSummary.length <= maxRows, "TABLE_ROW_LIMIT", `${tableId} exceeds the verifier's ${maxRows}-row safety limit.`);

    if (page.rows.length < pageSize) break;
    const nextCursor = page.rows.at(-1)?.$id;
    requireCondition(
      typeof nextCursor === "string" && nextCursor.length > 0 && nextCursor !== cursor,
      "ROW_CURSOR_INVALID",
      `${tableId} did not advance its pagination cursor.`,
    );
    cursor = nextCursor;
  }

  return {
    tableId,
    ...summarizeRows(rowsForSummary),
    ...(retainRows ? { rows: retained } : {}),
  };
}

function comparableColumn(column) {
  const output = {};
  for (const field of COLUMN_FIELDS) {
    if (Object.hasOwn(column, field)) output[field] = column[field];
  }
  return output;
}

function comparableIndex(index) {
  return {
    key: index.key,
    type: index.type,
    columns: index.columns,
  };
}

function comparableTable(table) {
  return {
    $id: table.$id,
    $permissions: table.$permissions,
    enabled: table.enabled,
    rowSecurity: table.rowSecurity,
    columns: [...table.columns]
      .map(comparableColumn)
      .sort((left, right) => left.key.localeCompare(right.key)),
    indexes: [...table.indexes]
      .map(comparableIndex)
      .sort((left, right) => left.key.localeCompare(right.key)),
  };
}

export async function validateSchema(tables, databaseId, expectedTables) {
  await tables.get({ databaseId });
  const listed = await tables.listTables({
    databaseId,
    queries: [Query.limit(100)],
    total: true,
  });
  const expectedIds = expectedTables.map((table) => table.$id).sort();
  const remoteIds = listed.tables.map((table) => table.$id).sort();
  requireCondition(
    canonicalJson(remoteIds) === canonicalJson(expectedIds) && listed.total === expectedIds.length,
    "RESTORE_SCHEMA_TABLES_DRIFT",
    "The restored database table IDs do not match the checked-in schema.",
  );

  const normalized = [];
  for (const expected of expectedTables) {
    const remote = await tables.getTable({ databaseId, tableId: expected.$id });
    const expectedComparable = comparableTable(expected);
    const remoteComparable = comparableTable(remote);
    requireCondition(
      canonicalJson(remoteComparable) === canonicalJson(expectedComparable),
      "RESTORE_SCHEMA_DEFINITION_DRIFT",
      `${expected.$id} does not match the checked-in private schema.`,
    );
    normalized.push(remoteComparable);
  }
  normalized.sort((left, right) => left.$id.localeCompare(right.$id));
  return {
    tableCount: normalized.length,
    schemaSha256: sha256(canonicalJson(normalized)),
  };
}

function parsedPayload(row, tableId) {
  try {
    const payload = JSON.parse(row.payload_json);
    requireCondition(
      payload && typeof payload === "object" && !Array.isArray(payload),
      "RESTORE_PAYLOAD_INVALID",
      `${tableId} contains a non-object payload.`,
    );
    return payload;
  } catch (error) {
    if (error instanceof RestoreEvidenceError) throw error;
    fail("RESTORE_PAYLOAD_INVALID", `${tableId} contains invalid JSON.`);
  }
}

export function validateAuditState(auditRows, workspaceRows) {
  const workspaceById = new Map(workspaceRows.map((row) => [row.$id, row]));
  const chains = new Map();
  for (const row of auditRows) {
    requireCondition(
      typeof row.workspace_id === "string" && workspaceById.has(row.workspace_id),
      "AUDIT_WORKSPACE_MISSING",
      "An audit segment does not belong to a restored workspace.",
    );
    if (!chains.has(row.workspace_id)) chains.set(row.workspace_id, []);
    chains.get(row.workspace_id).push(row);
  }

  const heads = [];
  for (const [workspaceId, rows] of chains) {
    rows.sort((left, right) => Number(left.sequence) - Number(right.sequence));
    let previousHash = GENESIS_AUDIT_HASH;
    let expectedSequence = 1;
    for (const row of rows) {
      const event = parsedPayload(row, "audit_segments");
      const eventHash = event.eventHash;
      delete event.eventHash;
      requireCondition(
        row.sequence === expectedSequence && event.sequence === expectedSequence,
        "AUDIT_SEQUENCE_INVALID",
        "A restored audit chain has a missing or duplicate sequence.",
      );
      requireCondition(
        event.previousHash === previousHash && SHA256_PATTERN.test(String(eventHash)),
        "AUDIT_CHAIN_INVALID",
        "A restored audit chain has an invalid predecessor or event hash.",
      );
      requireCondition(
        sha256(`${previousHash}.${canonicalJson(event)}`) === eventHash,
        "AUDIT_HASH_INVALID",
        "A restored audit event hash does not match its sealed payload.",
      );
      previousHash = eventHash;
      expectedSequence += 1;
    }

    const workspace = parsedPayload(workspaceById.get(workspaceId), "workspaces");
    requireCondition(
      workspace.auditSequence === expectedSequence - 1 && workspace.auditHash === previousHash,
      "AUDIT_HEAD_INVALID",
      "A workspace audit head does not match its restored audit chain.",
    );
    heads.push({
      workspaceFingerprint: sha256(`knowhow-workspace:${workspaceId}`),
      sequence: expectedSequence - 1,
      eventHash: previousHash,
    });
  }

  for (const row of workspaceRows) {
    if (chains.has(row.$id)) continue;
    const workspace = parsedPayload(row, "workspaces");
    requireCondition(
      Number(workspace.auditSequence ?? 0) === 0 && !workspace.auditHash,
      "AUDIT_HEAD_WITHOUT_CHAIN",
      "A workspace claims an audit head but has no restored audit segments.",
    );
  }

  return heads.sort((left, right) =>
    left.workspaceFingerprint.localeCompare(right.workspaceFingerprint),
  );
}

export async function collectDatabaseEvidence(tables, databaseId, expectedTables, options = {}) {
  const schema = await validateSchema(tables, databaseId, expectedTables);
  const summaries = [];
  let auditRows = [];
  let workspaceRows = [];
  let newestUpdatedAt = null;

  for (const table of expectedTables) {
    const retainRows = table.$id === "audit_segments" || table.$id === "workspaces";
    const summary = await collectTableEvidence(tables, {
      databaseId,
      tableId: table.$id,
      pageSize: options.pageSize,
      maxRows: options.maxRows,
      retainRows,
    });
    if (table.$id === "audit_segments") auditRows = summary.rows;
    if (table.$id === "workspaces") workspaceRows = summary.rows;
    if (summary.newestUpdatedAt && (!newestUpdatedAt || summary.newestUpdatedAt > newestUpdatedAt)) {
      newestUpdatedAt = summary.newestUpdatedAt;
    }
    summaries.push({
      tableId: summary.tableId,
      rowCount: summary.rowCount,
      rowsSha256: summary.rowsSha256,
      newestUpdatedAt: summary.newestUpdatedAt,
    });
  }
  summaries.sort((left, right) => left.tableId.localeCompare(right.tableId));
  const auditHeads = validateAuditState(auditRows, workspaceRows);
  const totalRows = summaries.reduce((total, table) => total + table.rowCount, 0);
  const overallSha256 = sha256(
    canonicalJson({
      schemaSha256: schema.schemaSha256,
      tables: summaries,
      auditHeads,
    }),
  );
  return {
    ...schema,
    totalRows,
    newestUpdatedAt,
    tables: summaries,
    auditHeads,
    overallSha256,
  };
}

function hasDatabaseBackupService(record) {
  return Array.isArray(record.services) && record.services.some((service) => BACKUP_SERVICES.has(service));
}

function targetsDatabase(record, databaseId) {
  return record.resourceId === databaseId;
}

export function validateDailyPolicy(policy, databaseId) {
  requireCondition(policy?.enabled === true, "BACKUP_POLICY_DISABLED", "The Production database backup policy is disabled.");
  requireCondition(hasDatabaseBackupService(policy), "BACKUP_POLICY_SERVICE_INVALID", "The backup policy does not include the database service.");
  requireCondition(targetsDatabase(policy, databaseId), "BACKUP_POLICY_TARGET_INVALID", "The backup policy does not cover the KnowHow database.");
  const cron = String(policy.schedule ?? "").trim().split(/\s+/);
  const cronMinute = Number(cron[0]);
  const cronHour = Number(cron[1]);
  requireCondition(
    policy.schedule === "@daily" ||
      (cron.length === 5 &&
        /^\d{1,2}$/.test(cron[0]) &&
        /^\d{1,2}$/.test(cron[1]) &&
        cronMinute >= 0 &&
        cronMinute <= 59 &&
        cronHour >= 0 &&
        cronHour <= 23 &&
        cron.slice(2).every((field) => field === "*")),
    "BACKUP_POLICY_NOT_DAILY",
    "The Production backup policy is not a once-daily schedule.",
  );
  requireCondition(Number.isInteger(policy.retention) && policy.retention >= 1, "BACKUP_POLICY_RETENTION_INVALID", "The Production backup policy has no positive retention period.");
  return {
    id: policy.$id,
    schedule: policy.schedule,
    retentionDays: policy.retention,
    enabled: true,
  };
}

export function validateCompletedArchive(
  archive,
  databaseId,
  { expectedPolicyId, maximumAgeHours, now = new Date() } = {},
) {
  requireCondition(archive?.status === "completed", "BACKUP_ARCHIVE_INCOMPLETE", "The selected Appwrite backup archive is not complete.");
  requireCondition(hasDatabaseBackupService(archive), "BACKUP_ARCHIVE_SERVICE_INVALID", "The selected archive does not include the database service.");
  requireCondition(targetsDatabase(archive, databaseId), "BACKUP_ARCHIVE_TARGET_INVALID", "The selected archive does not cover the KnowHow database.");
  if (expectedPolicyId) {
    requireCondition(archive.policyId === expectedPolicyId, "BACKUP_ARCHIVE_POLICY_MISMATCH", "The latest policy archive does not belong to the configured daily policy.");
  }
  const createdAt = requiredIso(archive.$createdAt, "Backup archive creation time");
  const completedAt = requiredIso(archive.$updatedAt, "Backup archive completion time");
  const startedAt = requiredIso(archive.startedAt, "Backup archive start time");
  const sizeBytes = Number(archive.size);
  requireCondition(
    Date.parse(createdAt) <= Date.parse(completedAt) &&
      Date.parse(startedAt) <= Date.parse(completedAt),
    "BACKUP_ARCHIVE_TIME_INVALID",
    "The backup archive timestamps are out of order.",
  );
  requireCondition(
    Number.isSafeInteger(sizeBytes) && sizeBytes >= 0,
    "BACKUP_ARCHIVE_SIZE_INVALID",
    "The backup archive size is invalid.",
  );
  if (maximumAgeHours !== undefined) {
    const ageMs = now.getTime() - Date.parse(completedAt);
    requireCondition(ageMs >= -5 * 60_000 && ageMs <= maximumAgeHours * 60 * 60_000, "BACKUP_ARCHIVE_STALE", `The latest successful policy backup is older than ${maximumAgeHours} hours.`);
  }
  return {
    id: archive.$id,
    policyId: archive.policyId || null,
    createdAt,
    startedAt,
    completedAt,
    sizeBytes,
  };
}

function nestedString(value, acceptedKeys, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  for (const [key, item] of Object.entries(value)) {
    if (acceptedKeys.has(key) && typeof item === "string") return item;
  }
  for (const item of Object.values(value)) {
    const match = nestedString(item, acceptedKeys, depth + 1);
    if (match) return match;
  }
  return null;
}

export function validateRestoration(restoration, sourceEvidence, targetDatabaseId) {
  requireCondition(restoration?.status === "completed", "RESTORATION_INCOMPLETE", "The selected Appwrite restoration is not complete.");
  requireCondition(restoration.archiveId === sourceEvidence.backup.archive.id, "RESTORATION_ARCHIVE_MISMATCH", "The restoration does not belong to the captured backup archive.");
  requireCondition(hasDatabaseBackupService(restoration), "RESTORATION_SERVICE_INVALID", "The restoration does not include the database service.");
  let options = {};
  try {
    options = typeof restoration.options === "string" ? JSON.parse(restoration.options) : restoration.options ?? {};
  } catch {
    fail("RESTORATION_OPTIONS_INVALID", "The Appwrite restoration returned invalid destination metadata.");
  }
  const destination =
    restoration.destinationResourceId ??
    nestedString(options, new Set(["destinationResourceId", "newResourceId", "databaseId"]));
  requireCondition(destination === targetDatabaseId, "RESTORATION_DESTINATION_MISMATCH", "The restoration is not bound to the isolated target database.");
  const startedAt = requiredIso(restoration.startedAt, "Restoration start time");
  const completedAt = requiredIso(restoration.$updatedAt, "Restoration completion time");
  requireCondition(
    Date.parse(startedAt) <= Date.parse(completedAt),
    "RESTORATION_TIME_INVALID",
    "The restoration timestamps are out of order.",
  );
  return {
    id: restoration.$id,
    archiveId: restoration.archiveId,
    startedAt,
    completedAt,
  };
}

export function compareDatabaseEvidence(source, restored) {
  const sourceTables = new Map(source.tables.map((table) => [table.tableId, table]));
  const restoredTables = new Map(restored.tables.map((table) => [table.tableId, table]));
  const drifted = [];
  for (const tableId of new Set([...sourceTables.keys(), ...restoredTables.keys()])) {
    if (canonicalJson(sourceTables.get(tableId) ?? null) !== canonicalJson(restoredTables.get(tableId) ?? null)) {
      drifted.push(tableId);
    }
  }
  drifted.sort();
  requireCondition(source.schemaSha256 === restored.schemaSha256, "RESTORE_SCHEMA_DIGEST_MISMATCH", "The restored schema digest differs from the source evidence.");
  requireCondition(drifted.length === 0, "RESTORE_TABLE_DIGEST_MISMATCH", `Restored table evidence differs for: ${drifted.join(", ")}.`);
  requireCondition(canonicalJson(source.auditHeads) === canonicalJson(restored.auditHeads), "RESTORE_AUDIT_HEAD_MISMATCH", "The restored audit-chain heads differ from the source evidence.");
  requireCondition(source.overallSha256 === restored.overallSha256, "RESTORE_OVERALL_DIGEST_MISMATCH", "The restored database fingerprint differs from the source evidence.");
  return {
    tableCount: restored.tableCount,
    totalRows: restored.totalRows,
    auditChainCount: restored.auditHeads.length,
    schemaSha256: restored.schemaSha256,
    overallSha256: restored.overallSha256,
  };
}

export function sealEvidence(payload, key, keyId) {
  requireCondition(Buffer.byteLength(key, "utf8") >= 32, "EVIDENCE_HMAC_KEY_INVALID", "The backup evidence HMAC key must contain at least 32 bytes.");
  requireCondition(ID_PATTERN.test(keyId), "EVIDENCE_HMAC_KEY_ID_INVALID", "The backup evidence HMAC key ID is invalid.");
  const hmac = createHmac("sha256", key).update(canonicalJson(payload)).digest("hex");
  return {
    ...payload,
    seal: {
      algorithm: "HMAC-SHA-256",
      keyId,
      hmac,
    },
  };
}

export function verifyEvidenceSeal(evidence, key, expectedKeyId) {
  requireCondition(Buffer.byteLength(key, "utf8") >= 32, "EVIDENCE_HMAC_KEY_INVALID", "The backup evidence HMAC key must contain at least 32 bytes.");
  requireCondition(evidence?.seal?.algorithm === "HMAC-SHA-256", "EVIDENCE_SEAL_INVALID", "The backup evidence seal is missing or unsupported.");
  if (expectedKeyId !== undefined) {
    requireCondition(
      evidence.seal.keyId === expectedKeyId,
      "EVIDENCE_HMAC_KEY_ID_MISMATCH",
      "The backup evidence was sealed with a different key ID.",
    );
  }
  requireCondition(SHA256_PATTERN.test(String(evidence.seal.hmac)), "EVIDENCE_SEAL_INVALID", "The backup evidence seal is malformed.");
  const payload = { ...evidence };
  delete payload.seal;
  const expected = createHmac("sha256", key).update(canonicalJson(payload)).digest();
  const actual = Buffer.from(evidence.seal.hmac, "hex");
  requireCondition(actual.length === expected.length && timingSafeEqual(actual, expected), "EVIDENCE_SEAL_MISMATCH", "The backup evidence seal does not match its contents.");
  return payload;
}

export function controlledEndpoint(raw) {
  const endpoint = exactControlledAppwriteEndpoint(
    raw,
    process.env.KNOWHOW_APPWRITE_RESIDENCY ?? "",
  );
  requireCondition(
    endpoint,
    "APPWRITE_ENDPOINT_NOT_FRANKFURT",
    "Backup evidence accepts only an exact approved Frankfurt Cloud or region-attested Azure endpoint.",
  );
  return endpoint;
}

export function assertIsolatedTarget(source, targetProjectId, targetDatabaseId) {
  requireCondition(
    projectFingerprint(targetProjectId) !== source.projectFingerprint ||
      targetDatabaseId !== source.databaseId,
    "RESTORE_TARGET_NOT_ISOLATED",
    "The restore verifier refuses to inspect the active source database.",
  );
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) fail("ENVIRONMENT_REQUIRED", `${name} is required.`);
  return value;
}

function requireAttestation(name) {
  requireCondition(process.env[name] === "1", "ATTESTATION_REQUIRED", `${name}=1 is required for this controlled rehearsal.`);
}

function appwriteServices() {
  const endpoint = controlledEndpoint(requiredEnvironment("APPWRITE_ENDPOINT"));
  const projectId = requiredEnvironment("APPWRITE_PROJECT_ID");
  const apiKey = requiredEnvironment("APPWRITE_API_KEY");
  const databaseId = requiredEnvironment("APPWRITE_DATABASE_ID");
  requireCondition(ID_PATTERN.test(projectId), "APPWRITE_PROJECT_ID_INVALID", "APPWRITE_PROJECT_ID is invalid.");
  requireCondition(
    apiKey.length >= 20 && !apiKey.toLowerCase().includes("replace-with-"),
    "APPWRITE_API_KEY_INVALID",
    "APPWRITE_API_KEY is invalid.",
  );
  requireCondition(ID_PATTERN.test(databaseId), "APPWRITE_DATABASE_ID_INVALID", "APPWRITE_DATABASE_ID is invalid.");
  const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
  return {
    endpoint,
    projectId,
    databaseId,
    tables: new TablesDB(client),
    backups: new Backups(client),
  };
}

async function expectedTables() {
  return JSON.parse(
    await readFile(new URL("../infrastructure/appwrite/tables.json", import.meta.url), "utf8"),
  );
}

export function privateEvidencePath(candidate, workspace = process.cwd()) {
  requireCondition(typeof candidate === "string" && candidate.trim().length > 0, "EVIDENCE_PATH_REQUIRED", "A private evidence path is required.");
  const absolute = resolve(candidate);
  const workspacePath = resolve(workspace);
  const relativeToWorkspace = relative(workspacePath, absolute);
  const insideWorkspace =
    relativeToWorkspace === "" ||
    (!relativeToWorkspace.startsWith("..") && !isAbsolute(relativeToWorkspace));
  if (insideWorkspace) {
    const temporaryRoot = resolve(workspacePath, ".tmp");
    const relativeToTemporary = relative(temporaryRoot, absolute);
    requireCondition(
      relativeToTemporary !== "" &&
        !relativeToTemporary.startsWith("..") &&
        !isAbsolute(relativeToTemporary),
      "EVIDENCE_PATH_NOT_PRIVATE",
      "Evidence inside the repository must be written beneath the ignored .tmp directory.",
    );
  }
  return absolute;
}

async function writeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(
        "EVIDENCE_PATH_EXISTS",
        "The evidence path already exists; use a new path instead of overwriting evidence.",
      );
    }
    throw error;
  }
}

function evidenceKey() {
  const key = requiredEnvironment("KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY");
  requireCondition(
    !key.toLowerCase().includes("replace-with-"),
    "EVIDENCE_HMAC_KEY_INVALID",
    "Replace the backup evidence HMAC key placeholder before running the gate.",
  );
  return {
    key,
    keyId: requiredEnvironment("KNOWHOW_BACKUP_EVIDENCE_HMAC_KEY_ID"),
  };
}

async function captureSource() {
  requireCondition(
    ["staging", "production"].includes(requiredEnvironment("KNOWHOW_ENVIRONMENT")),
    "ENVIRONMENT_NOT_CONTROLLED",
    "Backup evidence capture requires staging or production.",
  );
  requireAttestation("KNOWHOW_BACKUP_SOURCE_FROZEN");
  requireAttestation("KNOWHOW_BACKUP_SYNTHETIC_ONLY");
  const outputPath = privateEvidencePath(requiredEnvironment("KNOWHOW_BACKUP_EVIDENCE_PATH"));
  const key = evidenceKey();
  const release = requiredEnvironment("KNOWHOW_RELEASE");
  const services = appwriteServices();
  const policyId = requiredEnvironment("KNOWHOW_BACKUP_POLICY_ID");
  const policyArchiveId = requiredEnvironment("KNOWHOW_BACKUP_POLICY_ARCHIVE_ID");
  const archiveId = requiredEnvironment("KNOWHOW_BACKUP_ARCHIVE_ID");
  const now = new Date();
  const [manifest, policy, policyArchive, archive] = await Promise.all([
    expectedTables(),
    services.backups.getPolicy({ policyId }),
    services.backups.getArchive({ archiveId: policyArchiveId }),
    services.backups.getArchive({ archiveId }),
  ]);
  const dailyPolicy = validateDailyPolicy(policy, services.databaseId);
  const latestPolicyArchive = validateCompletedArchive(policyArchive, services.databaseId, {
    expectedPolicyId: policyId,
    maximumAgeHours: 30,
    now,
  });
  const restoreArchive = validateCompletedArchive(archive, services.databaseId, {
    maximumAgeHours: 30,
    now,
  });
  const database = await collectDatabaseEvidence(
    services.tables,
    services.databaseId,
    manifest,
  );
  const payload = {
    evidenceVersion: EVIDENCE_VERSION,
    kind: "knowhow-backup-source-evidence",
    capturedAt: now.toISOString(),
    release,
    source: {
      endpointOrigin: new URL(services.endpoint).origin,
      projectFingerprint: projectFingerprint(services.projectId),
      databaseId: services.databaseId,
    },
    backup: {
      dailyPolicy,
      latestPolicyArchive,
      archive: restoreArchive,
    },
    database,
    attestations: {
      sourceMutationsFrozen: true,
      syntheticDataOnly: true,
    },
  };
  const sealed = sealEvidence(payload, key.key, key.keyId);
  await writeEvidence(outputPath, sealed);
  return {
    status: "passed",
    kind: payload.kind,
    release: payload.release,
    tableCount: database.tableCount,
    totalRows: database.totalRows,
    auditChainCount: database.auditHeads.length,
    overallSha256: database.overallSha256,
    evidencePath: outputPath,
  };
}

async function verifyRestore() {
  requireCondition(
    ["staging", "production"].includes(requiredEnvironment("KNOWHOW_ENVIRONMENT")),
    "ENVIRONMENT_NOT_CONTROLLED",
    "Restore verification requires staging or production.",
  );
  requireAttestation("KNOWHOW_RESTORE_ISOLATED");
  requireAttestation("KNOWHOW_RESTORE_NOT_REFERENCED");
  requireAttestation("KNOWHOW_RESTORE_SYNTHETIC_ONLY");
  const sourcePath = privateEvidencePath(
    requiredEnvironment("KNOWHOW_BACKUP_EVIDENCE_PATH"),
  );
  const outputPath = privateEvidencePath(requiredEnvironment("KNOWHOW_RESTORE_REPORT_PATH"));
  const sealedSource = JSON.parse(await readFile(sourcePath, "utf8"));
  const key = evidenceKey();
  const sourceEvidence = verifyEvidenceSeal(sealedSource, key.key, key.keyId);
  requireCondition(
    sourceEvidence.evidenceVersion === EVIDENCE_VERSION &&
      sourceEvidence.kind === "knowhow-backup-source-evidence",
    "EVIDENCE_CONTRACT_INVALID",
    "The source evidence file is not a supported KnowHow backup contract.",
  );
  const services = appwriteServices();
  const targetFingerprint = projectFingerprint(services.projectId);
  assertIsolatedTarget(
    sourceEvidence.source,
    services.projectId,
    services.databaseId,
  );
  const restorationId = requiredEnvironment("KNOWHOW_RESTORE_RESTORATION_ID");
  const incidentAt = requiredIso(
    requiredEnvironment("KNOWHOW_RESTORE_INCIDENT_AT"),
    "Incident simulation time",
  );
  const [manifest, restoration] = await Promise.all([
    expectedTables(),
    services.backups.getRestoration({ restorationId }),
  ]);
  const restorationEvidence = validateRestoration(
    restoration,
    sourceEvidence,
    services.databaseId,
  );
  const restoredDatabase = await collectDatabaseEvidence(
    services.tables,
    services.databaseId,
    manifest,
  );
  const database = compareDatabaseEvidence(
    sourceEvidence.database,
    restoredDatabase,
  );
  const verifiedAt = new Date();
  const rpoSeconds = Math.floor(
    (Date.parse(incidentAt) - Date.parse(sourceEvidence.backup.archive.startedAt)) / 1_000,
  );
  const databaseVerificationSeconds = Math.floor(
    (verifiedAt.getTime() - Date.parse(incidentAt)) / 1_000,
  );
  requireCondition(rpoSeconds >= 0 && rpoSeconds <= 24 * 60 * 60, "RESTORE_RPO_MISSED", "The isolated restore exceeds the 24-hour database RPO target.");
  requireCondition(databaseVerificationSeconds >= 0 && databaseVerificationSeconds <= 24 * 60 * 60, "RESTORE_VERIFICATION_TOO_SLOW", "Database integrity verification exceeded one day; application-level RTO evidence remains required.");

  const payload = {
    evidenceVersion: EVIDENCE_VERSION,
    kind: "knowhow-isolated-restore-verification",
    status: "passed",
    verifiedAt: verifiedAt.toISOString(),
    release: sourceEvidence.release,
    source: {
      projectFingerprint: sourceEvidence.source.projectFingerprint,
      databaseId: sourceEvidence.source.databaseId,
      archiveId: sourceEvidence.backup.archive.id,
    },
    target: {
      endpointOrigin: new URL(services.endpoint).origin,
      projectFingerprint: targetFingerprint,
      databaseId: services.databaseId,
      restoration: restorationEvidence,
    },
    database,
    timing: {
      incidentAt,
      recoveryPointAt: sourceEvidence.backup.archive.startedAt,
      rpoSeconds,
      databaseVerificationSeconds,
      applicationRtoStillRequired: true,
    },
    attestations: {
      isolatedTarget: true,
      targetNotReferencedByDeployedRuntime: true,
      syntheticDataOnly: true,
    },
  };
  const sealed = sealEvidence(payload, key.key, key.keyId);
  await writeEvidence(outputPath, sealed);
  return {
    status: "passed",
    kind: payload.kind,
    release: payload.release,
    tableCount: database.tableCount,
    totalRows: database.totalRows,
    auditChainCount: database.auditChainCount,
    overallSha256: database.overallSha256,
    reportPath: outputPath,
    applicationRtoStillRequired: true,
  };
}

function safeFailure(error) {
  if (error instanceof RestoreEvidenceError) {
    return { status: "failed", code: error.code, message: error.message };
  }
  if (error instanceof AppwriteException) {
    return {
      status: "failed",
      code: `APPWRITE_${error.code || "REQUEST_FAILED"}`,
      message: "An Appwrite backup or database request failed.",
    };
  }
  return {
    status: "failed",
    code: "RESTORE_EVIDENCE_FAILED",
    message: "Backup or restore evidence generation failed.",
  };
}

async function main() {
  const command = process.argv[2];
  requireCondition(
    command === "capture" || command === "verify",
    "COMMAND_INVALID",
    "Use `capture` or `verify`.",
  );
  const result = command === "capture" ? await captureSource() : await verifyRestore();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry && entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(safeFailure(error), null, 2)}\n`);
    process.exitCode = 1;
  });
}
